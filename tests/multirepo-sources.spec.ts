import { afterEach, describe, expect, it, vi } from 'vitest'
import { Setup, setupChanged, type SetupHost } from '../src/app/setup.ts'
import { SetupError } from '../src/setup.ts'
import * as deploymentModule from '../src/deployment.ts'
import * as environment from '../src/infra/environment.ts'
afterEach(() => vi.restoreAllMocks())
import { SettingsSchema } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { githubKind } from '../src/sources/github.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { issueTrigger, githubChannel } from '../src/sources/github-trigger.ts'
import { pullsOf } from '../src/sources/github-pull.ts'
import { KV } from '../src/kv.ts'
import { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { HealthBoard } from '../src/infra/health.ts'
import type { Trigger } from '../src/core/index.ts'

function fixture() {
  const repository = (fullName: string) => ({ name: fullName, provider: 'github', fullName, accessProfileId: 'access', executorProfileId: 'worker', enabled: true })
  const settings = SettingsSchema.parse({ repositories: { a: repository('org/a'), b: repository('org/b') }, sources: {
    'github-a': { kind: 'github', repositoryId: 'a', enabled: true, config: {} },
    'github-b': { kind: 'github', repositoryId: 'b', enabled: true, config: {} },
  } })
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => settings, board)
  sources.register(githubKind)
  const values = new Map<string, unknown>()
  const triggers: Trigger[] = []
  const deploymentFor = (id = 'a') => testDeployment({ repository: `org/${id}` })
  const commands = new Commands(() => deploymentFor(), {}, new AbortController().signal)
  const commandsFor = (id: string) => commands.forDeployment(() => deploymentFor(sources.instance(id)?.repositoryId))
  sources.bindAccess({ commands: commandsFor, links: id => deploymentFor(sources.instance(id)?.repositoryId) })
  const deps = {
    sources, commands, deployment: deploymentFor(), deploymentFor, commandsFor, ready: Promise.resolve(), configured: () => true,
    receive: (trigger: Trigger) => { triggers.push(trigger) },
    store: { get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, value), delete: (key: string) => values.delete(key),
      keys: () => [], atomic: (work: () => unknown) => work(), tickets: { get: () => ({ repository: 'b' }), open: () => [{ repository: 'a' }, { repository: 'b' }] },
      threads: { describe: vi.fn(), patchMeta: vi.fn() }, read: { subscribedThreads: vi.fn(() => []) } },
    engine: { bindThread: vi.fn(), threadClosed: vi.fn() }, outbox: { send: vi.fn() },
  } as unknown as SourceContextDeps
  const context = (id: string) => sourceContextOf(deps, { kind: 'github', id, health: ['github'] })
  return { settings, sources, context, values, triggers, board, deps }
}
const issue = () => issueTrigger({ number: 42, title: 'Fix', body: '@bot fix', user: { login: 'alice' }, created_at: '2026-01-01', html_url: 'https://github.com/org/a/issues/42' }, 'bot')

describe('multi-repository sources', () => {
  it('restarts for profile command policy changes, not execution prompt or directory changes', () => {
    const before = SettingsSchema.parse({ executorProfiles: { worker: { name: 'Worker', model: null, directory: '/work', prepare: '', blockedCommands: ['sudo'] } } })
    const after = SettingsSchema.parse(before)
    after.executorProfiles.worker!.directory = '/other'
    after.executorProfiles.worker!.prepare = 'echo ready'
    expect(setupChanged(before, after)).toBe(false)
    after.executorProfiles.worker!.blockedCommands.push('curl')
    expect(setupChanged(before, after)).toBe(true)
  })
  it('does not require an implicit legacy GitHub account to save named topology', async () => {
    const h = fixture()
    const probe = vi.spyOn(deploymentModule, 'resolveDeployment')
    const setup = new Setup({ machine: testDeployment(), context: {}, lifetime: new AbortController().signal, restart: vi.fn() } as unknown as SetupHost)
    await setup.checkAccounts('topology', h.settings)
    expect(probe).not.toHaveBeenCalled()
  })
  it('localizes an inaccessible repository while installing only the healthy baseline', async () => {
    const h = fixture()
    h.settings.accessProfiles.access = { name: 'Access', kind: 'github-cli', cli: '/bin/false' }
    vi.spyOn(deploymentModule, 'resolveDeployment').mockImplementation(async (_machine, config) => {
      const repository = (config as { repository: string }).repository
      if (repository === 'org/b') throw new SetupError('repositoryUnreadable', { account: 'bot', repository, output: 'denied' })
      return testDeployment({ repository })
    })
    vi.spyOn(deploymentModule, 'resolveFeishuBot').mockResolvedValue(undefined)
    const write = vi.spyOn(environment, 'writeEnvironment').mockResolvedValue(undefined)
    vi.spyOn(environment, 'verifyEnvironment').mockResolvedValue(undefined)
    vi.spyOn(environment, 'applyEnvironment').mockReturnValue(() => {})
    const setup = new Setup({ machine: testDeployment(), context: { logger: { warn: vi.fn() }, subprocess: {} }, lifetime: new AbortController().signal, restart: vi.fn() } as unknown as SetupHost)
    expect(await setup.run(h.settings)).toBe(true)
    expect(setup.configured('a')).toBe(true)
    expect(setup.configured('b')).toBe(false)
    expect(setup.deploymentFor('a').repository).toBe('org/a')
    expect(() => setup.deploymentFor('b')).toThrow('unavailable')
    expect(setup.problemFor('b')?.detail).toContain('denied')
    expect(setup.problem).toBeUndefined()
    expect(write).toHaveBeenCalledTimes(1)
    expect(setup.baselineBlockedCommands).toEqual(h.settings.executor.blockedCommands)
    setup.restore()
  })
  it('separates instance IDs, config, URL lookups and repository deployment', () => {
    const h = fixture()
    expect(h.sources.kind('github-a')).toBe(githubKind)
    expect(h.sources.instance('github-b')).toMatchObject({ kind: 'github', id: 'github-b', repositoryId: 'b' })
    expect(h.context('github-b').commands.repository).toBe('org/b')
    expect(h.sources.find('https://github.com/org/b/issues/42').threads).toEqual(['github-b:42'])
    expect(h.sources.link({ ...githubChannel(42), source: 'github-b' }, { repository: 'wrong/repo' }).url).toBe('https://github.com/org/b/issues/42')
  })
  it('isolates cursors, triggers, thread keys, notices and health while preserving legacy IDs', async () => {
    const h = fixture(); const a = h.context('github-a'); const b = h.context('github-b'); const legacy = h.context('github')
    a.state.set(KV.github.since, 'a'); b.state.set(KV.github.since, 'b'); legacy.state.set(KV.github.since, 'old')
    expect(a.state.get(KV.github.since)).toBe('a'); expect(b.state.get(KV.github.since)).toBe('b')
    expect(h.values.get('github-since')).toBe('old')
    await a.receive(issue()); await b.receive(issue()); await legacy.receive(issue())
    expect(new Set(h.triggers.map(trigger => trigger.id)).size).toBe(3)
    expect(h.triggers[0]?.channel?.thread).toBe('github-a:42')
    expect(h.triggers[2]?.id).toBe(issue().id)
    a.report('github', { state: 'error', detail: 'a failed' }); b.report('github', { state: 'ready', detail: '' })
    expect(h.board.all['github-a:github']?.state).toBe('error'); expect(h.board.all['github-b:github']?.state).toBe('ready')
    a.notify({ id: 'same', channel: githubChannel(42), text: 'a', kind: 'notice' })
    b.notify({ id: 'same', channel: githubChannel(42), text: 'b', kind: 'notice' })
    const calls = vi.mocked(h.deps.outbox.send).mock.calls
    expect(calls[0]?.[0].id).not.toBe(calls[1]?.[0].id)
    expect(calls[1]?.[0].channel.source).toBe('github-b')
  })
  it('stops an old listener when its repository binding changes', () => {
    const h = fixture(); const a = h.context('github-a')
    h.settings.sources['github-a']!.repositoryId = 'b'
    expect(a.config('github')).toBeUndefined()
    expect(() => a.receive(issue())).toThrow('binding changed')
    expect(h.triggers).toEqual([])
  })
  it('keeps PR follows and ticket lookup within a repository', () => {
    const h = fixture(); const a = h.context('github-a')
    expect(a.tickets.open()).toEqual([{ repository: 'a' }])
    expect(a.tickets.get('foreign')).toBeUndefined()
    expect(pullsOf({ follows: [{ thread: 'github-a:42', own: true }, { thread: 'github-b:42', own: true }] }, true, 'github-a')).toEqual([42])
    expect(() => a.tickets.bindThread('foreign', { source: 'github', id: '42' }, true)).toThrow('another repository')
  })
  it('dispatches outbound messages and context reads using the instance account', async () => {
    const h = fixture()
    const send = vi.spyOn(githubKind.channel!, 'send').mockResolvedValue('sent')
    const read = vi.spyOn(githubKind.threadContext!, 'read').mockResolvedValue({ messages: [], body: {} })
    for (const source of ['github-a', 'github-b']) {
      await h.sources.send({ id: source, channel: { ...githubChannel(42), source }, text: source, kind: 'notice' }, h.deps.commands)
      await h.sources.threadContext({ ...issue(), source })!.read(h.deps.commands, 'thread')
    }
    expect(send.mock.calls.map(call => call[0].commands.repository)).toEqual(['org/a', 'org/b'])
    expect(read.mock.calls.map(call => call[0].repository)).toEqual(['org/a', 'org/b'])
  })
  it.each(['github-b', 'feishu-team'])('preserves caller cancellation through the %s context reader', async source => {
    const h = fixture()
    h.settings.sources['feishu-team'] = { kind: 'feishu', enabled: true, config: {} }
    h.sources.register(feishuKind)
    const kind = source === 'github-b' ? githubKind : feishuKind
    vi.spyOn(kind.threadContext!, 'read').mockImplementation(async (commands: Commands) => {
      await commands.run(process.execPath, ['-e', 'setTimeout(() => {}, 300)'])
      return { messages: [], body: {} }
    })
    const controller = new AbortController()
    const read = h.sources.threadContext({ ...issue(), source })!.read(h.deps.commands.withSignal(controller.signal), 'thread')
    controller.abort()
    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('preserves caller command environment while rebinding deployment', async () => {
    const h = fixture()
    const caller = new Commands(() => testDeployment(), { DSH_SOURCE_TEST_VALUE: 'caller-env' }, new AbortController().signal)
    const commands = h.sources.commands('github-b', caller)
    expect(commands.repository).toBe('org/b')
    expect(await commands.run(process.execPath, ['-e', 'process.stdout.write(process.env.DSH_SOURCE_TEST_VALUE ?? "missing")'])).toBe('caller-env')
  })
  it('does not send or read through an unbound managed instance', async () => {
    const h = fixture(); const unbound = new SourceRegistry(() => h.settings); unbound.register(githubKind)
    await expect(unbound.send({ id: 'x', channel: { ...githubChannel(42), source: 'github-b' }, text: 'x', kind: 'notice' }, h.deps.commands)).rejects.toThrow('not bound')
    h.settings.repositories.b!.enabled = false
    expect(h.sources.scope({ source: 'github-b', meta: {} }).listened).toBe(false)
    expect(h.sources.scope({ source: 'github-a', meta: {} }).listened).toBe(true)
  })
})
