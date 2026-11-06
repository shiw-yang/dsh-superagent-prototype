/** Panel state must follow current worker activity without rewriting its last report. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { latestAssignment } from '../src/core/index.ts'
import { CHAT, feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-06T04:00:00Z') })
  h = await startRuntime()
})
afterEach(async () => { await h.stop(); vi.useRealTimers() })

const advance = () => { vi.setSystemTime(Date.now() + 1000) }
const idle = (sessionId: string) => {
  const agent = h.agents.get(sessionId)!
  agent.status = 'idle'
  h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
}
async function readyTicket() {
  const one = await h.acceptedTicket(feishu('1', '@bot 修复回归'))
  h.runtime.engine.bindThread(one.ticket.id, { source: 'github', id: '7' }, true)
  await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'PR ready for review' })
  return one
}
async function awaitingReview(one: Awaited<ReturnType<typeof readyTicket>>) {
  idle(one.sessionId)
  await h.runtime.idle()
  await vi.waitFor(() => expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.idleAt).toBeDefined())
  expect(await h.api('GET', `tickets/${one.ticket.id}`)).toMatchObject({ status: 200, body: { stage: 'person', action: 'review' } })
}
/** The overview, filters, detail, thread and search must all use the same current stage. */
async function expectWorking(ticketId: string) {
  for (const state of ['open', 'working']) {
    expect(await h.api('GET', `tickets?state=${state}&limit=100`)).toMatchObject({ status: 200,
      body: { total: 1, items: [{ id: ticketId, stage: 'working' }] } })
  }
  for (const state of ['person', 'idle']) {
    expect(await h.api('GET', `tickets?state=${state}&limit=100`)).toMatchObject({ status: 200, body: { total: 0, items: [] } })
  }
  expect(await h.api('GET', 'overview')).toMatchObject({ status: 200, body: { person: [], executor: { running: 1, idle: 0 } } })
  const detail = await h.api('GET', `tickets/${ticketId}`)
  expect(detail).toMatchObject({ status: 200, body: { stage: 'working' } })
  expect(detail.body).not.toHaveProperty('action')
  expect(detail.body).not.toHaveProperty('assignments.0.turnEndedAt')
  expect(await h.api('GET', `threads/${encodeURIComponent(`feishu:${CHAT}:om_1`)}`)).toMatchObject({ status: 200,
    body: { tickets: [{ id: ticketId, stage: 'working' }] } })
  expect(await h.api('GET', 'search?q=Fix')).toMatchObject({ status: 200, body: { tickets: [{ id: ticketId, stage: 'working' }] } })
}

it.each(['human follow-up', 'CI notice', 'orchestrator note', 'direct Session message'])(
  'shows a ready ticket as working after a %s wakes its worker', async source => {
    const one = await readyTicket()
    await awaitingReview(one)
    const report = latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)!.report
    // Keep the clock on the report's millisecond: runtime activity must not depend on timestamp ordering.
    if (source === 'direct Session message') h.agents.get(one.sessionId)!.followup({ id: 'typed', role: 'user',
      content: [{ type: 'text', text: 'Please continue' }], source: { kind: 'user' } } as never)
    else if (source === 'orchestrator note') h.runtime.engine.note(one.ticket.id, 'Please inspect the new check result.')
    else h.runtime.receive(feishu('2', '请再检查一次', { mentions: [], root_id: 'om_1',
      ...source === 'CI notice' ? { sender_id: 'cli_ci', sender_type: 'bot' } : {} }))
    await h.runtime.idle()
    expect(h.agents.get(one.sessionId)!.status).toBe('running')
    expect(h.runtime.executor.activeCount()).toBe(1)
    await expectWorking(one.ticket.id)
    // Display correction is not an invented worker report or a lost previous result.
    expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)!.report).toEqual(report)
    advance()
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'Follow-up checked' })
    await awaitingReview(one)
    expect(await h.api('GET', 'overview')).toMatchObject({ body: { person: [{ id: one.ticket.id, action: 'review' }],
      executor: { running: 0, idle: 0 } } })
  })

it('does not show review before the turn reporting ready actually ends', async () => {
  const one = await readyTicket()
  expect(h.agents.get(one.sessionId)!.status).toBe('running')
  await expectWorking(one.ticket.id)
  await awaitingReview(one)
})

it.each(['job', 'subagent'])('keeps a resumed background %s working even while the Session agent is idle', async kind => {
  const one = await readyTicket()
  await awaitingReview(one)
  advance()
  h.runtime.receive(feishu('2', '再补充测试', { mentions: [], root_id: 'om_1' }))
  await h.runtime.idle()
  const work = kind === 'job' ? h.jobs.run(one.sessionId, 'regression tests') : h.subagents.spawn(one.sessionId)
  idle(one.sessionId)
  await h.runtime.idle()
  expect(h.agents.get(one.sessionId)!.status).toBe('idle')
  expect(h.runtime.executor.activeCount()).toBe(1)
  await expectWorking(one.ticket.id)
  if (kind === 'job') h.jobs.end(work)
  else h.subagents.settle(work)
  await vi.waitFor(() => expect(h.agents.get(one.sessionId)!.status).toBe('running'))
  advance()
  await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'Regression tests passed' })
  await awaitingReview(one)
})

it('keeps a preview server left at handoff out of the working state', async () => {
  const one = await readyTicket()
  const job = h.jobs.run(one.sessionId, 'preview server')
  await awaitingReview(one)
  await vi.waitFor(() => expect(h.jobs.service.wait).toHaveBeenCalledWith(job, expect.any(Number), one.sessionId, expect.anything()))
  expect(h.runtime.executor.activeCount()).toBe(0)
  expect(await h.api('GET', 'tickets?state=working')).toMatchObject({ body: { total: 0, items: [] } })
  expect(await h.api('GET', 'overview')).toMatchObject({ body: { person: [{ id: one.ticket.id, action: 'review' }],
    executor: { running: 0, idle: 0 } } })
})

it.each(['answer', 'blocked', 'failed'] as const)('keeps an active worker\'s %s action visible without inventing a turn end', async action => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修复回归'))
  await h.runTool(one.sessionId, 'orchestrator_report', action === 'answer'
    ? { state: 'progress', summary: 'Need a decision', human_action: 'Which browser should be supported?' }
    : { state: action, summary: 'Cannot proceed yet' })
  expect(h.agents.get(one.sessionId)!.status).toBe('running')
  const detail = await h.api('GET', `tickets/${one.ticket.id}`)
  expect(detail).toMatchObject({ status: 200, body: { stage: 'person', action } })
  expect(detail.body).not.toHaveProperty('assignments.0.turnEndedAt')
  expect(await h.api('GET', 'overview')).toMatchObject({ body: { person: [{ id: one.ticket.id, action }] } })
})

it('shows a waiting worker as working when woken, and idle again after it settles', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修复回归'))
  idle(one.sessionId)
  await vi.waitFor(() => expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.report?.state).toBe('waiting'))
  expect(await h.api('GET', `tickets/${one.ticket.id}`)).toMatchObject({ body: { stage: 'idle' } })
  const report = latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)!.report
  advance()
  h.runtime.engine.note(one.ticket.id, 'Check the CI result.')
  await h.runtime.idle()
  await expectWorking(one.ticket.id)
  expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)!.report).toEqual(report)
  idle(one.sessionId)
  // Wait for the idle handler's report, not the brief gap before it starts checking background work.
  await vi.waitFor(() => expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)!.report!.at > report!.at).toBe(true))
  expect(h.runtime.executor.activeCount()).toBe(0)
  expect(await h.api('GET', 'overview')).toMatchObject({ body: { person: [], executor: { running: 0, idle: 1 } } })
  expect(await h.api('GET', 'tickets?state=idle')).toMatchObject({ body: { total: 1, items: [{ id: one.ticket.id, stage: 'idle' }] } })
})
