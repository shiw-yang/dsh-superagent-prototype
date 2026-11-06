// @vitest-environment jsdom
/** Assignment indicators follow the current turn rather than a previous report. */
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { all, at, mount, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
it.each(['ready', 'waiting'] as const)('shows a running Assignment despite its earlier %s report', async state => {
  const ticket = server.ticketDetails.t1!
  const assignment = ticket.assignments[0]!
  server.ticketDetails.t1 = { ...ticket, stage: 'working', action: undefined, assignments: [
    { ...assignment, id: 'prior', state: 'ended', endedAt: '2026-09-22T00:04:00Z' },
    { ...assignment, id: 'current', state: 'running', turnEndedAt: undefined,
      report: { state, summary: 'Previous result', at: '2026-09-22T00:05:00Z' } },
  ] }
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(zh.executingLabel)
  const row = all('.dt-row-title').find(item => item.textContent === zh.assignmentNumber.replace('{number}', '2'))!.closest('li')!
  expect(row.querySelector('.dt-tag')?.textContent).toBe(zh['assignment.running'])
  expect(row.querySelector('.dt-dot')?.getAttribute('data-state')).toBe('ongoing')
  expect(row.textContent).toContain(zh.now)
})
