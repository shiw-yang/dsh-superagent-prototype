/** Execution environment variables exposed to prepare commands and documented in worker Session instructions; never contains credentials. */
import { join } from 'node:path'
import type { Ticket, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Settings } from '../policy.ts'
import type { Localized, VariableSpec } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'

/** Variables registered by the Executor; `ticket` entries are populated only when a ticket is present. */
export const EXECUTOR_VARIABLES: readonly (VariableSpec & { ticket?: true })[] = [
  { key: 'DSH_SUPERAGENT_DIR', ticket: true, description: { zh: '这个工单的执行目录；执行器 Session 在其中工作', en: 'This ticket\'s directory; the executor Session works in it' } },
  { key: 'DSH_SUPERAGENT_NAME', ticket: true, description: { zh: '工单的短名，也是执行目录的名字', en: 'The ticket\'s short name, also its directory\'s name' } },
  { key: 'DSH_SUPERAGENT_TICKET', ticket: true, description: { zh: '工单 id', en: 'The ticket id' } },
  { key: 'DSH_SUPERAGENT_BRANCH', ticket: true, description: { zh: '执行计划固定的基础分支；空值表示远端默认分支，由 prepare 脚本自行使用', en: 'The execution plan\'s base branch; empty means the remote default branch. The prepare script chooses how to use it' } },
  { key: 'DSH_SUPERAGENT_BLOCKED_COMMANDS', description: { zh: '这个执行环境禁止调用的命令，以空格分隔；不要运行它们', en: 'Commands blocked in this execution environment, separated by spaces; never run them' } },
]
export interface Variable { key: string; value: string; description: Localized; owner: string }

export const executionRoot = (settings: Settings, stateDir: string): string => settings.executor.directory || join(stateDir, 'work')

/** Lists all declared variables grouped by owner; `enabled` is false for Sources that are currently switched off. */
export function declaredVariables(sources: SourceRegistry, settings?: Settings): { owner: string; enabled: boolean; variables: readonly VariableSpec[] }[] {
  const on = new Set(sources.environments(settings).map(item => item.kind.kind))
  return [{ owner: 'executor', enabled: true, variables: EXECUTOR_VARIABLES },
    ...sources.declarations().map(({ kind, variables }) => ({ owner: kind, enabled: on.has(kind), variables }))]
}

export function environmentOf(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; repositoryId?: string; ticket?: { id: string; name: string; directory: string; branch?: string }; trigger?: Trigger }): Variable[] {
  const { deployment, sources, settings, ticket, trigger } = input
  const executor: Record<string, string> = { DSH_SUPERAGENT_BLOCKED_COMMANDS: settings.executor.blockedCommands.join(' '), ...ticket ? { DSH_SUPERAGENT_DIR: ticket.directory, DSH_SUPERAGENT_NAME: ticket.name, DSH_SUPERAGENT_TICKET: ticket.id, DSH_SUPERAGENT_BRANCH: ticket.branch ?? '' } : {} }
  const result: Variable[] = EXECUTOR_VARIABLES.filter(spec => !spec.ticket || ticket).map(spec => ({ key: spec.key, value: executor[spec.key] ?? '', description: spec.description, owner: 'executor' }))
  const instances = sources.instances(settings)
  for (const declaration of sources.declarations()) {
    const kind = sources.kind(declaration.kind), environment = kind?.environment
    if (!kind || !environment) continue
    const candidates = instances.filter(instance => instance.kind === kind.kind
      && (kind.kind !== 'github' || !input.repositoryId || instance.repositoryId === input.repositoryId))
    const instance = candidates.find(instance => instance.id === trigger?.source)
      ?? candidates.find(instance => instance.enabled && instance.id === kind.kind)
      ?? candidates.find(instance => instance.enabled)
    // An IM ticket can target a repository without a GitHub listener: expose deployment facts,
    // but never fabricate a source instance or interpret its IM metadata as a GitHub issue.
    if (!instance && !(kind.kind === 'github' && input.repositoryId)) continue
    const values = instance ? environment.values({ deployment, config: instance.config, sourceId: instance.id, ...trigger ? { trigger } : {} })
      : environment.values({ deployment, config: kind.schema.parse({}) })
    for (const spec of environment.variables) result.push({ key: spec.key, value: values[spec.key] ?? '', description: spec.description, owner: kind.kind })
  }
  return result
}

/** Combines a ticket's fixed directory, name, and origin trigger with the deployment's current settings. */
export function ticketEnvironment(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket: Ticket; trigger?: Trigger }) {
  const { ticket, trigger, ...rest } = input
  const branch = ticket.execution?.plan ? ticket.execution.plan.defaultBranch
    : ticket.repository ? rest.settings.repositories[ticket.repository]?.defaultBranch : undefined
  const values = { id: ticket.id, name: ticket.execution?.name ?? '', directory: ticket.execution?.directory ?? '', branch }
  const settings = ticket.execution?.plan ? { ...rest.settings, executor: { ...rest.settings.executor,
    blockedCommands: ticket.execution.plan.blockedCommands } } : rest.settings
  return environmentOf({ ...rest, settings, repositoryId: ticket.repository, ticket: values, ...trigger ? { trigger } : {} })
}
export function environmentLines(variables: Variable[]): string {
  return variables.map(variable => `- ${variable.key} = ${JSON.stringify(variable.value)}: ${variable.description.en}.`).join('\n')
}
