/** Worker evidence flows through the real tool, Engine, SQLite and read surfaces without becoming independent acceptance. */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ReportBriefSchema, VerificationSchema } from '../src/app/tools/executor.ts'
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

it('persists a concise brief with its snapshot and latest report, and relays it without manufacturing attention', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('6', '@bot convert CSV'))
  const brief = { conclusion: 'CSV generated but not usable yet', blockers: ['9 ratios rejected'], next_steps: ['User: choose how to handle 9 rows'] }
  const storedBrief = { conclusion: brief.conclusion, blockers: brief.blockers, nextSteps: brief.next_steps }
  const summary = 'Complete technical details: '.repeat(100)
  await h.runTool(sessionId, 'orchestrator_report', { state: 'blocked', summary, brief, verification: evidence() })
  await h.runtime.idle()
  const stored = h.runtime.store.tickets.get(ticket.id)!
  expect(stored.attention).toBeUndefined()
  expect(stored.assignments.at(-1)!.report).toMatchObject({ summary, brief: storedBrief })
  expect(stored.verificationReports!.at(-1)).toMatchObject({ summary, brief: storedBrief })
  const response = await h.api('GET', `tickets/${ticket.id}`)
  expect(response.body.verificationReports).toEqual(stored.verificationReports)
  expect(h.relays(h.runtime.masterId)).toContainEqual(expect.objectContaining({ kind: 'worker_report', brief: storedBrief }))
  const page = await h.runTool(sessionId, 'orchestrator_read', { resource: `ticket/${ticket.id}/verification`, limit: 8000 }) as { text: string }
  expect(JSON.parse(page.text).reports[0].brief).toEqual(storedBrief)
  const { join } = await import('node:path')
  const path = join(h.directory, 'brief.sqlite')
  const db = new Store(path); db.tickets.save(stored); db.close()
  const reopened = new Store(path)
  try { expect(reopened.tickets.get(ticket.id)!.verificationReports!.at(-1)!.brief).toEqual(storedBrief) }
  finally { reopened.close() }
})

it('does not reuse an earlier brief when a later report omits it', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('7', '@bot repair'))
  const brief = { conclusion: 'Earlier result', next_steps: ['Worker: rerun checks'] }
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Earlier details', brief, verification: evidence() })
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'New work without brief', verification: evidence('new') })
  const stored = h.runtime.store.tickets.get(ticket.id)!
  expect(stored.assignments.at(-1)!.report).not.toHaveProperty('brief')
  expect(stored.verificationReports!.at(-1)).not.toHaveProperty('brief')
  expect(stored.verificationReports![0]!.brief?.conclusion).toBe('Earlier result')
})

it.each([
  { conclusion: '结'.repeat(81) },
  { conclusion: 'Outcome', blockers: ['阻'.repeat(101)] },
  { conclusion: 'Outcome', blockers: ['a', 'b', 'c', 'd'] },
  { conclusion: 'Outcome', next_steps: ['步'.repeat(101)] },
  { conclusion: 'Outcome', next_steps: ['a', 'b', 'c', 'd'] },
  { conclusion: '   ' },
])('keeps report and evidence when the presentation brief exceeds limits: %j', async brief => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('8', '@bot repair'))
  const result = await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Full details', brief, verification: evidence() })
  expect(result).toMatchObject({ reported: true, brief_warning: expect.stringContaining('Report and evidence saved') })
  const report = h.runtime.store.tickets.get(ticket.id)!.verificationReports![0]!
  expect(report).not.toHaveProperty('brief')
  expect(report.summary).toContain('Full details')
  expect(report.summary).toContain(JSON.stringify(brief, null, 2))
  expect(report.verification).toEqual(evidence())
})

it('accepts the brief limits exactly and trims surrounding whitespace', () => {
  const brief = { conclusion: '结'.repeat(80), blockers: Array(3).fill('阻'.repeat(100)), next_steps: Array(3).fill('步'.repeat(100)) }
  expect(ReportBriefSchema.parse(brief)).toEqual(brief)
  expect(ReportBriefSchema.parse({ conclusion: ' done ', blockers: [], next_steps: [] })).toEqual({ conclusion: 'done', blockers: [], next_steps: [] })
})
