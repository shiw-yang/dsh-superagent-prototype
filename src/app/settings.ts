/** Block-scoped settings validation, optimistic concurrency saves, processing pause control, and source policy synchronization. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { UserError, type EngineForSettings } from '../core/index.ts'
import { EvalConfigSchema, ExecutorConfigSchema, PolicyConfigSchema, SettingsSchema, SourceInstanceSchema, TopologySchema, topologyOf, policyEffects, policyVersion } from '../policy.ts'
import type { Settings as SettingsValue, SettingsBlock, SettingsOrigin, SettingsSave } from '../policy.ts'
import type { SourceHost } from '../sources/host.ts'
import type { HealthBoard, HealthEntry } from '../infra/health.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { resolveRoleModel } from './role-models.ts'
import { changedPaths, settingsNotice } from './notices.ts'
import type { Sessions } from './sessions.ts'
import { setupChanged, type Setup } from './setup.ts'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'

/**
 * Indicates an optimistic concurrency conflict when saving or syncing a settings block against a stale revision.
 * Thrown by `Settings.save` and `Settings.sync` and translated into an HTTP 409 response by the management routes.
 */
export class SettingsConflict extends Error {}
const now = (): string => new Date().toISOString()
/** Executor settings that control shell execution paths, prepare commands, and command shims. */
const environment = ({ executor }: SettingsValue) => JSON.stringify([executor.directory, executor.prepare, executor.blockedCommands])

/** Schema parser, settings merger, and non-panel origin guard for one settings block kind. */
interface Block {
  parse(value: unknown, sources: SourceRegistry, id: string): unknown
  merge(settings: SettingsValue, value: unknown, id: string): SettingsValue
  guard?(current: SettingsValue, candidate: SettingsValue, origin: SettingsOrigin): void
}
const BLOCKS: Record<'policy' | 'eval' | 'executor' | 'source' | 'topology', Block> = {
  topology: {
    parse: (value, sources) => {
      const topology = TopologySchema.parse(value)
      for (const [id, source] of Object.entries(topology.sources)) {
        const kind = sources.kind(source.kind ?? id)
        if (!kind) { if (source.enabled) throw new UserError('sourceNotInstalled', { source: id }); continue }
        source.config = kind.schema.parse(source.config)
      }
      return topology
    },
    merge: (settings, value) => {
      const topology = value as ReturnType<typeof topologyOf>
      const profile = topology.sources.github?.repositoryId === 'default' && topology.executorProfiles.default
      const { name: _name, ...executor } = profile || { name: '' }
      return { ...settings, ...topology, ...(profile ? { executor: { ...settings.executor, ...executor, maxWorkers: topology.scheduler.maxWorkers } } : {}) }
    },
    guard: (current, candidate, origin) => { if (origin !== 'panel' && JSON.stringify(topologyOf(current)) !== JSON.stringify(topologyOf(candidate))) throw new UserError('panelOnlyEnvironment') },
  },
  policy: {
    parse: (value, sources) => {
      const policy = PolicyConfigSchema.parse(value)
      return { ...policy, sources: sources.validatePolicy(policy.sources) }
    },
    merge: (settings, value) => ({ ...settings, policy: value as SettingsValue['policy'] }),
  },
  eval: { parse: value => EvalConfigSchema.parse(value), merge: (settings, value) => ({ ...settings, eval: value as SettingsValue['eval'] }) },
  executor: {
    parse: value => ExecutorConfigSchema.parse(value),
    merge: (settings, value) => {
      const executor = value as SettingsValue['executor'], { maxWorkers, ...profile } = executor
      const legacy = settings.sources.github?.repositoryId === 'default' && settings.executorProfiles.default
      return { ...settings, executor, ...(legacy ? { executorProfiles: { ...settings.executorProfiles, default: { ...legacy, ...profile } }, scheduler: { ...settings.scheduler, maxWorkers } } : {}) }
    },
    // Only the management panel may modify shell execution paths or commands.
    guard: (current, candidate, origin) => { if (origin !== 'panel' && environment(current) !== environment(candidate)) throw new UserError('panelOnlyEnvironment') },
  },
  source: {
    parse: (value, sources, id) => { const parsed = SourceInstanceSchema.parse(value); return { ...parsed, ...sources.validate(id, parsed) } },
    merge: (settings, value, id) => {
      const source = { ...settings.sources[id], ...value as SettingsValue['sources'][string] }
      const repository = source.repositoryId && settings.repositories[source.repositoryId]
      if (repository && (source.kind ?? id) === 'github') {
        const access = settings.accessProfiles[repository.accessProfileId]
        // Managed identity lives only in topology; legacy editor submissions cannot create shadow bindings.
        const old = settings.sources[id]?.config
        if ((source.config.repository !== old?.repository && source.config.repository !== repository.fullName)
          || (source.config.cli !== old?.cli && source.config.cli !== access?.cli)) throw new Error('Manage repository and account bindings in topology')
      }
      return { ...settings, sources: { ...settings.sources, [id]: source } }
    },
    // Only the management panel may switch source accounts.
    guard: (current, candidate, origin) => {
      const bindings = (settings: SettingsValue) => JSON.stringify(Object.entries(settings.sources).map(([id, source]) => [id, source.kind, source.repositoryId, source.routing]))
      if (origin !== 'panel' && (setupChanged(current, candidate) || bindings(current) !== bindings(candidate))) throw new UserError('panelOnlyAccounts')
    },
  },
}

/** Host dependencies used by `Settings`. */
export interface SettingsHost {
  readonly store: Pick<Store, 'settings' | 'saveSettings' | 'blockRevision' | 'atomic' | 'tickets' | 'get'>
  readonly sources: SourceRegistry
  /** Notified when a settings save changes the policy version. */
  readonly engine: EngineForSettings
  /** Health board where each source's policy sync reports under `sync:<id>`. */
  readonly health: Pick<HealthBoard, 'claim'>
  /** DSH Cordis context used to validate and resolve role models. */
  readonly context: Context
  readonly lifetime: AbortSignal
  /** Session manager through which the main Session is notified of saved settings. */
  readonly sessions: Pick<Sessions, 'notify' | 'delivery'>
  /** Source host passed to source kinds' policy syncs and label refreshes. */
  readonly sourceHost: SourceHost
  /** Setup state, account/command checks, and restart trigger when setup-read fields change. */
  readonly setup: Pick<Setup, 'configured' | 'checkAccounts' | 'blockCommands' | 'restart'>
  /** Triggers an immediate pass so work newly allowed by a settings save runs right away. */
  requestPass(): void
}

/**
 * Validates and persists block-scoped settings in `Store`, enforces origin guards, and manages source policy synchronization and label refreshes.
 * `Runtime`, management HTTP routes, and main-Session tools read and save settings through it.
 * Notifies `Engine` when the policy version changes, notifies the main Session via `Sessions`, and triggers `Setup` restarts or `Passes` runs when saved settings take effect.
 * Tracks per-source synchronization status in `HealthBoard` and retries failed syncs with exponential backoff.
 */
export class Settings {
  /** Per-source `sync:<id>` health entries, claimed lazily on each source's first policy sync. */
  private readonly syncs = new Map<string, HealthEntry>()
  /** Pending exponential-backoff retry timer and last wait duration (ms) per source after a failed sync. */
  private readonly retries = new Map<string, { timer: ReturnType<typeof setTimeout>; wait: number }>()
  constructor(private readonly host: SettingsHost) {
    host.lifetime.addEventListener('abort', () => { for (const { timer } of this.retries.values()) clearTimeout(timer) }, { once: true })
  }
  /** Schedule exponential backoff retries (1 minute up to 1 hour) after a failed source sync, or clear pending retries on success. */
  private retrySync(id: string, failed: boolean): void {
    const previous = this.retries.get(id)
    if (previous) clearTimeout(previous.timer)
    this.retries.delete(id)
    if (!failed || this.host.lifetime.aborted) return
    const wait = previous ? Math.min(previous.wait * 2, 3_600_000) : 60_000
    const timer = setTimeout(() => { this.sync(id).catch(() => { /* sync() records its failure in health. */ }) }, wait)
    timer.unref?.()
    this.retries.set(id, { timer, wait })
  }
  private syncHealth(id: string): HealthEntry {
    let entry = this.syncs.get(id)
    if (!entry) this.syncs.set(id, entry = this.host.health.claim(`sync:${id}`))
    return entry
  }
  /** Returns the current validated settings from `Store`. */
  current(): SettingsValue { return this.host.store.settings() }
  /**
   * Returns an overview of all settings blocks with their current block revisions: full values for `pause`, `eval`, and
   * `executor`; rule summaries and allowed-sender counts for `policy`; and instance status switches for `sources` (with `read: 'settings/<block>'` paths for full block reads).
   */
  view() {
    const { store, sources } = this.host
    const settings = store.settings(), revision = (block: SettingsSave) => store.blockRevision(block)
    const { rules, sources: parts } = settings.policy
    return { revision: store.get(KV.settings.revision) ?? 0,
      pause: { revision: revision('pause'), value: { paused: settings.paused } },
      eval: { revision: revision('eval'), value: settings.eval },
      executor: { revision: revision('executor'), value: settings.executor },
      topology: { revision: revision('topology'), value: topologyOf(settings) },
      policy: { revision: revision('policy'), rules: rules.map(rule => ({ id: rule.id, name: rule.name, enabled: rule.enabled })),
        allowed: Object.fromEntries(Object.entries(parts).map(([id, part]) => [id, part.allowed.length])), read: 'settings/policy' },
      sources: sources.instances(settings).map(({ id, kind, enabled, installed }) =>
        ({ id, kind, enabled, installed, revision: revision(`source:${id}`), read: `settings/source:${id}` })) }
  }
  /**
   * Returns one settings block as accepted by `save` (`policy`, `eval`, `executor`, `pause` holding `{ paused }`, or
   * `source:<id>` holding `{ enabled, config }`) along with its current block revision.
   * @throws UserError (`unknownBlock`) when no such settings block exists.
   */
  block(block: string): { block: string; revision: number; value: unknown } {
    const { store, sources } = this.host
    const settings = store.settings(), id = block.startsWith('source:') ? block.slice('source:'.length) : undefined
    const instance = id === undefined ? undefined : sources.instances(settings).find(item => item.id === id)
    const value = block === 'topology' ? topologyOf(settings) : block === 'pause' ? { paused: settings.paused } : block === 'policy' || block === 'eval' || block === 'executor' ? settings[block]
      : instance ? { ...settings.sources[id!], enabled: instance.enabled, config: instance.config } : undefined
    if (value === undefined) throw new UserError('unknownBlock', { block })
    return { block, revision: store.blockRevision(block as SettingsSave), value }
  }
  /**
   * Validates and saves one settings block against its `revision`; a no-op save records no new revision, a changed policy
   * version notifies affected open tickets, and changing a setup-read field (`SETUP_FIELDS`, such as an account CLI) or any
   * change saved while waiting for setup (`!this.host.setup.configured()`) restarts `dsh-superagent` so setup runs again.
   * @param origin - Caller origin; restricts execution-environment and account-CLI changes to `'panel'` (a guardrail against prompt-injected tool calls, not an OS security boundary, since agents run shell commands; `origin` has no default so no caller receives panel privileges implicitly).
   * @returns Save outcome with the block's current `revision`, whether `policy_changed`, whether `restarting`, and `context_delivery` status (`'injected'` or `'pending'`).
   * @throws SettingsConflict when `block`'s revision changed before or during validation checks.
   * @throws UserError | z.ZodError when `block` is unknown, the source is not installed, `value` is invalid (such as an `executor` block carrying `paused`, which only `pause` sets), a non-panel `origin` changes panel-only fields, or a role-model or account check fails.
   */
  async save(block: SettingsBlock, value: unknown, revision: number, origin: SettingsOrigin) {
    const { store, sources, engine, sessions } = this.host
    const stale = () => revision !== store.blockRevision(block)
    if (stale()) throw new SettingsConflict('Settings changed. Reload before saving.')
    const id = block.startsWith('source:') ? block.slice(7) : block
    const kind = block.startsWith('source:') ? 'source' : block
    if (!(kind in BLOCKS)) throw new UserError('unknownBlock', { block })
    const rules = BLOCKS[kind as keyof typeof BLOCKS]
    if (kind === 'source' && !sources.kind(id)) throw new UserError('sourceNotInstalled', { source: id })
    const parsed = rules.parse(value, sources, id)
    const current = store.settings()
    const candidate = rules.merge(current, parsed, id)
    rules.guard?.(current, candidate, origin)
    if (kind === 'topology' || kind === 'source') {
      TopologySchema.parse(topologyOf(candidate))
      for (const [sourceId, before] of Object.entries(current.sources)) {
        const after = candidate.sources[sourceId]
        if (!after || (before.repositoryId && after.repositoryId !== before.repositoryId) || (after.kind ?? sourceId) !== (before.kind ?? sourceId)) throw new Error('An existing source cannot be deleted or rebound; disable it and create a new source ID')
      }
    }
    const validateHistory = () => {
      if (kind !== 'topology') return
      for (const [repositoryId, before] of Object.entries(current.repositories)) {
        const after = candidate.repositories[repositoryId]
        if (!after || after.fullName !== before.fullName || after.provider !== before.provider) throw new Error('An existing repository cannot be deleted or retargeted; disable it and create a new repository ID')
      }
      for (const ticket of store.tickets.list()) {
        if (!ticket.repository) continue
        const before = current.repositories[ticket.repository], after = candidate.repositories[ticket.repository]
        if (!after || (before && after.fullName !== before.fullName)) throw new Error('A repository referenced by ticket history cannot be deleted or retargeted; disable it instead')
        const plan = ticket.execution?.plan
        for (const profile of [plan?.accessProfileId, before?.accessProfileId].filter((id): id is string => !!id)) if (!candidate.accessProfiles[profile]) throw new Error('Access profile is referenced by ticket history')
        for (const profile of [plan?.executorProfileId, before?.executorProfileId].filter((id): id is string => !!id)) if (!candidate.executorProfiles[profile]) throw new Error('Executor profile is referenced by ticket history')
      }
    }
    validateHistory()
    if (kind === 'topology') {
      for (const [profileId, profile] of Object.entries(candidate.executorProfiles)) {
        if (profile.model && JSON.stringify(profile.model) !== JSON.stringify(current.executorProfiles[profileId]?.model)) await resolveRoleModel(this.host.context, profile.model)
      }
    }
    const model = block === 'eval' ? candidate.eval.model : block === 'executor' ? candidate.executor.model : null
    const previous = block === 'eval' ? current.eval.model : block === 'executor' ? current.executor.model : null
    if (model && JSON.stringify(model) !== JSON.stringify(previous)) {
      try { await resolveRoleModel(this.host.context, model) }
      catch (error) { throw new UserError('modelUnavailable', { block, error: error instanceof Error ? error.message : String(error) }) }
    }
    rules.guard?.(current, candidate, origin)
    if (setupChanged(current, candidate)) await this.host.setup.checkAccounts(block, candidate)
    if (stale()) throw new SettingsConflict('Settings changed during the checks. Reload before saving.')
    // Re-read current settings after async checks in case unrelated blocks were saved concurrently.
    const old = store.settings()
    const settings = rules.merge(old, parsed, id)
    validateHistory()
    if (JSON.stringify(SettingsSchema.parse(settings)) === JSON.stringify(old)) {
      const delivery = await sessions.delivery(`settings:${block}`)
      return { saved: true, revision: store.blockRevision(block), policy_changed: false, restarting: false, context_delivery: delivery }
    }
    const restarting = setupChanged(old, settings) || !this.host.setup.configured()
    const before = policyVersion(old), after = policyVersion(settings)
    const scope = (version: SettingsValue) => ({
      scope: (input: { source: string; meta: Record<string, unknown> }) => this.host.sources.scope(input, version) })
    const effects = before === after ? new Map() : policyEffects(store.tickets.open(), old, SettingsSchema.parse(settings), scope)
    const notified = [...effects.keys()]
    store.atomic(() => {
      store.saveSettings(SettingsSchema.parse(settings), { source: origin, block, policyVersion: after, policyChanged: before !== after, notified })
      if (origin !== 'tool') sessions.notify(...settingsNotice(block, changedPaths(old, settings)))
      if (before !== after) engine.policyChanged(before, after, effects)
    })
    // Rewrite worker command shims immediately when `blockedCommands` changes.
    const blocked = settings.executor.blockedCommands
    const changed = blocked.join(' ') !== old.executor.blockedCommands.join(' ')
    // Managed workers pin command policy: restart must stop their processes before rewriting shared shims.
    if (changed && !Object.keys(settings.repositories).length) await this.host.setup.blockCommands(blocked)
    // When restarting, the notice stays pending until after the restart; `setup.restart()` defers until this call returns.
    const delivery = restarting ? 'pending' : await sessions.delivery(`settings:${block}`)
    if (restarting) this.host.setup.restart()
    else this.host.requestPass()
    return { saved: true, revision: store.blockRevision(block), policy_changed: before !== after, restarting, context_delivery: delivery }
  }
  /**
   * Pauses or resumes processing (new evaluations, worker dispatch, and channel delivery, while Sources continue recording
   * Triggers); saved in its own `'pause'` block so concurrent `executor` edits remain valid across it.
   * @returns Whether processing is now paused (`{ paused }`).
   */
  async pause(paused: boolean, origin: SettingsOrigin): Promise<{ paused: boolean }> {
    const { store, sessions } = this.host
    const old = store.settings()
    if (old.paused === paused) return { paused }
    store.atomic(() => {
      const record = { source: origin, block: 'pause' as const, policyVersion: policyVersion(old), policyChanged: false, notified: [] }
      store.saveSettings({ ...old, paused }, record)
      if (origin !== 'tool') sessions.notify(...settingsNotice('pause', ['paused']))
    })
    await sessions.delivery('settings:pause')
    this.host.requestPass()
    return { paused }
  }
  /** Returns the IDs of installed, enabled Sources whose policy section can synchronize now (empty while setup is not configured). */
  syncable(): string[] {
    const { sources } = this.host
    if (!this.host.setup.configured()) return []
    return sources.instances().filter(instance => instance.installed && instance.enabled).flatMap(instance => {
      const sync = sources.kind(instance.id)?.policy?.sync
      const part = sources.policyPart(instance.id)
      return sync && part && sync.ready(part) ? [instance.id] : []
    })
  }
  /**
   * Synchronizes source `id`'s policy section from its external source of truth, saves it as a `'policy'` revision when
   * changed, and records the outcome in the `sync:<id>` health entry (scheduling exponential-backoff retries via `retrySync` on failure).
   * @returns The synchronized policy section for `id`.
   * @throws UserError (`nothingToSync`) when `id` cannot sync now, `SettingsConflict` if the `'policy'` block changed during synchronization, or the underlying sync error on failure.
   */
  async sync(id: string) {
    const { store, sources } = this.host
    if (!this.syncable().includes(id)) throw new UserError('nothingToSync', { source: id })
    const health = this.syncHealth(id)
    try {
      const revision = store.blockRevision('policy')
      const part = await sources.kind(id)!.policy!.sync!.run(this.host.sourceHost, sources.policyPart(id)!, this.host.lifetime)
      if (revision !== store.blockRevision('policy')) throw new SettingsConflict('Policy changed during synchronization. Retry with the current settings.')
      const policy = store.settings().policy
      // Skip saving a new revision when the synced list is unchanged.
      if (JSON.stringify(part) !== JSON.stringify(policy.sources[id])) {
        await this.save('policy', { ...policy, sources: { ...policy.sources, [id]: part } }, revision, 'sync')
      }
      health.set({ state: 'ready', detail: `${part.allowed.length} allowed`, at: now() })
      this.retrySync(id, false)
      return part
    } catch (error) {
      health.set({ state: 'error', detail: String(error), at: now() })
      this.retrySync(id, true)
      throw error
    }
  }
  /**
   * Rereads a Source's display names (such as Feishu chat names) immediately.
   * @returns Sorted display names (`{ added }`) that were not present in the stored label map before this read.
   * @throws UserError (`noLabels`) when the Source has no label refresh; rethrows a failed read, keeping the stored list.
   */
  async refreshLabels(id: string): Promise<{ added: string[] }> {
    const { store, sources } = this.host
    const instance = sources.instance(id)
    const kind = instance && sources.kind(instance.kind)
    if (!kind?.refreshLabels) throw new UserError('noLabels')
    const before = store.get(KV.sources.labels(id)) ?? {}
    const after = await kind.refreshLabels(this.host.sourceHost)
    return { added: Object.entries(after).filter(([key]) => !(key in before)).map(([, name]) => name).sort((a, b) => a.localeCompare(b)) }
  }
}
