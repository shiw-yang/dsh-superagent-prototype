/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import { SETUP_FIELDS, resolveDeployment, resolveFeishuBot, workerProbe, type Deployment, type Machine } from '../deployment.ts'
import { agentVariables, applyEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import { SetupError, type SetupProblem } from '../setup.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  restart(): void
}

const setupFields = (settings: Settings) =>
  JSON.stringify({ accounts: Object.entries(settings.sources).map(([id, source]) => [id, source.kind, source.repositoryId, source.routing, (SETUP_FIELDS[source.kind ?? id] ?? []).map(key => source.config[key] ?? '')]), repositories: settings.repositories, accessProfiles: settings.accessProfiles, commandPolicies: Object.entries(settings.executorProfiles).map(([id, profile]) => [id, profile.blockedCommands]) })
export const setupChanged = (before: Settings, after: Settings): boolean => setupFields(before) !== setupFields(after)

/**
 * Resolves the target repository, GitHub account, and optional Feishu bot by probing CLIs, then writes and applies the isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update blocked command shims, and schedule restarts.
 */
export class Setup {
  private resolved?: Deployment
  baselineExecutorProfileId?: string
  baselineAccessCli?: string
  baselineBlockedCommands: readonly string[] = []
  private readonly deployments = new Map<string, Deployment>()
  private readonly problems = new Map<string, SetupProblem>()
  deploymentFor(repositoryId?: string): Deployment {
    if (!repositoryId) return this.deployment
    const deployment = this.deployments.get(repositoryId)
    if (!deployment) throw new Error(`Repository ${repositoryId} is unavailable: ${this.problems.get(repositoryId)?.detail ?? 'disabled or not configured'}`)
    return deployment
  }
  problemFor(repositoryId: string): SetupProblem | undefined { return this.problems.get(repositoryId) }
  problem?: SetupProblem
  feishuProblem?: SetupProblem
  /** PATH with the worker shim directory removed so the host's own CLI calls invoke the real binaries. */
  private readonly path: string
  /** Environment variables pointing agent subprocesses at the isolated git config and command shims. */
  private readonly variables: Record<string, string | undefined>
  private restoreEnvironment?: () => void
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
  }
  /** Host command environment with agent git variables applied and the worker shim directory excluded from PATH. */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  configured(repositoryId?: string): boolean { return repositoryId ? this.deployments.has(repositoryId) : this.resolved !== undefined }
  /** Resolve deployment accounts and apply the worker environment, recording `SetupError` failures in `problem`/`feishuProblem` and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    this.problem = undefined
    this.feishuProblem = undefined
    this.resolved = undefined
    this.baselineExecutorProfileId = undefined
    this.deployments.clear()
    this.problems.clear()
    try {
      if (Object.keys(settings.repositories ?? {}).length) return await this.resolveRepositories(settings)
      this.resolved = await this.resolve(settings)
      return true
    }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problem = error.problem
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing if setup and Feishu are already healthy so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && !this.feishuProblem && !this.problems.size) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /** Verify account CLIs for a modified source block before saving, ignoring setup errors belonging to other blocks. */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    // Topology may contain a broken repository alongside healthy ones; startup records those failures locally.
    // Non-source edits must not accidentally probe an absent legacy `github` instance.
    if (!block.startsWith('source:')) return
    const { machine } = this.host
    const id = block.slice(7)
    const source = settings.sources[id]
    const kind = source?.kind ?? id
    const repository = source?.repositoryId ? settings.repositories[source.repositoryId] : undefined
    const config = repository ? { repository: repository.fullName, cli: settings.accessProfiles[repository.accessProfileId]?.cli ?? '' } : source?.config
    const check = kind === 'feishu' ? resolveFeishuBot(machine, config, this.probe()) : resolveDeployment(machine, config, this.probe())
    await check.catch((error: unknown) => { if (!(error instanceof SetupError) || error.place === kind) throw error })
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) { await writeEnvironment(this.resolved, blocked); this.baselineBlockedCommands = [...blocked] }
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before the repository clone is valid. */
  private probe() {
    const { context, machine, lifetime } = this.host
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  private async resolveRepositories(settings: Settings): Promise<boolean> {
    const { context, machine } = this.host
    const probe = this.probe()
    const feishu = await resolveFeishuBot(machine, settings.sources.feishu?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.feishuProblem = error.problem
      return undefined
    })
    for (const [id, repository] of Object.entries(settings.repositories)) {
      if (!repository.enabled) continue
      try {
        const access = settings.accessProfiles[repository.accessProfileId]
        const deployment = await resolveDeployment(machine, { repository: repository.fullName, cli: access?.cli ?? '' }, probe)
        this.deployments.set(id, { ...deployment, ...(feishu ? { feishu } : {}) })
      } catch (error) {
        const problem = error instanceof SetupError ? error.problem : new SetupError('environmentFailed', { output: String(error) }).problem
        this.problems.set(id, problem)
        context.logger.warn('dsh-superagent leaves repository %s out: %s', id, problem.detail)
      }
    }
    // One process-wide worker baseline, never switched by a listener or ticket.
    const baselineId = this.deployments.has('default') ? 'default' : this.deployments.keys().next().value
    if (!baselineId) { this.problem = this.problems.values().next().value ?? new SetupError('repositoryUnset').problem; return false }
    const deployment = this.deployments.get(baselineId)!
    this.baselineExecutorProfileId = settings.repositories[baselineId]!.executorProfileId
    const profile = settings.executorProfiles[this.baselineExecutorProfileId]
    try {
      const blocked = profile?.blockedCommands ?? settings.executor.blockedCommands
      await writeEnvironment(deployment, blocked)
      this.baselineBlockedCommands = [...blocked]
      this.baselineAccessCli = settings.accessProfiles[settings.repositories[baselineId]!.accessProfileId]?.cli
      this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
      await verifyEnvironment(deployment, context.subprocess, this.host.lifetime)
    } catch (error) {
      this.restore()
      throw error instanceof SetupError ? error : new SetupError('environmentFailed', { output: String(error) })
    }
    this.resolved = deployment
    return true
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    const probe = this.probe()
    const deployment = await resolveDeployment(machine, settings.sources.github?.config, probe)
    const feishu = await resolveFeishuBot(machine, settings.sources.feishu?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.feishuProblem = error.problem
      context.logger.warn('dsh-superagent leaves Feishu out: %s', error.message)
      return undefined
    })
    const resolved = { ...deployment, ...(feishu ? { feishu } : {}) }
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    await writeEnvironment(resolved, settings.executor.blockedCommands).catch(machineProblem)
    this.baselineBlockedCommands = [...settings.executor.blockedCommands]
    this.baselineAccessCli = typeof settings.sources.github?.config.cli === 'string' ? settings.sources.github.config.cli : undefined
    this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
    await verifyEnvironment(resolved, context.subprocess, lifetime).catch((error: unknown) => {
      this.restore()
      machineProblem(error)
    })
    return resolved
  }
}
