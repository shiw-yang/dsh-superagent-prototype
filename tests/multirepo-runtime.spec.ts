/** Runtime composition regression: routing, persisted plans, worker sessions and resource commands agree on one target. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SettingsSchema } from '../src/policy.ts'
import { Commands } from '../src/infra/commands.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => {
  h = await startRuntime()
  const current = h.runtime.store.settings()
  const base = h.runtime.setup.deployment
  const accessCli = String(current.sources.github!.config.cli)
  const profile = (name: string) => ({ name, model: null, directory: '', prepare: `printf '${name}-ready'`, blockedCommands: [] })
  h.runtime.store.saveSettings(SettingsSchema.parse({ ...current,
    repositories: {
      web: { name: 'Web', provider: 'github', fullName: 'acme/web', enabled: true, accessProfileId: 'agent', executorProfileId: 'node' },
      api: { name: 'API', provider: 'github', fullName: 'acme/api', enabled: true, accessProfileId: 'agent', executorProfileId: 'python' },
    },
    accessProfiles: { agent: { name: 'Agent', kind: 'github-cli', cli: accessCli } },
    executorProfiles: { node: profile('node'), python: profile('python') },
    sources: { ...current.sources, github: { ...current.sources.github!, enabled: false },
      'github-web': { kind: 'github', repositoryId: 'web', enabled: true, config: {} },
      'github-api': { kind: 'github', repositoryId: 'api', enabled: true, config: {} },
      feishu: { ...current.sources.feishu!, routing: { allowedRepositoryIds: ['web', 'api'], defaultRepositoryId: 'web' } } },
    scheduler: { maxWorkers: 3, maxWorkersPerRepository: 1 },
  }))
  // Per-repository deployment probing has its own integration tests. Supply two resolved deployments here to exercise Runtime glue without a live GitHub account.
  vi.spyOn(h.runtime.setup, 'configured').mockImplementation(id => !id || id === 'web' || id === 'api')
  vi.spyOn(h.runtime.setup, 'deploymentFor').mockImplementation(id => ({ ...base, repository: id ? `acme/${id}` : base.repository }))
})
afterEach(async () => { await h.stop() })

async function accept(id: string, repository: string) {
  const trigger = feishu(id, `@bot fix a regression in ${repository}`)
  h.runtime.receive(trigger)
  await h.runtime.idle()
  const result = await h.route({ kind: 'accept', trigger_id: trigger.id, repository, title: `Fix ${repository}`,
    worktree_name: 'fix-regression', acknowledgement: 'I will fix the regression.' })
  await h.runtime.idle()
  return h.runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
}

it('starts two repository-bound workers with distinct persisted plans, directories and prepare environments', async () => {
  const web = await accept('201', 'web'), api = await accept('202', 'api')
  expect(web).toMatchObject({ repository: 'web', mandate: { repository: 'web' },
    routing: { sourceInstanceId: 'feishu', basis: 'explicit', configurationRevision: expect.any(Number) },
    execution: { plan: { repository: 'acme/web', executorProfileId: 'node', prepare: "printf 'node-ready'", preparedAt: expect.any(String) } } })
  expect(api).toMatchObject({ repository: 'api', execution: { plan: { repository: 'acme/api', executorProfileId: 'python' } } })
  expect(web.execution!.directory).toContain('/work/web/')
  expect(api.execution!.directory).toContain('/work/api/')
  expect(h.agents.has(`worker-${web.id}`)).toBe(true)
  expect(h.agents.has(`worker-${api.id}`)).toBe(true)
  expect(h.relays(h.runtime.masterId)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'candidate',
    routing: expect.objectContaining({ sourceInstanceId: 'feishu', defaultRepositoryId: 'web',
      repositories: expect.arrayContaining([{ id: 'web', name: 'Web', fullName: 'acme/web' }, { id: 'api', name: 'API', fullName: 'acme/api' }]) }) })]))
  const commands = h.subprocess.spawn.mock.calls.map(([spec]) => spec as { argv: string[]; env?: Record<string, string> })
  expect(commands).toEqual(expect.arrayContaining([
    expect.objectContaining({ argv: ['sh', '-c', "printf 'node-ready'"], env: expect.objectContaining({ DSH_SUPERAGENT_GITHUB_REPOSITORY: 'acme/web' }) }),
    expect.objectContaining({ argv: ['sh', '-c', "printf 'python-ready'"], env: expect.objectContaining({ DSH_SUPERAGENT_GITHUB_REPOSITORY: 'acme/api' }) }),
  ]))
  expect((await h.api('GET', `tickets/${api.id}`)).body).toMatchObject({ repository: 'api', executionPlan: { repository: 'acme/api' } })
})

it('uses the worker repository for GitHub reads and refuses cross-repository reads through actual registered tools', async () => {
  const ticket = await accept('203', 'api')
  const seen: string[] = []
  vi.spyOn(Commands.prototype, 'api').mockImplementation(async function (this: Commands) {
    seen.push(this.repository)
    return { number: 42, title: this.repository, state: 'open', user: { login: 'alice' }, body: '' }
  } as never)
  const page = await h.runTool(`worker-${ticket.id}`, 'orchestrator_read', { resource: 'github/issues/42' })
  expect(JSON.parse(String(page.text)).title).toBe('acme/api')
  await expect(h.runTool(`worker-${ticket.id}`, 'orchestrator_read', { resource: 'github/github-web/issues/42' })).rejects.toThrow('outside this ticket repository')
  expect(seen).toEqual(['acme/api'])
})

it('keeps an incompatible execution identity queued and explains why without preparing a workspace', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, accessProfiles: { ...settings.accessProfiles,
    other: { name: 'Other', kind: 'github-cli', cli: '/not-the-installed-agent' } },
    repositories: { ...settings.repositories, api: { ...settings.repositories.api!, accessProfileId: 'other' } } })
  const ticket = await accept('204', 'api')
  expect(ticket.assignments.at(-1)?.state).toBe('pending')
  expect(h.agents.has(`worker-${ticket.id}`)).toBe(false)
  const page = await h.api('GET', `tickets/${ticket.id}`)
  expect(page.body.executionProblem).toMatch(/GitHub accounts\/CLI wrappers are unsupported/)
  expect(h.subprocess.spawn.mock.calls.some(([spec]) => spec.argv.includes("printf 'python-ready'"))).toBe(false)
})
