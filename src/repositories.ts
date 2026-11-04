/** Deterministic routing: external text may propose a target but never authorizes one. */
import type { Settings } from './policy.ts'
import type { Ticket } from './core/model.ts'

export interface TargetInput { sourceInstanceId: string; repository?: string; meta?: Record<string, unknown>; configurationRevision?: number }
export interface ResolvedTarget { repository?: string; routing?: Ticket['routing'] }
export function resolveTarget(settings: Settings, input: TargetInput): ResolvedTarget {
  if (!Object.keys(settings.repositories).length) return {}
  const source = settings.sources[input.sourceInstanceId]
  if (!source?.enabled) throw new Error('Source is missing or disabled')
  const kind = source.kind ?? input.sourceInstanceId
  const allowed = kind === 'github' ? [source.repositoryId].filter((id): id is string => !!id) : source.routing?.allowedRepositoryIds ?? []
  let repository: string | undefined, basis: NonNullable<Ticket['routing']>['basis']
  if (kind === 'github') {
    repository = source.repositoryId; basis = 'source'
    if (input.repository && input.repository !== repository) throw new Error('GitHub target conflicts with its source binding')
  } else if (input.repository) { repository = input.repository; basis = 'explicit' }
  else {
    const chat = input.meta?.chatId ?? input.meta?.chat_id
    repository = (typeof chat === 'string' ? source.routing?.chats?.[chat] : undefined) ?? source.routing?.defaultRepositoryId
    basis = 'default'
  }
  if (!repository) throw new Error('Repository target is unresolved; configure a default or specify an allowed repository')
  if (!allowed.includes(repository)) throw new Error('Repository is outside source routing authorization')
  const config = settings.repositories[repository]
  if (!config?.enabled || !settings.accessProfiles[config.accessProfileId] || !settings.executorProfiles[config.executorProfileId]) throw new Error('Repository is disabled or its profiles are unavailable')
  return { repository, routing: { sourceInstanceId: input.sourceInstanceId, basis, ...(input.configurationRevision === undefined ? {} : { configurationRevision: input.configurationRevision }) } }
}
export function repositoryAllowed(settings: Settings, repository: string, sourceInstanceId?: string): boolean {
  if (!sourceInstanceId) return false
  try { return resolveTarget(settings, { sourceInstanceId, repository }).repository === repository } catch { return false }
}
