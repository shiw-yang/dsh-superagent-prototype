/** Overview page: pending Tickets requiring human action, active system problems, 24-hour flow counts, and one box per Executor. */
import type { ReactNode } from 'react'
import { usePoll, type Problem, type TicketRow } from './api.ts'
import { Button, Icon, Tag } from './controls.tsx'
import { ticketMark } from './marks.ts'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { setupPage, settingsRoute, type Route } from './route.ts'
import { TicketLine } from './rows.tsx'
import { healthText, localized, reasonLabel, valueLabel, readableMarkers } from './text.ts'
import { CheckSetupButton, ConfirmButton, Hint, LabelValue, LoadState, Section, SetupMessage, StageMark, When } from './widgets.tsx'

function ProblemLine({ problem, onChanged }: { problem: Problem; onChanged: () => Promise<void> }) {
  const { t, call, navigate } = usePanel()
  const post = useAction((request: () => Promise<unknown>) => request(), { reload: onChanged })
  const row = (title: string, detail: ReactNode, route: Route | undefined, hint?: string, actions?: ReactNode) => <li
    className="dt-row dt-link dt-att dt-att-error">
    <div className="dt-row-main">
      <div className="dt-att-what">{route ? <button type="button" className="dt-open dt-open-wrap"
        onClick={() => navigate(route)}>{title}</button> : title}</div>
      {detail}{hint && <Hint>{hint}</Hint>}{actions && <div className="dt-row-meta dt-row-buttons">{actions}</div>}
    </div>
  </li>
  const go = (label: string, route: Route) => <Button variant="outline" size="sm" icon={<Icon name="settings"
    size={14} />} onClick={() => navigate(route)}>{label}</Button>
  const raw = (text: string | undefined) => text && <p className="dt-error dt-clamp dt-mono">{text}</p>
  const worded = (text: string) => <p className="dt-error">{text}</p>
  switch (problem.kind) {
    // A failed Feishu bot check pauses only the Feishu Source; other setup problems halt the entire service.
    case 'setup': return row(t(problem.place === 'feishu' ? 'problemSetupFeishu' : 'problemSetup'), <p className="dt-error"><SetupMessage
      problem={problem} /></p>,
      setupPage(problem.place), t(`problemSetupFix.${problem.place}`), <CheckSetupButton />)
    case 'no-source': return row(t('problemNoSource'), undefined, settingsRoute('source'), undefined, go(t('actionOpenSources'),
      settingsRoute('source')))
    case 'no-allowed': return row(t('problemNoAllowed'), undefined, settingsRoute('eval'), undefined, go(t('actionAddAllowed'),
      settingsRoute('eval')))
    case 'executor-paused': return row(t('problemPaused'), undefined, { page: 'execution' }, undefined,
      <ConfirmButton variant="outline" icon="play" label={t('resumeProcessing')} title={t('resumeProcessing')}
        message={t('resumeProcessingConfirm')}
        onConfirm={async () => { await call('POST executor/pause', { body: { paused: false } }); await onChanged() }} />)
    case 'runtime-error': return row(t('problemRuntime', { name: valueLabel(t, 'health', problem.name) }), raw(problem.detail), undefined)
    case 'source-error': {
      const health = problem.source.health
      return row(t('sourceError', { source: localized(t, problem.source.title) }), health.code ? worded(healthText(t, health))
        : raw(health.detail), { page: 'source' }, t('sourceErrorHint'))
    }
    case 'eval-overdue': return row(t('problemEvalOverdue', { thread: readableMarkers(t, problem.thread.title) }), undefined, { page: 'trigger',
      id: problem.thread.key })
    case 'eval-unavailable': return row(t('problemEvalUnavailable', { thread: readableMarkers(t, problem.thread.title) }), raw(reasonLabel(t,
      problem.reason)),
      { page: 'trigger', id: problem.thread.key, query: { trigger: problem.triggerId } }, undefined, <>
        <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />} disabled={post.busy}
          onClick={() => { void post.run(() => call('POST triggers/:id/requeue', { id: problem.triggerId })) }}>{t('requeue')}</Button>
        <Button variant="outline" size="sm" icon={<Icon name="dismiss" size={14} />} disabled={post.busy}
          onClick={() => { void post.run(() => call('POST decisions/:id/dismiss', { id: problem.decisionId })) }}>{t('dismiss')}</Button>
      </>)
    case 'outgoing': return row(t('problemReply', { source: valueLabel(t, 'source', problem.outgoing.channel.source),
      attempts: problem.outgoing.attempts }),
      raw(problem.outgoing.error), undefined)
  }
}

/**
 * One compact box per Executor that is working or waiting (a Ticket's worker Session): its stage, Ticket, latest report
 * and related facts. The whole box opens its Ticket.
 */
function ExecutorCard({ ticket }: { ticket: TicketRow }) {
  const { t, navigate } = usePanel()
  const mark = ticketMark(t, ticket)
  const progress = readableMarkers(t, ticket.summary)
  const thread = ticket.threads[0]
  return <li className="dt-executor-card" data-state={mark.dot}>
    <div className="dt-executor-head">
      <StageMark state={mark.dot} icon={mark.icon} label={mark.label} />
      <When at={ticket.updatedAt} />
    </div>
    <div className="dt-row-title"><button type="button" className="dt-open" title={ticket.title}
      onClick={() => navigate({ page: 'execution', id: ticket.id })}>{ticket.title}</button></div>
    <p className="dt-executor-progress">{progress || t('executorBoardNoReport')}</p>
    <div className="dt-executor-foot">
      {thread && <Tag tone="quiet">{valueLabel(t, 'source', thread.source)}</Tag>}
      {ticket.undelivered > 0 && <LabelValue label={t('ticketUndeliveredLabel')} value={ticket.undelivered} />}
    </div>
  </li>
}
/**
 * The Executors to box on the overview: working Tickets first, then queued ones, then those waiting for a Trigger, each
 * newest first. Tickets waiting on a person have their own section above and no place here.
 */
export function executorCards(tickets: TicketRow[]): TicketRow[] {
  const rank = (ticket: TicketRow) => ticket.stage === 'idle' ? 2 : ticket.stage === 'working' && ticket.action === 'queued' ? 1 : 0
  return tickets.filter(ticket => ticket.stage === 'working' || ticket.stage === 'idle')
    .sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt))
}

export function OverviewPage() {
  const { t, call, navigate } = usePanel()
  const { setup } = usePanelData()
  const { data, error, reload } = usePoll(() => call('GET overview'), [])
  // One page is enough for far more Executors than the configured concurrency, including the waiting queue.
  const board = usePoll(() => call('GET tickets', { query: { state: 'open', limit: 100 } }), [])
  if (!data) return <LoadState error={error} loading />
  const executors = board.data ? executorCards(board.data.items) : []
  const stat = (label: string, value: ReactNode, route?: Route) => <span className="dt-stat">
    <span className="dt-stat-label">{label}</span>
    {route ? <button type="button" className="dt-textlink dt-stat-value" onClick={() => navigate(route)}>{value}</button> : <span
      className="dt-stat-value">{value}</span>}
  </span>
  const more = (route: Route) => <button type="button" className="dt-textlink dt-more-link"
    onClick={() => navigate(route)}>{t('details')}</button>
  return <>
    {error && <LoadState error={error} loading={false} />}
    <Section title={t('pendingTickets')} count={data.person.length}>
      {data.person.length ? <ul className="dt-list dt-cards">{data.person.map(ticket => <TicketLine key={ticket.id} ticket={ticket} question
        onChanged={reload} />)}</ul>
        : <Hint>{t('needsYouNone')}</Hint>}
    </Section>
    {data.problems.length > 0 && <Section title={t('problems')} count={data.problems.length}>
      <ul className="dt-list dt-cards">{data.problems.map((problem, index) => <ProblemLine key={index} problem={problem}
        onChanged={reload} />)}</ul>
    </Section>}
    <Section title={t('lastDay')} action={more({ page: 'trigger', query: { filter: 'recent' } })}>
      {/* Received and evaluated counts operate on Triggers rather than Threads or Decisions, so they do not link to filtered views. */}
      <div className="dt-stats">
        {stat(t('flowReceivedLabel'), data.flow.received)}
        {stat(t('flowFilteredLabel'), data.flow.filtered, data.flow.filtered ? { page: 'source' } : undefined)}
        {stat(t('flowJudgedLabel'), data.flow.judged)}
        {stat(t('flowAcceptedLabel'), data.flow.accepted, { page: 'eval', query: { window: '24h' } })}
        {data.flow.dropped > 0 && stat(t('flowDroppedLabel'), data.flow.dropped, { page: 'source' })}
      </div>
    </Section>
    <Section title={t('term.executor')} action={more({ page: 'execution' })} hint={t('executorBoardHint')}>
      {/* Pauses surface in `problems` above, so Executor counts render the same in both states; while setup waits, nothing runs. */}
      {setup?.problem ? <Hint>{t('executorWaitingSetup')}</Hint> : <>
        <div className="dt-stats dt-executor-load">
          {stat(t('executingLabel'), `${data.executor.running} / ${data.executor.maxWorkers}`)}
          {stat(t('queuedLabel'), data.executor.queued)}
          {stat(t('idleLabel'), data.executor.idle)}
        </div>
        {board.error && <LoadState error={board.error} loading={false} />}
        {board.data && (executors.length ? <ul className="dt-executor-grid">{executors.map(ticket => <ExecutorCard key={ticket.id}
          ticket={ticket} />)}</ul> : <Hint>{t('none')}</Hint>)}
      </>}
    </Section>
  </>
}
