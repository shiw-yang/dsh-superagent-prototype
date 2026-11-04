// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { TopologySchema, type Topology } from '../src/policy.ts'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, click, type, field, text, at, find } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
function topologyServer() {
  let revision = 4
  let value: Topology = { repositories: { api: { name: 'API', provider: 'github', fullName: 'acme/api', enabled: true,
    executorProfileId: 'worker', accessProfileId: 'account' } }, executorProfiles: {
    worker: { name: 'Worker', model: null, directory: '/work', prepare: '', blockedCommands: [] } }, accessProfiles: {
    account: { name: 'Account', kind: 'github-cli', cli: 'gh' } }, scheduler: { maxWorkers: 3 }, sources: {
    'github-api': { kind: 'github', enabled: true, repositoryId: 'api', config: {} } } }
  const saves: { revision: number; value: Topology }[] = []
  let reject: 'conflict' | 'invalid' | undefined
  const original = fetch
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.endsWith('/settings/topology')) {
      const body = JSON.parse(String(init?.body)) as { revision: number; value: Topology }
      saves.push(body)
      if (reject === 'conflict') { reject = undefined; revision++; value = { ...value, repositories: {
        ...value.repositories, api: { ...value.repositories.api!, enabled: false } } }
        return new Response(JSON.stringify({ error: 'Settings changed' }), { status: 409 }) }
      if (reject === 'invalid') return new Response(JSON.stringify({ error: 'Invalid settings', issues: [
        { path: 'repositories.api.executorProfileId', message: 'Profile not found' }] }), { status: 400 })
      expect(body.revision).toBe(revision)
      value = TopologySchema.parse(body.value); revision++
      return new Response(JSON.stringify({ revision, restarting: false }))
    }
    const response = await original(url, init)
    if (url.endsWith('/settings') && init?.method === 'GET') {
      return new Response(JSON.stringify({ ...JSON.parse(await response.text()), topology: { revision, value } }))
    }
    return response
  })
  return { saves, get value() { return value }, reject: (next: typeof reject) => { reject = next } }
}
const scopedField = (section: string, label: string) => {
  const root = document.querySelector(`section[aria-label="${section}"]`)!
  const id = [...root.querySelectorAll('label')].find(item => item.textContent === label)!.htmlFor
  return document.getElementById(id) as HTMLInputElement
}
async function open() {
  at({ page: 'settings', query: { group: 'source' } })
  await mount(en)
  // Use the settings navigation rather than depending on the default section.
  const source = [...document.querySelectorAll<HTMLElement>('.dt-settings-link')].find(item => item.textContent === en['tab.source'])
  if (source) await click(source)
}
it('edits repository/profile/access/source forms and saves topology atomically with its CAS revision', async () => {
  const api = topologyServer()
  await open()
  expect(text()).toContain('Multi-repository configuration')
  expect(scopedField('Repositories', 'GitHub repository (owner/repo)').readOnly).toBe(true)
  expect((find('Remove api') as HTMLButtonElement).disabled).toBe(true)
  expect((find('Remove github-api') as HTMLButtonElement).disabled).toBe(true)
  expect(field<HTMLSelectElement>('Source kind').disabled).toBe(true)
  expect(field<HTMLSelectElement>('Bound repository').disabled).toBe(true)
  await type(scopedField('Repositories', 'Name'), 'API v2')
  await type(scopedField('Access profiles', 'CLI executable or account wrapper'), '/tools/gh-account')
  await type(scopedField('Executor profiles', 'Working directory'), '/work/api')
  await click('Enable repository api')
  await type(field('Source routes ID'), 'github-web')
  await click('Add Source routes')
  const kindLabel = [...document.querySelectorAll('label')].filter(label => label.textContent === 'Source kind')[1]!
  const kinds = document.getElementById(kindLabel.htmlFor) as HTMLSelectElement
  expect([...kinds.options].filter(option => !option.disabled).map(option => option.value)).toEqual(['github'])
  expect(text()).toContain('only the default feishu instance')
  const binding = [...document.querySelectorAll('label')].filter(label => label.textContent === 'Bound repository')[1]!
  await type(document.getElementById(binding.htmlFor) as HTMLSelectElement, 'api')
  await type(field('Repositories ID'), 'web')
  await click('Add Repositories')
  await click('Remove web')
  await click(en.save)
  expect(api.saves).toHaveLength(1)
  expect(api.saves[0]?.revision).toBe(4)
  expect(api.value.repositories.api).toMatchObject({ name: 'API v2', fullName: 'acme/api', enabled: false })
  expect(api.value.accessProfiles.account?.cli).toBe('/tools/gh-account')
  expect(api.value.executorProfiles.worker?.directory).toBe('/work/api')
  expect(api.value.sources['github-web']).toMatchObject({ kind: 'github', enabled: false })
})
it('creates a complete repository with reusable profiles and a bound GitHub source accepted by the real topology schema', async () => {
  const api = topologyServer()
  await open()
  for (const [section, id] of [['Access profiles', 'second-account'], ['Executor profiles', 'second-worker'], ['Repositories', 'web']]) {
    await type(field(`${section} ID`), id!)
    await click(`Add ${section}`)
  }
  const last = (label: string) => document.getElementById([...document.querySelectorAll('label')]
    .filter(item => item.textContent === label).at(-1)!.htmlFor) as HTMLInputElement
  await type(last('GitHub repository (owner/repo)'), 'acme/web')
  await type(last('Executor profiles'), 'second-worker')
  await type(last('Access profiles'), 'second-account')
  await type(last('Default branch'), 'main')
  await type(last('Default branch'), '') // Clearing optional fields must omit them, not send invalid empty strings.
  await type(field('Source routes ID'), 'github-web')
  await click('Add Source routes')
  await type(last('Bound repository'), 'web')
  await click('Enable source github-web')
  await click(en.save)
  expect(api.saves).toHaveLength(1)
  expect(api.value.repositories.web).toMatchObject({ fullName: 'acme/web', accessProfileId: 'second-account', executorProfileId: 'second-worker' })
  expect(api.value.repositories.web?.defaultBranch).toBeUndefined()
  expect(api.value.sources['github-web']).toMatchObject({ kind: 'github', enabled: true, repositoryId: 'web' })
})
it('edits source allowlists, default and chat routing without JSON, and shares the editor on Execution', async () => {
  const api = topologyServer()
  await open()
  await type(field<HTMLSelectElement>('Default target repository'), 'api')
  await click(document.querySelector<HTMLInputElement>('section[aria-label="Source routes"] input[type="checkbox"]')!)
  await type(field('Chat routes ID'), 'oc_team_123')
  await click('Add Chat routes')
  await type(field<HTMLSelectElement>('Target repository'), 'api')
  await type(field('Global worker limit'), '5')
  await type(field('Per-repository worker limit (optional)'), '2')
  await click(en.save)
  expect(api.value.sources['github-api']?.routing).toEqual({ defaultRepositoryId: 'api', allowedRepositoryIds: ['api'],
    chats: { oc_team_123: 'api' } })
  expect(api.value.scheduler).toEqual({ maxWorkers: 5, maxWorkersPerRepository: 2 })
  const execution = [...document.querySelectorAll<HTMLElement>('.dt-settings-link')]
    .find(item => item.textContent === en['promptPart.runtime/work'])!
  await click(execution)
  expect(text()).toContain('Multi-repository configuration')
  expect(text()).toContain('installation baseline')
})
it('retains the draft and displays validation errors without losing registry entries', async () => {
  const api = topologyServer(); api.reject('invalid')
  await open()
  await click('Remove worker')
  await click(en.save)
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('repositories.api.executorProfileId')
  expect(api.value.executorProfiles.worker).toBeDefined()
  await click(en.discard)
  expect(text()).toContain('Remove worker')
})
it('reloads and rebases on CAS failure without silently overwriting newer configuration', async () => {
  const api = topologyServer(); api.reject('conflict')
  await open()
  await type(scopedField('Repositories', 'Name'), 'Local API')
  await click(en.save)
  expect(api.saves).toHaveLength(1)
  expect(text()).toContain(en.saveMerged)
  expect((find('Enable repository api')).getAttribute('aria-checked')).toBe('false')
  await click(en.save)
  expect(api.saves[1]?.revision).toBe(5)
  expect(api.value.repositories.api).toMatchObject({ name: 'Local API', fullName: 'acme/api', enabled: false })
})
it('shows immutable repository targets on Ticket lists and detail while legacy Tickets remain unmarked', async () => {
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, repository: 'api' }
  server.tickets.open = server.tickets.open.map(ticket => ticket.id === 't1' ? { ...ticket, repository: 'api' } : ticket)
  await mount()
  await click(zh['tab.execution'])
  expect(document.querySelector('[title="目标仓库"]')?.textContent).toBe('api')
  await click('修复回归')
  expect(document.querySelector('.dt-status-line [title="目标仓库"]')?.textContent).toBe('api')
})
