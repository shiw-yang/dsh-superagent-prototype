/** Immutable execution snapshots and fail-closed authorization for the installed local DSH backend. */
import { join } from 'node:path'
import type { Execution, Ticket } from '../core/index.ts'
import type { Settings } from '../policy.ts'

/**
 * Installed DSH alpha.2: dsh-shell-env.collect(execution) accepts only registered DSH_* facts;
 * dsh-tool-bash forwards that dshEnv snapshot (also for background jobs). Session has no ordinary
 * environment override, and subprocess.spawn({ env }) only affects calls we spawn ourselves.
 * Therefore prepare-only env cannot isolate worker/subagent PATH or git credential configuration.
 */
export const SESSION_ENV_LIMITATION = 'Installed DSH cannot bind PATH or git credential configuration to a Session and its subagents/background shell jobs'
const commands = (values: readonly string[]) => JSON.stringify([...new Set(values)].sort())

/** Current revocation checks deliberately do not re-resolve the pinned execution profile. */
export function repositoryExecutionProblem(settings: Settings, ticket: Ticket): string | undefined {
  if (!ticket.repository) return Object.keys(settings.repositories ?? {}).length ? 'Ticket has no resolved target repository' : undefined
  const repository = settings.repositories?.[ticket.repository]
  if (!repository) return `Repository ${ticket.repository} no longer exists`
  if (!repository.enabled) return `Repository ${ticket.repository} is disabled`
  const plan = ticket.execution?.plan
  if (plan && (plan.repositoryId !== ticket.repository || plan.repository !== repository.fullName)) return 'The ticket repository binding changed'
  if (plan && plan.directory !== ticket.execution?.directory) return 'The fixed execution directory changed'
  if (ticket.mandate?.repository && ticket.mandate.repository !== ticket.repository) return 'The ticket target differs from its mandate'
  if (plan && plan.accessProfileId !== repository.accessProfileId) return 'The ticket access profile was revoked or changed'
  if (!settings.accessProfiles?.[plan?.accessProfileId ?? repository.accessProfileId]) return 'The repository access profile is unavailable'
  return undefined
}

/** Refuse misleading per-prepare-only account/policy isolation on this DSH version. */
export function workerEnvironmentProblem(settings: Settings, ticket: Ticket, baselineGithubCli?: string, baselineBlockedCommands: readonly string[] = settings.executor.blockedCommands): string | undefined {
  const problem = repositoryExecutionProblem(settings, ticket)
  if (problem) return problem
  if (!ticket.repository) return undefined
  const repository = settings.repositories[ticket.repository]!
  const plan = ticket.execution?.plan
  const profile = settings.executorProfiles[repository.executorProfileId]
  const blocked = plan?.blockedCommands ?? profile?.blockedCommands
  if (!blocked) return 'The repository executor profile is unavailable'
  if (commands(blocked) !== commands(baselineBlockedCommands)) return `${SESSION_ENV_LIMITATION}; differing blockedCommands are unsupported`
  const cli = settings.accessProfiles[plan?.accessProfileId ?? repository.accessProfileId]?.cli
  if (!baselineGithubCli || cli !== baselineGithubCli) return `${SESSION_ENV_LIMITATION}; differing or unverified GitHub accounts/CLI wrappers are unsupported`
  return undefined
}

export function plannedExecution(ticket: Ticket, execution: Execution, settings: Settings, stateDir: string): Execution {
  if (execution.plan || !ticket.repository) return execution
  const repository = settings.repositories[ticket.repository]
  if (!repository) throw new Error('The target repository is unavailable')
  const profile = settings.executorProfiles[repository.executorProfileId]
  if (!profile || !settings.accessProfiles[repository.accessProfileId]) throw new Error('The repository execution/access profile is unavailable')
  // Preserve historical workspaces; only newly accepted executions use the profile directory.
  const directory = ticket.execution?.directory || join(profile.directory || join(stateDir, 'work'), ticket.repository, execution.name)
  return { ...execution, directory, plan: { repositoryId: ticket.repository, repository: repository.fullName,
    ...(repository.defaultBranch === undefined ? {} : { defaultBranch: repository.defaultBranch }),
    executorProfileId: repository.executorProfileId, accessProfileId: repository.accessProfileId,
    ...(ticket.routing?.configurationRevision === undefined ? {} : { configurationRevision: ticket.routing.configurationRevision }),
    model: profile.model ? { ...profile.model } : null, directory, prepare: profile.prepare,
    blockedCommands: [...profile.blockedCommands], createdAt: new Date().toISOString() } }
}
