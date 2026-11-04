/** Instance-bound capabilities for Source plugins; default instances retain their historical keys. */
import { key, type EngineForSources, type ReceiveResult, type Trigger, type ChannelRef } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Commands } from '../infra/commands.ts'
import type { SetupProblem } from '../setup.ts'
import type { SourceContext } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { family, type Key } from '../kv.ts'
import type { Outbox } from './outbox.ts'
import type { Store } from './store.ts'

export interface SourceContextDeps {
  readonly store: Pick<Store, 'atomic' | 'get' | 'set' | 'delete' | 'keys' | 'threads' | 'tickets' | 'triggers' | 'read'>
  readonly outbox: Pick<Outbox, 'send'>
  readonly engine: Pick<EngineForSources, 'bindThread' | 'threadClosed'>
  readonly commands: Commands
  readonly sources: SourceRegistry
  readonly deployment: Deployment
  readonly ready: Promise<void>
  configured(repositoryId?: string): boolean
  deploymentFor?(repositoryId?: string): Deployment
  commandsFor?(sourceInstanceId: string): Commands
  problemFor?(repositoryId: string): SetupProblem | undefined
  readonly setupProblem?: SetupProblem | undefined
  readonly feishuProblem?: SetupProblem | undefined
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
}

export function sourceContextOf(deps: SourceContextDeps, kind: { kind: string; id?: string; health: readonly string[] }): SourceContext {
  const { store } = deps
  const id = kind.id ?? kind.kind
  const repositoryId = deps.sources.instance(id)?.repositoryId
  const custom = id !== kind.kind
  const names = kind.health.map(name => custom ? `${id}:${name}` : name)
  const health = deps.sources.healthEntries(names)
  const scoped = (value: string) => custom && value.startsWith(`${kind.kind}:`) ? `${id}:${value.slice(kind.kind.length + 1)}` : value
  const stateKey = <V>(value: Key<V>): Key<V> => (custom ? `source:${id}:${value}` : value) as Key<V>
  const channel = (value: ChannelRef): ChannelRef => value.source === kind.kind
    ? { ...value, source: id, thread: scoped(value.thread) } : value
  const owns = (ticket: { repository?: string }) => !repositoryId || ticket.repository === repositoryId
  return {
    ...(kind.id ? { id } : {}), ...(repositoryId ? { repositoryId } : {}),
    get deployment() { return deps.deploymentFor ? deps.deploymentFor(repositoryId) : deps.deployment },
    get commands() {
      if (deps.commandsFor) return deps.commandsFor(id)
      if (repositoryId && deps.deploymentFor) return deps.commands.forDeployment(() => deps.deploymentFor!(repositoryId))
      if (custom && repositoryId) throw new Error(`Source access is not bound: ${id}`)
      return deps.commands
    },
    ready: deps.ready,
    configured: () => deps.configured(repositoryId),
    get problem() { return repositoryId ? deps.problemFor?.(repositoryId) : [deps.feishuProblem, deps.setupProblem].find(problem => problem?.place === kind.kind) },
    config: <C extends Record<string, unknown>>(_kind: string) => {
      const instance = deps.sources.instance<C>(_kind === kind.kind ? id : _kind)
      return instance?.enabled && (_kind !== kind.kind || instance.repositoryId === repositoryId) ? instance.config : undefined
    },
    receive: trigger => {
      if (deps.sources.instance(id)?.repositoryId !== repositoryId) throw new Error(`Source ${id} repository binding changed; waiting for restart`)
      return deps.receive(custom ? { ...trigger, id: key(id, trigger.id), source: id,
        text: kind.kind === 'github' ? trigger.text.replace(/Read github\//g, `Read github/${id}/`) : trigger.text,
        actor: { ...trigger.actor, source: trigger.actor.source === kind.kind ? id : trigger.actor.source },
        threads: trigger.threads.map(ref => ({ ...ref, source: ref.source === kind.kind ? id : ref.source })),
        ...(trigger.channel ? { channel: channel(trigger.channel) } : {}) } : trigger)
    },
    atomic: work => store.atomic(work),
    state: {
      get: name => store.get(stateKey(name)),
      set: (name, value) => { if (value === undefined) store.delete(stateKey(name)); else store.set(stateKey(name), value) },
      keys: prefix => custom ? store.keys(family(`source:${id}:${prefix.prefix}`)).map(value => value.slice(`source:${id}:`.length)) : store.keys(prefix),
    },
    threads: {
      get: value => store.threads.get(scoped(value)),
      subscribed: source => store.read.subscribedThreads(source === kind.kind ? id : source),
      describe: (value, description) => store.threads.describe(scoped(value), description),
      patch: (value, meta) => { store.threads.patchMeta(scoped(value), meta) },
    },
    tickets: {
      get: value => { const ticket = store.tickets.get(value); return ticket && owns(ticket) ? ticket : undefined },
      open: () => store.tickets.open().filter(owns),
      bindThread: (value, thread, own) => { const ticket = store.tickets.get(value); if (!ticket || !owns(ticket)) throw new Error('Ticket belongs to another repository'); deps.engine.bindThread(value, { ...thread, source: thread.source === kind.kind ? id : thread.source }, own) },
      threadClosed: (thread, outcome, at) => { deps.engine.threadClosed({ ...thread, source: thread.source === kind.kind ? id : thread.source }, outcome, at) },
    },
    triggers: { get: value => store.triggers.get(value), latest: thread => store.read.threadTriggers(scoped(thread), 1)[0] },
    notify: message => { deps.outbox.send(custom ? { ...message, id: key(id, message.id), channel: channel(message.channel) } : message) },
    report: (entry, value) => {
      if (!kind.health.includes(entry)) throw new Error(`The ${kind.kind} Source has no health entry ${entry}`)
      health.get(custom ? `${id}:${entry}` : entry)?.set(value)
    },
  }
}
