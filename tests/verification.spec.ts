/** Worker evidence flows through the real tool, Engine, SQLite and read surfaces without becoming independent acceptance. */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { VerificationSchema } from '../src/app/tools/executor.ts'
import { ticketDetail } from '../src/app/views/tickets.ts'
import { Store } from '../src/app/store.ts'
import { type Verification } from '../src/core/index.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
const evidence = (revision = 'abc123'): Verification => ({ revision, checks: [
  { criterion: 'Login reaches the home page', status: 'passed', method: 'Ran login.spec.ts: 3 tests passed',
    evidence: [{ label: 'Test run', url: 'https://example.com/runs/1' }] },
  { criterion: 'Safari login', status: 'not_run', method: 'Safari unavailable', notes: 'Needs browser validation' },
], unverified: ['Safari has not been tested'] })

it('stores complete snapshots, preserves them across ordinary reports, and exposes bounded evidence reads', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot fix login'))
  const report = (args: object) => h.runTool(sessionId, 'orchestrator_report', args)
  const first = evidence()
  first.checks[0]!.status = 'failed'
  await report({ state: 'progress', summary: 'Reproduced the failure', verification: first })
  await report({ state: 'progress', summary: 'Repairing login' })
  expect(h.runtime.store.tickets.get(ticket.id)!.verificationReports).toHaveLength(1)
  await report({ state: 'ready', summary: 'Login fixed; Safari unverified', verification: evidence('def456') })
  const stored = h.runtime.store.tickets.get(ticket.id)!
  expect(stored.verificationReports).toMatchObject([
    { assignmentId: ticket.assignments[0]!.id, state: 'progress', summary: 'Reproduced the failure',
      verification: { revision: 'abc123', checks: [{ status: 'failed' }, { status: 'not_run' }] } },
    { state: 'ready', verification: evidence('def456') },
  ])
  const detail = ticketDetail({ store: h.runtime.store, sources: h.runtime.sources,
    links: () => ({ url: 'https://example.com/thread', label: { en: 'Thread', zh: '线程' } }) }, ticket.id)!
  expect(detail.verificationReports).toEqual(stored.verificationReports)
  const response = await h.api('GET', `tickets/${ticket.id}`)
  expect(response.status).toBe(200)
  expect(response.body.verificationReports).toEqual(stored.verificationReports)
  const read = async (resource: string, offset = 0) => h.runTool(h.runtime.masterId, 'orchestrator_read', { resource, offset, limit: 100 }) as Promise<{ text: string; next_offset: number | null }>
  const resource = `ticket/${ticket.id}/verification`
  let body = '', offset: number | null = 0
  while (offset !== null) { const page = await read(resource, offset); body += page.text; offset = page.next_offset }
  expect(JSON.parse(body)).toMatchObject({ reported_by: 'worker', current_revision_checked: false,
    reports: [{ verification: { revision: 'def456' } }, { verification: { revision: 'abc123' } }] })
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: `ticket/${ticket.id}` }))
    .toMatchObject({ verification: { reported_by: 'worker', count: 2, read: resource } })
})

it('allows legacy reports without inventing evidence or passing checks', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('2', '@bot fix login'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Working' })
  expect(h.runtime.store.tickets.get(ticket.id)!.verificationReports).toBeUndefined()
  const page = await h.runTool(sessionId, 'orchestrator_read', { resource: `ticket/${ticket.id}/verification` }) as { text: string }
  expect(JSON.parse(page.text)).toEqual({ reported_by: 'worker', current_revision_checked: false, reports: [] })
})

it('does not let another worker read a ticket verification history', async () => {
  const first = await h.acceptedTicket(feishu('3', '@bot first'))
  const second = await h.acceptedTicket(feishu('4', '@bot second'))
  await expect(h.runTool(second.sessionId, 'orchestrator_read', { resource: `ticket/${first.ticket.id}/verification` }))
    .rejects.toThrow('Ticket does not belong to this worker')
})

it('keeps snapshots after closing and reopening the SQLite store', async () => {
  const { ticket } = await h.acceptedTicket(feishu('5', '@bot repair'))
  const value = evidence()
  h.runtime.engine.report(ticket.id, { state: 'progress', summary: 'Checked', verification: value })
  // A caller changing its argument later must not change recorded evidence.
  value.checks[0]!.criterion = 'Changed argument'
  const saved = h.runtime.store.tickets.get(ticket.id)!
  expect(saved.verificationReports![0]!.verification.checks[0]!.criterion).toBe('Login reaches the home page')
  const { join } = await import('node:path')
  const path = join(h.directory, 'evidence.sqlite')
  const store = new Store(path)
  store.tickets.save(saved)
  store.close()
  const reopened = new Store(path)
  try { expect(reopened.tickets.get(ticket.id)!.verificationReports).toEqual(saved.verificationReports) }
  finally { reopened.close() }
})

it('validates check states, nonempty methods and genuine HTTP(S) evidence links', () => {
  expect(VerificationSchema.parse(evidence())).toEqual(evidence())
  expect(VerificationSchema.safeParse({ checks: [] }).success).toBe(false)
  for (const status of ['approved', 'unknown']) {
    expect(VerificationSchema.safeParse({ checks: [{ criterion: 'x', method: 'test', status }] }).success).toBe(false)
  }
  expect(VerificationSchema.safeParse({ checks: [{ criterion: 'x', status: 'passed', method: ' ' }] }).success).toBe(false)
  for (const url of ['javascript:alert(1)', 'file:///tmp/results', 'not-a-url']) {
    const value = evidence(); value.checks[0]!.evidence![0]!.url = url
    expect(VerificationSchema.safeParse(value).success).toBe(false)
  }
  expect(VerificationSchema.parse({ checks: [{ criterion: 'x', status: 'not_run', method: 'No environment' }] })).not.toHaveProperty('revision')
})
