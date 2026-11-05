// @vitest-environment jsdom
// Verification snapshots rendered against the in-memory panel server, never a live GUI.
import { expect, it } from 'vitest'
import type { TicketPageView } from '../src/client/api.ts'
import { en, zh } from '../src/client/locales.ts'
import { all, at, click, mount, remount, text, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

type Report = NonNullable<TicketPageView['verificationReports']>[number]
const report = (overrides: Partial<Report> = {}): Report => ({
  assignmentId: 'a1', at: '2026-09-22T00:05:00Z', state: 'ready', summary: 'Checked the login change',
  verification: { revision: 'abc1234', checks: [
    { criterion: 'Login accepts valid credentials', status: 'passed', method: 'Worker ran the focused test',
      evidence: [{ label: 'Test log', url: 'https://example.com/test-log' }] },
    { criterion: 'Keyboard navigation', status: 'failed', method: 'Worker manual check', notes: 'Focus is lost' },
    { criterion: 'Mobile browser', status: 'not_run', method: 'No device available' },
  ], unverified: ['Production deployment was not exercised'] }, ...overrides,
})
const section = () => all('.dt-section').find(item => item.querySelector('.dt-section-name')?.textContent === en.verificationTitle)!
async function show(reports?: Report[]) {
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, verificationReports: reports }
  at({ page: 'execution', id: 't1' })
  await mount(en)
}

usePanel()
it('shows worker-reported checks, version, time, evidence and limitations before the Mandate', async () => {
  await show([report()])
  const panel = section()
  expect(all('.dt-section-name').slice(0, 2).map(item => item.textContent)).toEqual([en.verificationTitle, en.mandateDetails])
  for (const expected of [en.verificationLatest, en.verificationWorker, en.verificationSnapshotNotice,
    en['verificationStatus.passed'], en['verificationStatus.failed'], en['verificationStatus.not_run'], 'abc1234',
    'Checked the login change', 'Focus is lost', 'No device available', 'Production deployment was not exercised',
    'Worker ran the focused test', 'a1']) expect(panel.textContent).toContain(expected)
  expect(panel.querySelector('time')?.dateTime).toBe('2026-09-22T00:05:00Z')
  expect(panel.querySelector('a')?.getAttribute('href')).toBe('https://example.com/test-log')
  expect(panel.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer')
  expect(panel.querySelector('a')?.getAttribute('target')).toBe('_blank')
  await remount(zh)
  for (const expected of [zh.verificationWorker, zh.verificationSnapshotNotice, zh['verificationStatus.not_run'],
    zh.verificationLimitations]) expect(text()).toContain(expected)
})

it('keeps earlier snapshots expandable, newest first, without claiming a snapshot matches later work', async () => {
  const oldest = report({ at: '2026-09-20T00:00:00Z', summary: 'Oldest summary', verification: { revision: 'oldest', checks: [] } })
  const middle = report({ at: '2026-09-21T00:00:00Z', summary: 'Middle summary', verification: { revision: 'middle', checks: [] } })
  const ticket = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...ticket, updatedAt: '2026-09-23T00:00:00Z',
    assignments: [...ticket.assignments, { ...ticket.assignments[0]!, id: 'later-assignment', createdAt: '2026-09-23T00:00:00Z',
      report: { state: 'progress', summary: 'Later work without verification', at: '2026-09-23T00:01:00Z' } }] }
  await show([oldest, middle, report()])
  expect(section().textContent).toContain(en.verificationLatest)
  expect(section().textContent).toContain(en.verificationSnapshotNotice)
  expect(section().textContent).not.toContain('Middle summary')
  await click('Earlier verification reports · 2')
  const buttons = [...section().querySelectorAll<HTMLElement>('[role="button"]')]
  const histories = buttons.filter(button => /^(middle|oldest)/.test(button.textContent ?? ''))
  expect(histories.map(button => button.textContent?.split(' · ')[0])).toEqual(['middle', 'oldest'])
  expect(histories.map(button => button.querySelector('time')?.dateTime)).toEqual(['2026-09-21T00:00:00Z', '2026-09-20T00:00:00Z'])
  await click(histories[0]!)
  expect(section().textContent).toContain('Middle summary')
  expect(section().textContent).not.toContain('Oldest summary')
  await click(histories[1]!)
  expect(section().textContent).toContain('Oldest summary')
})

it.each(['identical', 'regressing'])('uses append order for latest snapshot and history with %s timestamps', async clock => {
  const reports = ['first', 'second', 'third'].map((revision, index) => report({ summary: `${revision} submission`,
    ...(clock === 'regressing' ? { at: `2026-09-${22 - index}T00:00:00Z` } : {}),
    verification: { revision, checks: [] } }))
  await show(reports)
  expect(section().textContent).toContain('third submission')
  expect(section().textContent).not.toContain('second submission')
  await click('Earlier verification reports · 2')
  const histories = [...section().querySelectorAll<HTMLElement>('[role="button"]')]
    .filter(button => /^(first|second)/.test(button.textContent ?? ''))
  expect(histories.map(button => button.textContent?.split(' · ')[0])).toEqual(['second', 'first'])
  await click(histories[0]!)
  expect(section().textContent).toContain('second submission')
  expect(section().textContent).not.toContain('first submission')
  expect(reports.map(item => item.verification.revision)).toEqual(['first', 'second', 'third'])
})

it('does not interpret absent legacy verification as a pass', async () => {
  await show()
  expect(section().textContent).toContain(en.verificationEmpty)
  expect(section().textContent).not.toContain(en['verificationStatus.passed'])
  await remount(zh)
  expect(text()).toContain(zh.verificationEmpty)
})

it('makes a missing version and unspecified limitations explicit and allows only HTTP/S evidence links', async () => {
  await show([report({ verification: { checks: [{ criterion: 'Worker observed CI', status: 'passed', method: 'CI observed by worker',
    evidence: [
      { label: 'HTTP log', url: 'http://example.com/log' },
      { label: 'HTTPS log', url: 'https://example.com/log' },
      { label: 'Script', url: 'javascript:alert(1)' },
      { label: 'Data', url: 'data:text/html,unsafe' },
      { label: 'Local file', url: 'file:///tmp/log' },
      { label: 'Relative', url: '/log' },
      { label: 'Malformed', url: 'not a url' },
    ] }] } })])
  expect(section().textContent).toContain(en.verificationRevisionMissing)
  expect(section().textContent).toContain(en.verificationLimitationsMissing)
  expect(section().textContent).toContain(en.verificationWorker)
  expect([...section().querySelectorAll('a')].map(link => link.href)).toEqual(['http://example.com/log', 'https://example.com/log'])
  for (const label of ['Script', 'Data', 'Local file', 'Relative', 'Malformed']) expect(section().textContent).toContain(label)
})

it('shows an empty submitted check list without a pass badge', async () => {
  await show([report({ verification: { checks: [] } })])
  expect(section().textContent).toContain(en.verificationChecksEmpty)
  expect(section().textContent).not.toContain(en['verificationStatus.passed'])
})
