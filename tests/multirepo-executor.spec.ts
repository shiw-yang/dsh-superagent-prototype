import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Sessions, type SessionsHost } from '../src/app/sessions.ts'
import { feishu, startRuntime } from './fixtures/host.ts'
import { ticketEnvironment } from '../src/app/execution-environment.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { githubKind } from '../src/sources/github.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'
import { plannedExecution, repositoryExecutionProblem, workerEnvironmentProblem } from '../src/executor/plan.ts'
import { DshExecutor, WorkerSlots, type ExecutorHost } from '../src/executor/dsh.ts'

const configured = () => SettingsSchema.parse({ repositories: {
  a: { name: 'A', provider: 'github', fullName: 'org/a', accessProfileId: 'shared', executorProfileId: 'fast', enabled: true },
}, accessProfiles: { shared: { name: 'Shared', kind: 'github-cli', cli: '/bin/gh-shared' } }, executorProfiles: {
  fast: { name: 'Fast', model: { provider: 'p', model: 'm' }, directory: '/workers/a', prepare: 'prepare-a', blockedCommands: ['curl'] },
}, scheduler: { maxWorkers: 3, maxWorkersPerRepository: 1 } })
const ticket = () => ({ id: 'ticket-a', repository: 'a', routing: { sourceInstanceId: 'github-a', basis: 'source', configurationRevision: 7 } }) as Ticket
const execution = { name: 'fix-a', directory: '/legacy/fix-a', assignment: 'fix' }

describe('fixed repository execution plans', () => {
  it('pins profile fields before launching and does not follow later profile edits', () => {
    const settings = configured(), t = ticket()
    const result = plannedExecution(t, execution, settings, '/state')
    expect(result.directory).toBe('/workers/a/a/fix-a')
    expect(result.plan).toMatchObject({ repositoryId: 'a', repository: 'org/a', configurationRevision: 7,
      model: { provider: 'p', model: 'm' }, prepare: 'prepare-a', blockedCommands: ['curl'] })
    settings.executorProfiles.fast!.prepare = 'changed'
    settings.executorProfiles.fast!.blockedCommands.push('wget')
    expect(plannedExecution({ ...t, execution: result }, result, settings, '/state')).toBe(result)
    expect(result.plan!.prepare).toBe('prepare-a')
    expect(result.plan!.blockedCommands).toEqual(['curl'])
  })
  it('pins the base branch for prepare variables and leaves unspecified plans on the remote default', () => {
    const settings = configured(), t = ticket()
    const sources = new SourceRegistry(() => settings), deployment = testDeployment()
    const branch = () => ticketEnvironment({ deployment, sources, settings, ticket: t }).find(item => item.key === 'DSH_SUPERAGENT_BRANCH')?.value
    expect(branch()).toBe('')
    settings.repositories.a!.defaultBranch = 'release/1'
    expect(branch()).toBe('release/1') // Legacy ticket without a plan.
    t.execution = plannedExecution(t, execution, settings, '/state')
    expect(t.execution.plan!.defaultBranch).toBe('release/1')
    settings.repositories.a!.defaultBranch = 'release/2'
    expect(branch()).toBe('release/1')
    delete t.execution.plan!.defaultBranch
    expect(branch()).toBe('') // Existing plans never acquire a newly configured branch.
  })
  it('preserves historical directories while adding a plan', () => {
    expect(plannedExecution({ ...ticket(), execution }, execution, configured(), '/state').directory).toBe('/legacy/fix-a')
  })
  it('refuses disabled repositories and revoked access bindings', () => {
    const settings = configured(), t = ticket()
    t.execution = plannedExecution(t, execution, settings, '/state')
    settings.repositories.a!.enabled = false
    expect(repositoryExecutionProblem(settings, t)).toContain('disabled')
    settings.repositories.a!.enabled = true
    settings.repositories.a!.accessProfileId = 'other'
    expect(repositoryExecutionProblem(settings, t)).toContain('revoked')
  })
  it('fails closed without ordinary Session env injection and uses the installed baseline', () => {
    const settings = configured(), t = ticket()
    expect(workerEnvironmentProblem(settings, t, '/bin/gh-shared', ['curl'])).toBeUndefined()
    expect(workerEnvironmentProblem(settings, t, '/bin/other', ['curl'])).toContain('accounts')
    expect(workerEnvironmentProblem(settings, t, '/bin/gh-shared', [])).toContain('blockedCommands')
    expect(workerEnvironmentProblem(settings, t, undefined, ['curl'])).toContain('unverified')
  })
})

it('reserves global and repository slots synchronously including human wakes', () => {
  const running = ['a1']
  const slots = new WorkerSlots(() => running, () => 3, id => id[0], () => 1, () => true)
  expect(() => slots.reserve('a2', 'person')).toThrow('repository')
  slots.reserve('b1', 'launch')
  expect(() => slots.reserve('b2', 'launch')).toThrow('repository')
  slots.reserve('c1', 'wake')
  expect(() => slots.reserve('d1', 'launch')).toThrow('worker slot')
  expect(() => slots.reserve('d1', 'person')).toThrow('worker slot')
  slots.free('b1')
  slots.reserve('b2', 'launch')
  expect(slots.used()).toBe(3)
})

it('binds named GitHub origin variables without trusting unrelated source metadata', () => {
  const settings = configured(), t = ticket()
  settings.sources['github-a'] = { kind: 'github', repositoryId: 'a', enabled: true, config: {} }
  const sources = new SourceRegistry(() => settings)
  sources.register(githubKind)
  const deployment = testDeployment({ repository: 'org/a' })
  const trigger = { source: 'github-a', meta: { number: 42, isPr: true } } as unknown as Trigger
  const values = (origin: Trigger) => Object.fromEntries(ticketEnvironment({ deployment, sources, settings, ticket: t, trigger: origin }).map(item => [item.key, item.value]))
  expect(values(trigger)).toMatchObject({ DSH_SUPERAGENT_GITHUB_REPOSITORY: 'org/a', DSH_SUPERAGENT_GITHUB_NUMBER: '42', DSH_SUPERAGENT_GITHUB_PR_HEAD: 'refs/pull/42/head' })
  delete settings.sources['github-a']
  expect(values({ ...trigger, source: 'feishu-team' })).toMatchObject({ DSH_SUPERAGENT_GITHUB_REPOSITORY: 'org/a', DSH_SUPERAGENT_GITHUB_NUMBER: '', DSH_SUPERAGENT_GITHUB_PR_HEAD: '' })
})

it('never trusts a partial workspace or recreates a missing prepared workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multirepo-executor-'))
  try {
    const settings = configured(), t = ticket()
    settings.executorProfiles.fast!.directory = root
    t.execution = plannedExecution(t, execution, settings, root)
    t.origin = { triggerId: 'missing' } as Ticket['origin']
    const assignment = { id: 'assignment-1', state: 'pending' } as Ticket['assignments'][number]
    t.assignments = [assignment]
    const ensure = vi.fn()
    const host = { store: { settings: () => settings, tickets: { get: () => t, open: () => [], save: vi.fn() }, triggers: { get: () => undefined } },
      context: {}, machine: { stateDir: root }, effects: { handle: vi.fn() }, sessions: { ensure },
      executionProblem: () => undefined, closing: () => false, paused: () => false } as unknown as ExecutorHost
    const executor = new DshExecutor(host) as unknown as { launch(ticket: Ticket, assignment: Ticket['assignments'][number]): Promise<void> }
    await mkdir(t.execution.directory, { recursive: true })
    await expect(executor.launch(t, assignment)).rejects.toThrow('without a successful preparation record')
    t.execution.plan!.preparedAt = new Date().toISOString()
    t.execution.directory = join(root, 'missing')
    t.execution.plan!.directory = t.execution.directory
    await expect(executor.launch(t, assignment)).rejects.toThrow('prepared worker workspace is missing')
    settings.repositories.a!.enabled = false
    await expect(executor.launch(t, assignment)).rejects.toThrow('disabled')
    expect(ensure).not.toHaveBeenCalled()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('records legacy workspace readiness atomically before a pause interrupts its first planned launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multirepo-legacy-'))
  try {
    const settings = configured()
    let t = { ...ticket(), execution: { ...execution, directory: root }, origin: { triggerId: 'missing' },
      assignments: [{ id: 'assignment-1', state: 'pending' }] } as Ticket
    let paused = false, interrupt = true
    const ensure = vi.fn(async () => { throw new Error('Reached persistent Session') })
    const subprocess = { spawn: vi.fn(() => {
      if (interrupt) paused = true
      return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: '' }) } } }
    }) }
    const host = { store: { settings: () => settings, tickets: { get: () => t, open: () => [], save: (value: Ticket) => { t = value } }, triggers: { get: () => undefined } },
      context: { subprocess }, machine: { stateDir: root }, effects: { handle: vi.fn() }, sessions: { ensure }, lifetime: new AbortController().signal,
      executionProblem: () => undefined, closing: () => false, paused: () => paused } as unknown as ExecutorHost
    const executor = new DshExecutor(host) as unknown as { launch(ticket: Ticket, assignment: Ticket['assignments'][number]): Promise<void> }
    await expect(executor.launch(t, t.assignments[0]!)).rejects.toThrow('paused')
    expect(t.execution!.plan!.preparedAt).toBeTruthy()
    expect(t.execution!.directory).toBe(root)
    paused = false; interrupt = false
    await expect(executor.launch(t, t.assignments[0]!)).rejects.toThrow('Reached persistent Session')
    expect(ensure).toHaveBeenCalledTimes(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('restores guards on already-loaded workers and children before setup is ready after restart', async () => {
  const h = await startRuntime()
  const restored: Sessions[] = []
  try {
    const accepted = await h.acceptedTicket(feishu('restore-guard', '@bot fix'))
    const worker = h.agents.get(accepted.sessionId)! as unknown as Agent
    const workerGuards = new Set<() => string | undefined>(), childGuards = new Set<() => string | undefined>()
    const capture = (guards: Set<() => string | undefined>) => (guard: () => string | undefined) => { guards.add(guard); return () => { guards.delete(guard) } }
    vi.mocked(worker.ctx.tools.guard).mockImplementation(guard => capture(workerGuards)(() => guard({} as never) as string | undefined))
    const childContext = new Context()
    childContext.reflect.provide('tools', { get: () => undefined, restrict: () => () => {}, guard: capture(childGuards) })
    const child = { id: 'existing-child', ctx: childContext, session: { header: { parentSession: worker.id } } } as unknown as Agent
    h.agents.set(child.id, child as never)
    // The production registry uses list(); retain the same Agent identities across plugin instances.
    const registry = h.ctx.agents as unknown as { list(): Agent[] }
    registry.list = () => [...h.agents.values()] as unknown as Agent[]
    let problem: string | undefined
    const host = { context: h.ctx, store: h.runtime.store, prompts: h.runtime.prompts,
      effects: { handle: vi.fn() }, health: { set: vi.fn() }, masterId: h.runtime.masterId,
      lifetime: new AbortController().signal, closing: () => false, environment: () => [], tools: () => [],
      executionProblem: () => problem } as unknown as SessionsHost
    const first = new Sessions(host); restored.push(first)
    await first.install()
    expect(workerGuards.size).toBe(1); expect(childGuards.size).toBe(1)
    first.dispose()
    expect(workerGuards.size).toBe(0); expect(childGuards.size).toBe(0)
    problem = 'Waiting for deployment setup'
    const next = new Sessions(host); restored.push(next)
    await next.install()
    expect([...workerGuards][0]!()).toBe(problem)
    expect([...childGuards][0]!()).toBe(problem)
    problem = 'Repository a is disabled'
    expect([...workerGuards][0]!()).toBe(problem)
    expect([...childGuards][0]!()).toBe(problem)
    expect(h.agents.get(accepted.sessionId)).toBe(worker)
  } finally {
    for (const sessions of restored) sessions.dispose()
    h.agents.delete('existing-child')
    await h.stop()
  }
})
