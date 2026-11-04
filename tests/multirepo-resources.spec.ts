/** Cross-repository resource reads must retain the selected account and never guess a Router target. */
import { expect, it, vi } from 'vitest'
import { readResource, type ResourceHost } from '../src/app/resources.ts'
import { TextCache } from '../src/app/cache.ts'
import { ticketGithubSource } from '../src/app/runtime.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Commands } from '../src/infra/commands.ts'
import type { Ticket } from '../src/core/index.ts'

function fixture() {
  const settings = SettingsSchema.parse({
    repositories: {
      web: { name: 'Web', provider: 'github', fullName: 'acme/web', accessProfileId: 'agent', executorProfileId: 'node', enabled: true },
      api: { name: 'API', provider: 'github', fullName: 'acme/api', accessProfileId: 'agent', executorProfileId: 'node', enabled: true },
    },
    sources: { 'github-web': { kind: 'github', repositoryId: 'web', enabled: true, config: {} },
      'github-api': { kind: 'github', repositoryId: 'api', enabled: true, config: {} } },
  })
  const command = (name: string) => {
    const api = vi.fn(async (_schema: unknown, path: string) => path.includes('/comments')
      ? Array.from({ length: 20 }, (_, id) => ({ id, body: name, user: { login: 'alice' }, created_at: '2026-01-01T00:00:00Z' }))
      : { number: 42, title: name, body: name, state: 'open', user: { login: 'alice' } })
    const value = { api, withSignal: () => value } as unknown as Commands
    return { value, api }
  }
  const web = command('Web'), api = command('API'), legacy = command('Legacy')
  let ticket = { id: 't1', repository: 'web' } as Ticket
  const host = {
    store: { settings: () => settings, tickets: { get: (id: string) => id === ticket.id ? ticket : undefined } },
    pages: new TextCache(10_000), masterId: 'router', commands: legacy.value,
    commandsFor: vi.fn((id: string) => id === 'github-api' ? api.value : web.value),
    commandsForRepository: vi.fn((id: string) => id === 'api' ? api.value : web.value),
  } as unknown as ResourceHost
  const read = (resource: string, worker?: string, offset = 0) => readResource(host, resource, offset, 8000, worker)
  return { settings, host, web, api, legacy, read, unbind: () => { ticket = { id: 't1' } as Ticket } }
}

it('selects the actual PR source instead of the first source on the same repository', () => {
  const sources = [{ id: 'github-old', kind: 'github', repositoryId: 'web', enabled: false },
    { id: 'github-new', kind: 'github', repositoryId: 'web', enabled: true }]
  const ticket = { repository: 'web', follows: [{ thread: 'github-new:42', own: true }] } as Ticket
  expect(ticketGithubSource(ticket, sources, 'github-new')).toBe('github-new')
  expect(ticketGithubSource({ ...ticket, ended: { at: '2026-01-01', by: 'executor', outcome: 'merged' },
    follows: [{ thread: 'github-new:42', own: true, closed: { at: '2026-01-01', outcome: 'merged' } }] }, sources)).toBe('github-new')
  expect(ticketGithubSource({ repository: 'web' } as Ticket, sources, 'feishu')).toBe('github-new')
})

it('preserves a historical PR source and refuses ambiguous new GitHub bindings', () => {
  const sources = [{ id: 'github-old', kind: 'github', repositoryId: 'web', enabled: false },
    { id: 'github-new', kind: 'github', repositoryId: 'web', enabled: true }]
  const ticket = { repository: 'web', follows: [{ thread: 'github-old:42', own: true }] } as Ticket
  expect(ticketGithubSource(ticket, sources)).toBe('github-old')
  expect(ticketGithubSource({ repository: 'web' } as Ticket, sources.map(source => ({ ...source, enabled: true })))).toBeUndefined()
})

it('requires an explicit source for a Router GitHub read when repositories are plural', async () => {
  const f = fixture()
  await expect(f.read('github/issues/42')).rejects.toThrow('Name the GitHub source instance')
  expect(f.legacy.api).not.toHaveBeenCalled()
})

it('reads the identical issue number from the selected source repository', async () => {
  const f = fixture()
  const page = await f.read('github/github-api/issues/42') as { text: string }
  expect(JSON.parse(page.text)).toMatchObject({ number: 42, title: 'API' })
  expect(f.api.api).toHaveBeenCalled()
  expect(f.web.api).not.toHaveBeenCalled()
  expect(f.legacy.api).not.toHaveBeenCalled()
})

it('binds bare worker GitHub resources to the ticket repository', async () => {
  const f = fixture()
  const page = await f.read('github/issues/42', 't1') as { text: string }
  expect(JSON.parse(page.text)).toMatchObject({ title: 'Web' })
  expect(f.host.commandsForRepository).toHaveBeenCalledWith('web')
  expect(f.legacy.api).not.toHaveBeenCalled()
})

it('rejects explicit cross-repository worker reads including attempts to read cached pages', async () => {
  const f = fixture()
  await f.read('github/github-api/issues/42')
  await expect(f.read('github/github-api/issues/42', 't1')).rejects.toThrow('outside this ticket repository')
  await expect(f.read('github/github-api/issues/42', 't1', 10)).rejects.toThrow('outside this ticket repository')
})

it('retains the source identity on paginated GitHub resources', async () => {
  const f = fixture()
  const page = await f.read('github/github-api/issues/42/comments/1') as { text: string }
  expect(JSON.parse(page.text).next_resource).toBe('github/github-api/issues/42/comments/2')
})

it('fails closed for unmapped historical tickets and unknown source instances', async () => {
  const f = fixture()
  f.unbind()
  await expect(f.read('github/issues/42', 't1')).rejects.toThrow('no verified repository')
  await expect(f.read('github/missing/issues/42')).rejects.toThrow('Unknown GitHub source instance')
})
