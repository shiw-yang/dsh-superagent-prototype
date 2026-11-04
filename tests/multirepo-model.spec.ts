/** Managed topology, deterministic routing, migration and settings CAS coverage. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsSchema, TopologySchema, topologyOf, settingsPolicy } from '../src/policy.ts'
import { resolveTarget } from '../src/repositories.ts'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { Engine, MemoryRepositories, type Trigger, type Policy } from '../src/core/index.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const topology = () => TopologySchema.parse({
  repositories: { api: { name: 'API', provider: 'github', fullName: 'org/api', accessProfileId: 'bot', executorProfileId: 'worker', enabled: true },
    web: { name: 'Web', provider: 'github', fullName: 'org/web', accessProfileId: 'bot', executorProfileId: 'worker', enabled: true } },
  executorProfiles: { worker: { name: 'Worker' } }, accessProfiles: { bot: { name: 'Bot', kind: 'github-cli', cli: 'gh' } },
  sources: { 'github-api': { kind: 'github', repositoryId: 'api' }, 'github-web': { kind: 'github', repositoryId: 'web' },
    feishu: { routing: { allowedRepositoryIds: ['api', 'web'], chats: { chat: 'web' } } } }, scheduler: { maxWorkers: 4, maxWorkersPerRepository: 2 },
})
it('rejects duplicate repository identities, malformed names and unsupported Feishu instances', () => {
  const value = topology()
  expect(() => TopologySchema.parse({ ...value, repositories: { ...value.repositories,
    duplicate: { ...value.repositories.api!, fullName: 'ORG/API' } } })).toThrow('already registered')
  expect(() => TopologySchema.parse({ ...value, repositories: { ...value.repositories,
    api: { ...value.repositories.api!, fullName: 'org/api?redirect=other' } } })).toThrow('owner/name')
  expect(() => TopologySchema.parse({ ...value, sources: { ...value.sources,
    'feishu-other': { kind: 'feishu', enabled: true, config: {} } } })).toThrow('one Feishu source')
})
const configured = () => SettingsSchema.parse(topology())
let h: Host | undefined
const dirs: string[] = []
afterEach(async () => { await h?.stop(); h = undefined; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function engineHarness() {
  const settings = configured(), repo = new MemoryRepositories(), send = vi.fn(), start = vi.fn()
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60000, admitsInferred: () => true, revalidate: () => true,
    gate: trigger => ({ admissible: true, strength: 'explicit', basis: { via: 'listed', source: trigger.source, scope: trigger.meta } }),
    resolveTarget: input => resolveTarget(settings, { ...input, configurationRevision: 7 }) }
  const engine = new Engine({ repo, policy: () => policy, scope: { scope: () => ({ listened: true, observed: true }) },
    assessor: { request: vi.fn() }, executor: { start, stop: vi.fn(), deliver: vi.fn() }, outbox: { send, status: () => undefined, withdraw: vi.fn() } })
  const receive = (id: string, source: string) => {
    const trigger: Trigger = { id, source, actor: { source, id: 'person' }, threads: [{ source, id }], human: true, addressed: 'mention',
      at: new Date().toISOString(), text: 'fix typo', meta: {}, channel: { source, thread: id, address: { id } } }
    engine.receive(trigger)
    return trigger
  }
  return { engine, repo, receive, start, send }
}
it('rejects unresolved acceptance without creating a runnable ticket or acknowledgement', () => {
  const { engine, repo, receive, start, send } = engineHarness()
  receive('ambiguous', 'feishu')
  const decision = engine.decide('ambiguous', { kind: 'accept', title: 'Fix', scope: 'typo', reason: 'request', acknowledgement: 'Will fix' })
  expect(decision.kind).toBe('unavailable')
  expect(repo.tickets.open()).toEqual([])
  expect(start).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
})
it('pins target and revision and rejects cross-repository attachments', () => {
  const { engine, repo, receive } = engineHarness()
  receive('first', 'github-api')
  const decision = engine.decide('first', { kind: 'accept', title: 'Fix', scope: 'typo', reason: 'request' })
  const ticket = repo.tickets.get(decision.ticketId!)!
  expect(ticket).toMatchObject({ repository: 'api', mandate: { repository: 'api' }, routing: { configurationRevision: 7 } })
  receive('other', 'github-web')
  expect(() => engine.attach(ticket.id, 'other')).toThrow()
  expect(repo.tickets.get(ticket.id)!.repository).toBe('api')
})
it('defaults retain legacy settings and source kinds without inventing a GitHub identity', () => {
  const settings = SettingsSchema.parse({ sources: { feishu: {} } })
  expect(settings.repositories).toEqual({})
  expect(settings.sources.feishu!.kind).toBeUndefined()
  expect(resolveTarget(settings, { sourceInstanceId: 'feishu' })).toEqual({})
})
it('validates cross references, stable IDs and routing allowlists atomically', () => {
  const value = topology()
  expect(() => TopologySchema.parse({ ...value, accessProfiles: {} })).toThrow('Unknown access profile')
  expect(() => TopologySchema.parse({ ...value, sources: { ...value.sources, duplicate: { kind: 'github', repositoryId: 'api', enabled: true } } })).toThrow('Only one enabled')
  expect(() => TopologySchema.parse({ ...value, sources: { ...value.sources, duplicate: { kind: 'github', repositoryId: 'api', enabled: false } } })).not.toThrow()
  expect(() => TopologySchema.parse({ ...value, sources: { feishu: { routing: { allowedRepositoryIds: ['api'], defaultRepositoryId: 'web' } } } })).toThrow('must be allowed')
  expect(() => TopologySchema.parse({ ...value, repositories: { '../bad': value.repositories.api } })).toThrow()
})
it('binds GitHub targets and rejects mismatch, disabled sources and missing profiles', () => {
  const settings = configured()
  expect(resolveTarget(settings, { sourceInstanceId: 'github-api' })).toMatchObject({ repository: 'api', routing: { basis: 'source' } })
  expect(() => resolveTarget(settings, { sourceInstanceId: 'github-api', repository: 'web' })).toThrow('conflicts')
  settings.repositories.api!.enabled = false
  expect(() => resolveTarget(settings, { sourceInstanceId: 'github-api' })).toThrow('disabled')
})
it('requires an unambiguous IM target and constrains explicit, default and chat routing', () => {
  const settings = configured()
  expect(() => resolveTarget(settings, { sourceInstanceId: 'feishu' })).toThrow('unresolved')
  expect(resolveTarget(settings, { sourceInstanceId: 'feishu', meta: { chatId: 'chat' } }).repository).toBe('web')
  expect(resolveTarget(settings, { sourceInstanceId: 'feishu', repository: 'api' }).routing?.basis).toBe('explicit')
  settings.sources.feishu!.routing!.allowedRepositoryIds = ['web']
  expect(() => resolveTarget(settings, { sourceInstanceId: 'feishu', repository: 'api' })).toThrow('outside')
})
it('revalidates repository authorization before normal mandate admission', () => {
  const settings = configured()
  settings.policy.sources.feishu = { allowed: [{ id: 'person' }], admission: {} }
  const mandate = { repository: 'api', strength: 'explicit' as const, policyVersion: '', actor: { source: 'feishu', id: 'person' }, scope: '', basis: { via: 'addressed' as const, addressed: 'mention' as const, source: 'feishu' } }
  expect(settingsPolicy(settings, { scope: () => ({ listened: true, observed: true }) }).revalidate(mandate)).toBe(true)
  settings.repositories.api!.enabled = false
  expect(settingsPolicy(settings, { scope: () => ({ listened: true, observed: true }) }).revalidate(mandate)).toBe(false)
})
it('migrates schema 11 topology while preserving old history and remaining idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'multi-model-')); dirs.push(dir)
  const file = join(dir, 'state.db')
  let store = new Store(file)
  store.saveSettings({ sources: { github: { config: { repository: 'org/legacy', cli: '/opt/gh' } }, feishu: {} }, executor: { directory: '/old/work', maxWorkers: 2 } })
  const revision = store.settingsHistory()[0]!.revision
  const fixture = engineHarness()
  for (const [id, url] of [['known', 'https://github.com/org/legacy/issues/1'], ['ambiguous', 'https://github.com/org/old/issues/1']]) {
    const trigger = fixture.receive(id!, 'github-api')
    const decision = fixture.engine.decide(id!, { kind: 'accept', title: 'Fix', scope: 'typo', reason: 'request' })
    const ticket = fixture.repo.tickets.get(decision.ticketId!)!
    delete ticket.repository; delete ticket.routing; delete ticket.mandate.repository
    store.triggers.save({ ...trigger, source: 'github', url })
    store.tickets.save({ ...ticket, id: id! })
  }
  store.set(KV.store.schema, 11); store.close()
  store = new Store(file)
  expect(store.get(KV.store.schema)).toBe(12)
  expect(store.settings().repositories.default).toMatchObject({ fullName: 'org/legacy' })
  expect(store.tickets.get('known')!.repository).toBe('default')
  expect(store.tickets.get('ambiguous')!.repository).toBeUndefined()
  expect(store.settings().executorProfiles.default).toMatchObject({ directory: '/old/work' })
  expect(store.settings().sources.feishu!.routing).toEqual({ defaultRepositoryId: 'default', allowedRepositoryIds: ['default'] })
  expect(store.settingsHistory().find(item => item.revision === revision)!.settings.repositories).toEqual({})
  const count = store.settingsHistory().length
  store.close(); store = new Store(file)
  expect(store.settingsHistory()).toHaveLength(count)
  store.close()
})
it('does not rewrite live shared command shims when managed default executor policy changes', async () => {
  h = await startRuntime()
  const { settings, store, setup } = h.runtime
  const current = store.settings(), template = topology()
  store.saveSettings({ ...current, repositories: { default: { ...template.repositories.api!, executorProfileId: 'default' } },
    executorProfiles: { default: template.executorProfiles.worker }, accessProfiles: template.accessProfiles,
    sources: { ...current.sources, github: { ...current.sources.github!, repositoryId: 'default' } } })
  vi.spyOn(setup, 'checkAccounts').mockResolvedValue(undefined)
  const rewrite = vi.spyOn(setup, 'blockCommands').mockResolvedValue(undefined)
  const restart = vi.spyOn(setup, 'restart').mockImplementation(() => {})
  await settings.save('executor', { ...store.settings().executor, blockedCommands: ['curl'] }, store.blockRevision('executor'), 'panel')
  expect(store.settings().executorProfiles.default!.blockedCommands).toEqual(['curl'])
  expect(rewrite).not.toHaveBeenCalled()
  expect(restart).toHaveBeenCalled()
})
it('saves topology panel-only, preserves source binding and rejects overlapping stale saves', async () => {
  h = await startRuntime()
  const { settings, store, setup } = h.runtime
  vi.spyOn(setup, 'checkAccounts').mockResolvedValue(undefined)
  vi.spyOn(setup, 'restart').mockImplementation(() => {})
  const value = topology()
  value.sources = { ...store.settings().sources, ...value.sources, github: { ...store.settings().sources.github!, enabled: false, repositoryId: 'api' } }
  await expect(settings.save('topology', value, 0, 'tool')).rejects.toThrow()
  expect(store.settings().repositories).toEqual({})
  await settings.save('topology', value, store.blockRevision('topology'), 'panel')
  const persisted = topologyOf(store.settings())
  await expect(settings.save('topology', { ...persisted, repositories: { ...persisted.repositories, api: { ...persisted.repositories.api!, fullName: 'evil/other' } } }, store.blockRevision('topology'), 'panel')).rejects.toThrow('cannot be deleted or retargeted')
  const { 'github-api': _removed, ...remaining } = persisted.sources
  await expect(settings.save('topology', { ...persisted, sources: remaining }, store.blockRevision('topology'), 'panel')).rejects.toThrow('cannot be deleted or rebound')
  const fixture = engineHarness(); fixture.receive('historical', 'github-api')
  const accepted = fixture.engine.decide('historical', { kind: 'accept', title: 'Fix', scope: 'typo', reason: 'request' })
  store.tickets.save(fixture.repo.tickets.get(accepted.ticketId!)!)
  const changedTarget = topologyOf(store.settings())
  await expect(settings.save('topology', { ...changedTarget, repositories: { ...changedTarget.repositories, api: { ...changedTarget.repositories.api!, fullName: 'evil/other' } } }, store.blockRevision('topology'), 'panel')).rejects.toThrow('cannot be deleted or retargeted')
  const revision = store.blockRevision('topology')
  const source = store.settings().sources['github-api']!
  await settings.save('source:github-api', { enabled: source.enabled, config: source.config }, store.blockRevision('source:github-api'), 'panel')
  expect(store.settings().sources['github-api']).toMatchObject({ kind: 'github', repositoryId: 'api' })
  await expect(settings.save('source:github-api', { ...source, enabled: false, repositoryId: 'web' }, store.blockRevision('source:github-api'), 'panel')).rejects.toThrow('cannot be deleted or rebound')
  const current = topologyOf(store.settings())
  await expect(settings.save('topology', { ...current, sources: { ...current.sources, 'github-api': { ...source, enabled: false, repositoryId: 'web' } } }, store.blockRevision('topology'), 'panel')).rejects.toThrow('cannot be deleted or rebound')
  await settings.save('topology', { ...current, scheduler: { maxWorkers: 5 } }, store.blockRevision('topology'), 'panel')
  await expect(settings.save('topology', current, revision, 'panel')).rejects.toThrow(SettingsConflict)
})
