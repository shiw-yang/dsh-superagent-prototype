// @vitest-environment jsdom
// Verification snapshots rendered against the in-memory panel server, never a live GUI.
import { expect, it, vi } from 'vitest'
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
  for (const expected of ['Last verification:', en.verificationWorker,
    en['verificationStatus.passed'], en['verificationStatus.failed'], en['verificationStatus.not_run'],
    'Checked the login change', 'Production deployment was not exercised', '3 checks']) expect(panel.textContent).toContain(expected)
  for (const hidden of [en.verificationSnapshotNotice, 'abc1234', 'Focus is lost', 'No device available',
    'Worker ran the focused test']) expect(panel.textContent).not.toContain(hidden)
  const checks = [...panel.querySelectorAll<HTMLElement>('.dt-verification-checks [role="button"]')]
  expect(checks.map(item => item.textContent)).toEqual(['FailedKeyboard navigation', 'Not runMobile browser',
    'PassedLogin accepts valid credentials'])
  for (const check of checks) await click(check)
  await click(en.verificationTechnical)
  await click(en.verificationWorker)
  for (const shown of [en.verificationSnapshotNotice, 'abc1234', 'Focus is lost', 'No device available',
    'Worker ran the focused test', 'a1']) expect(panel.textContent).toContain(shown)
  expect(panel.querySelector('time')?.dateTime).toBe('2026-09-22T00:05:00Z')
  expect(panel.querySelector('a')?.getAttribute('href')).toBe('https://example.com/test-log')
  expect(panel.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer')
  expect(panel.querySelector('a')?.getAttribute('target')).toBe('_blank')
  await remount(zh)
  expect(text()).not.toContain(zh.verificationSnapshotNotice)
  await click(zh.verificationWorker)
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
  expect(section().textContent).toContain('Last verification:')
  expect(section().textContent).not.toContain(en.verificationSnapshotNotice)
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
  await click(en.verificationTechnical)
  await click(section().querySelector<HTMLElement>('.dt-verification-checks [role="button"]')!)
  expect(section().textContent).toContain(en.verificationRevisionMissing)
  expect(section().textContent).toContain(en.verificationLimitationsMissing)
  expect(section().textContent).toContain(en.verificationWorker)
  expect([...section().querySelectorAll('a')].map(link => link.href)).toEqual(['http://example.com/log', 'https://example.com/log'])
  for (const label of ['Script', 'Data', 'Local file', 'Relative', 'Malformed']) expect(section().textContent).toContain(label)
})

it('shows an empty submitted check list without a pass badge', async () => {
  await show([report({ verification: { checks: [] } })])
  expect(section().textContent).toContain(en.verificationChecksEmpty)
  expect(section().querySelector('.dt-tag')?.textContent).not.toBe(en['verificationStatus.passed'])
})

it('previews long legacy summaries and limitations without discarding their original text', async () => {
  const summary = `${'Original detail '.repeat(100)}SUMMARY END`
  const limitation = `${'Untested scenario '.repeat(40)}LIMITATION END`
  await show([report({ summary, verification: { checks: [], unverified: [limitation] } })])
  expect(section().textContent).not.toContain('SUMMARY END')
  expect(section().textContent).not.toContain('LIMITATION END')
  expect(section().querySelector('.dt-report-summary .dt-event-text')?.textContent?.length).toBe(161)
  expect(section().querySelector('.dt-verification-limitations')?.textContent).toContain(`${en.verificationLimitations} · 1`)
  const toggles = [...section().querySelectorAll<HTMLElement>('.dt-report-text button')]
  for (const toggle of toggles) await click(toggle)
  expect(section().textContent).toContain(summary)
  expect(section().textContent).toContain(limitation)
  await click(toggles[0]!)
  expect(section().textContent).not.toContain('SUMMARY END')
})

it('prioritizes the supplied brief while retaining the full report, and distinguishes last verification from current work', async () => {
  const summary = `${'Long original report '.repeat(80)}ORIGINAL END`
  await show([report({ state: 'blocked', summary,
    brief: { conclusion: 'Login fixed, release still blocked', blockers: ['Missing mobile device'], nextSteps: ['Test on device'] } })])
  for (const visible of ['Login fixed, release still blocked', 'Missing mobile device', 'Test on device', en.reportBlockers,
    en.reportNextSteps, 'Last verification:']) expect(section().textContent).toContain(visible)
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(en['stage.working'])
  expect(section().textContent).not.toContain('ORIGINAL END')
  await click(en.reportOriginal)
  expect(section().textContent).toContain(summary)
  await remount(zh)
  expect(text()).toContain('上次验证：')
  expect(text()).toContain(zh.reportBlockers)
  expect(text()).toContain(zh.reportNextSteps)
  expect(text()).not.toContain('ORIGINAL END')
  await click(zh.reportOriginal)
  expect(text()).toContain(summary)
})

it('flags conditional passes and bounds long criteria while expanding all unchanged evidence', async () => {
  const criterion = `${'Detailed acceptance requirement '.repeat(30)}CRITERION END`
  const notes = 'Only on the tested desktop; mobile behavior is not established'
  await show([report({ verification: { checks: [
    { criterion, status: 'passed', method: 'Observed a local test', notes,
      evidence: [{ label: 'Original evidence', url: 'https://example.com/evidence' }] },
    { criterion: 'Not tested yet', status: 'not_run', method: 'No environment' },
    { criterion: 'Failed check', status: 'failed', method: 'Observed failure' },
  ] } })])
  const rows = [...section().querySelectorAll<HTMLElement>('.dt-verification-checks [role="button"]')]
  expect(rows[0]?.textContent).toContain('Failed check')
  expect(rows[1]?.textContent).toContain('Not tested yet')
  expect(rows[2]?.textContent).toContain(en.verificationPassedLimited)
  expect(rows[2]?.querySelector('.dt-check-criterion')?.textContent?.length).toBe(161)
  expect(section().textContent).not.toContain('CRITERION END')
  expect(section().textContent).not.toContain(notes)
  await click(rows[2]!)
  expect(section().textContent).toContain(criterion)
  expect(section().textContent).toContain(notes)
  expect(section().textContent).toContain('Observed a local test')
  expect(section().querySelector('a')?.getAttribute('href')).toBe('https://example.com/evidence')
  await remount(zh)
  expect(text()).toContain(zh.verificationPassedLimited)
})

it('copies full technical identifiers only after successful clipboard writes and reports failures', async () => {
  const revision = '0123456789abcdef'.repeat(4)
  const writeText = vi.fn().mockResolvedValue(undefined)
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  try {
    await show([report({ assignmentId: 'assignment-full-id', verification: { revision, checks: [] } })])
    expect(section().textContent).not.toContain(revision)
    await click(en.verificationTechnical)
    expect(section().textContent).toContain(revision)
    await click('Copy Reported version')
    expect(writeText).toHaveBeenCalledWith(revision)
    expect(section().textContent).toContain(en.reportCopied)
    writeText.mockRejectedValueOnce(new Error('Permission denied'))
    await click('Copy Reported version')
    expect(section().textContent).toContain(en.reportCopyFailed)
    expect(section().textContent).not.toContain(en.reportCopied)
    await click('Copy Reporting Assignment')
    expect(writeText).toHaveBeenLastCalledWith('assignment-full-id')
    await remount(zh)
    await click(zh.verificationTechnical)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    await click(`复制${zh.verificationRevision}`)
    expect(text()).toContain(zh.reportCopyFailed)
    expect(text()).not.toContain(zh.reportCopied)
  } finally {
    if (original) Object.defineProperty(navigator, 'clipboard', original)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

it('shortens history versions but keeps the complete identifier in expandable technical details', async () => {
  const revision = 'fedcba9876543210'.repeat(4)
  await show([report({ verification: { revision, checks: [] } }), report({ summary: 'Latest report' })])
  await click('Earlier verification reports · 1')
  const history = [...section().querySelectorAll<HTMLElement>('[role="button"]')]
    .find(item => item.textContent?.startsWith(`${revision.slice(0, 12)}…`))!
  expect(history.textContent).not.toContain(revision)
  await click(history)
  const container = history.parentElement!
  const technical = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(item => item.textContent === en.verificationTechnical)!
  await click(technical)
  expect(container.textContent).toContain(revision)
})
