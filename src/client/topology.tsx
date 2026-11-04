/** Atomic multi-repository settings: stable identities, reusable profiles, and source routing. */
import { useState, type ReactNode } from 'react'
import type { Topology } from '../policy.ts'
import { Button, Input, Switch } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel } from './provider.tsx'
import { Field, Fields, ModelField, SourceField, useBlockDraft, useSettings } from './settings-kit.tsx'
import { Hint } from './widgets.tsx'

function useWords() {
  const { t } = usePanel()
  return (zh: string, en: string) => t('lang') === 'zh' ? zh : en
}
function Collection<V>({ title, rows, create, onChange, children, arbitraryIds = false, canRemove = () => true }: { title: string; rows: Record<string, V>; arbitraryIds?: boolean; canRemove?: (id: string) => boolean;
  create: (id: string) => V; onChange: (rows: Record<string, V>) => void;
  children: (id: string, value: V, edit: (next: V) => void) => ReactNode }) {
  const w = useWords()
  const [id, setId] = useState('')
  const valid = (arbitraryIds ? !!id.trim() : /^[a-z][a-z0-9-]*$/.test(id)) && !Object.hasOwn(rows, id)
  return <section className="dt-form dt-block" aria-label={title}>
    <h3 className="dt-block-title">{title} <span className="dt-count">{Object.keys(rows).length}</span></h3>
    {Object.entries(rows).map(([key, value]) => <div className="dt-block dt-form" key={key}>
      <div className="dt-card-head"><strong className="dt-mono">{key}</strong>
        <Button variant="ghost" disabled={!canRemove(key)} onClick={() => onChange(Object.fromEntries(Object.entries(rows).filter(([id]) => id !== key)))}>
          {w('移除', 'Remove')} {key}</Button></div>
      {children(key, value, next => onChange({ ...rows, [key]: next }))}
    </div>)}
    <div className="dt-row-buttons">
      <Input aria-label={`${title} ID`} placeholder={arbitraryIds ? w('会话 ID', 'Chat ID') : w('新 ID（小写字母、数字、连字符）', 'New ID (lowercase letters, digits, hyphens)')}
        value={id} onChange={event => setId(event.target.value)} />
      <Button disabled={!valid} onClick={() => { onChange({ ...rows, [id]: create(id) }); setId('') }}>{w('添加', 'Add')} {title}</Button>
    </div>
    {id && !valid && <Hint>{arbitraryIds ? w('会话 ID 不能为空或重复。', 'Chat IDs must be nonempty and unique.')
      : w('ID 必须以小写字母开头，且不能重复。', 'Use a unique ID starting with a lowercase letter.')}</Hint>}
  </section>
}
function Choice({ label, value, rows, onChange, disabled = false }: { label: string; value: string; rows: Record<string, { name: string }>; disabled?: boolean;
  onChange: (value: string) => void }) {
  const w = useWords()
  return <Field label={label}><select className="dt-select" value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
    <option value="">{w('未指定', 'Not specified')}</option>
    {value && !rows[value] && <option value={value}>{value} ({w('不存在', 'missing')})</option>}
    {Object.entries(rows).map(([id, row]) => <option value={id} key={id}>{row.name} · {id}</option>)}
  </select></Field>
}
export function TopologySettings() {
  const { topology } = useSettings().settings
  // Older hosts and legacy fixtures have no registry block; leave their existing editors intact.
  return topology ? <TopologyEditor block={topology} /> : null
}
export function TopologyEditor({ block }: { block: { revision: number; value: Topology } }) {
  const w = useWords()
  const { sources } = useSettings().settings
  const draft = useBlockDraft('topology', block.value, block.revision, value => ({ ...value,
    executorProfiles: Object.fromEntries(Object.entries(value.executorProfiles).map(([id, profile]) => [id,
      { ...profile, blockedCommands: profile.blockedCommands.map(command => command.trim()).filter(Boolean) }])) }))
  const value = draft.value
  const edit = (next: Partial<Topology>) => draft.edit({ ...value, ...next })
  const text = (label: string, value: string, onChange: (value: string) => void, required = false, readOnly = false) => <Field label={label}>
    <Input value={value} required={required} readOnly={readOnly} onChange={event => onChange(event.target.value)} /></Field>
  const repositoryLabel = w('仓库', 'Repositories'), executorLabel = w('执行配置', 'Executor profiles'), accessLabel = w('访问配置', 'Access profiles')
  return <form noValidate className="dt-form dt-block" aria-label={w('多仓库配置', 'Multi-repository configuration')}
    onSubmit={event => { void draft.submit(event) }}>
    <h2 className="dt-block-title">{w('多仓库配置', 'Multi-repository configuration')}</h2>
    <Hint>{w('仓库、配置与路由一起保存。ID 创建后保持不变；被引用的配置不能删除。停用仓库会阻止新的执行。',
      'Repositories, profiles and routes save together. IDs remain stable; referenced profiles cannot be deleted. Disabled repositories cannot start new work.')}</Hint>
    <Hint>{w('已保存的仓库和来源不可删除或更换身份；请停用后使用新 ID 创建。每个仓库最多启用一个 GitHub 来源，以保护历史线程与监听游标。',
      'Saved repositories and sources cannot be deleted or retargeted; disable them and create a new ID instead. Enable at most one GitHub source per repository to protect thread history and polling cursors.')}</Hint>
    <Hint>{w('设置步骤：创建访问与执行配置 → 添加仓库并选择配置 → 手动添加 GitHub 来源并绑定仓库（停用的来源也须绑定）→ 保存 → 在策略设置中选择该来源，配置允许发起工作的账号与接收规则。仅创建仓库不会自动监听。',
      'Setup: create access and executor profiles → add a repository and select its profiles → manually add a GitHub source and bind it (including disabled sources) → save → select that source in Policy settings to configure allowed accounts and admission rules. Creating a repository alone does not start listening.')}</Hint>
    <Hint>{w('当前运行环境支持每仓库选择模型与准备命令；执行账号和禁止命令必须与安装时的基线一致。不支持的差异会阻止执行，而不会降级到其他账号。',
      'This runtime supports per-repository models and prepare commands. Execution accounts and blocked commands must match the installation baseline. Unsupported differences block execution rather than falling back to another account.')}</Hint>
    <Fields disabled={draft.busy}>
      <Collection title={repositoryLabel} canRemove={id => !block.value.repositories[id]} rows={value.repositories} onChange={repositories => edit({ repositories })}
        create={id => ({ name: id, provider: 'github' as const, fullName: '', enabled: true, accessProfileId: '', executorProfileId: '' })}>
        {(id, row, set) => <>
          {text(w('名称', 'Name'), row.name, name => set({ ...row, name }), true)}
          {text(w('GitHub 仓库（owner/repo）', 'GitHub repository (owner/repo)'), row.fullName, fullName => set({ ...row, fullName }), true, !!block.value.repositories[id])}
          {text(w('默认分支', 'Default branch'), row.defaultBranch ?? '', defaultBranch => {
            const { defaultBranch: _old, ...rest } = row; set({ ...rest, ...defaultBranch ? { defaultBranch } : {} })
          })}
          <Choice label={executorLabel} value={row.executorProfileId} rows={value.executorProfiles} onChange={executorProfileId => set({ ...row, executorProfileId })} />
          <Choice label={accessLabel} value={row.accessProfileId} rows={value.accessProfiles} onChange={accessProfileId => set({ ...row, accessProfileId })} />
          <div className="dt-switch-row"><span>{w('启用仓库', 'Enable repository')}</span>
            <Switch label={`${w('启用仓库', 'Enable repository')} ${id}`} checked={row.enabled} onChange={enabled => set({ ...row, enabled })} /></div>
        </>}
      </Collection>
      <Collection title={executorLabel} rows={value.executorProfiles} onChange={executorProfiles => edit({ executorProfiles })}
        create={id => ({ name: id, model: null, directory: '', prepare: '', blockedCommands: [] })}>
        {(id, row, set) => <>
          {text(w('名称', 'Name'), row.name, name => set({ ...row, name }), true)}
          <ModelField id={`profile-${id}`} value={row.model} onChange={model => set({ ...row, model })} />
          {text(w('工作目录', 'Working directory'), row.directory, directory => set({ ...row, directory }))}
          <Field label={w('准备命令', 'Prepare command')}><textarea className="dt-textarea dt-mono" rows={3} value={row.prepare}
            onChange={event => set({ ...row, prepare: event.target.value })} /></Field>
          <Field label={w('禁止命令（每行一个）', 'Blocked commands (one per line)')}><textarea className="dt-textarea dt-mono" rows={3}
            value={row.blockedCommands.join('\n')} onChange={event => set({ ...row, blockedCommands: event.target.value.split('\n') })} /></Field>
        </>}
      </Collection>
      <Collection title={accessLabel} rows={value.accessProfiles} onChange={accessProfiles => edit({ accessProfiles })}
        create={id => ({ name: id, kind: 'github-cli' as const, cli: 'gh' })}>
        {(_id, row, set) => <>
          {text(w('名称', 'Name'), row.name, name => set({ ...row, name }), true)}
          <Hint>GitHub CLI</Hint>
          {text(w('CLI 可执行文件或账号包装脚本', 'CLI executable or account wrapper'), row.cli, cli => set({ ...row, cli }), true)}
        </>}
      </Collection>
      <Collection title={w('来源路由', 'Source routes')} canRemove={id => !block.value.sources[id]} rows={value.sources} onChange={sources => edit({ sources })}
        create={() => ({ enabled: false, kind: 'github', config: {} })}>
        {(id, row, set) => {
          const kind = row.kind ?? id
          const schema = sources.find(source => source.id === kind) ?? sources.find(source => source.kind === kind)
            ?? sources.find(source => source.id === id)
          const routing = row.routing ?? { allowedRepositoryIds: [] }
          const route = (next: Partial<typeof routing>) => set({ ...row, routing: { ...routing, ...next } })
          return <>
            <Field label={w('来源类型', 'Source kind')}><select className="dt-select" value={kind} disabled={!!block.value.sources[id]}
              onChange={event => set({ ...row, kind: event.target.value })}>
              {[...new Set(['github', ...id === 'feishu' ? ['feishu'] : [], kind])].map(option => <option key={option}
                disabled={option === 'feishu' && id !== 'feishu'}>{option}</option>)}
            </select></Field>
            <Hint>{w('飞书目前仅支持默认 feishu 实例。请在该实例配置允许仓库、默认目标与会话路由，不要创建新的飞书机器人来源。',
              'Feishu currently supports only the default feishu instance. Configure its allowed repositories, default target and chat routes instead of creating another Feishu bot source.')}</Hint>
            <div className="dt-switch-row"><span>{w('启用来源', 'Enable source')}</span>
              <Switch label={`${w('启用来源', 'Enable source')} ${id}`} checked={row.enabled} onChange={enabled => set({ ...row, enabled })} /></div>
            <Choice label={w('绑定仓库', 'Bound repository')} disabled={!!block.value.sources[id]?.repositoryId} value={row.repositoryId ?? ''} rows={value.repositories}
              onChange={repositoryId => { const { repositoryId: _old, ...rest } = row; set({ ...rest, ...repositoryId ? { repositoryId } : {} }) }} />
            <Choice label={w('默认目标仓库', 'Default target repository')} value={routing.defaultRepositoryId ?? ''} rows={value.repositories}
              onChange={defaultRepositoryId => { const { defaultRepositoryId: _old, ...rest } = routing;
                set({ ...row, routing: { ...rest, ...defaultRepositoryId ? { defaultRepositoryId } : {} } }) }} />
            <fieldset className="dt-fieldset"><legend>{w('允许的仓库', 'Allowed repositories')}</legend>
              {Object.entries(value.repositories).map(([key, repo]) => <label className="dt-row-buttons" key={key}>
                <input type="checkbox" checked={routing.allowedRepositoryIds.includes(key)} onChange={event => route({ allowedRepositoryIds:
                  event.target.checked ? [...routing.allowedRepositoryIds, key] : routing.allowedRepositoryIds.filter(id => id !== key) })} />{repo.name} · {key}
              </label>)}
            </fieldset>
            <Collection arbitraryIds title={w('会话路由', 'Chat routes')} rows={routing.chats ?? {}} create={() => ''} onChange={chats => route({ chats })}>
              {(_chat, target, change) => <Choice label={w('目标仓库', 'Target repository')} value={target} rows={value.repositories} onChange={change} />}
            </Collection>
            {sources.some(source => source.id === id) ? <Hint>{w('来源连接参数在来源设置中维护；此处管理绑定和路由。',
              'Edit connection options in Sources settings; manage bindings and routing here.')}</Hint>
              : schema?.fields.filter(field => field.type !== 'fact' && !(row.repositoryId && kind === 'github'
                && ['repository', 'cli'].includes(field.key))).map(field => <SourceField key={field.key} field={field}
              value={row.config[field.key]} saved={block.value.sources[id]?.config[field.key]} labels={schema.labels} fact={undefined}
              onChange={next => set({ ...row, config: { ...row.config, [field.key]: next } })} />)}
          </>
        }}
      </Collection>
      <h3 className="dt-block-title">{w('调度容量', 'Scheduler capacity')}</h3>
      <Field label={w('全局并发上限', 'Global worker limit')}><Input type="number" min={1} required value={value.scheduler.maxWorkers}
        onChange={event => edit({ scheduler: { ...value.scheduler, maxWorkers: Number(event.target.value) } })} /></Field>
      <Field label={w('每仓库并发上限（可选）', 'Per-repository worker limit (optional)')}><Input type="number" min={1}
        value={value.scheduler.maxWorkersPerRepository ?? ''} onChange={event => edit({ scheduler: {
          maxWorkers: value.scheduler.maxWorkers, ...event.target.value ? { maxWorkersPerRepository: Number(event.target.value) } : {} } })} /></Field>
    </Fields>
    <SaveBar {...draft} onDiscard={draft.discard} />
  </form>
}

/** Legacy Tickets deliberately have no inferred target. */
export function RepositoryBadge({ repository }: { repository?: string }) {
  const w = useWords()
  return repository ? <span className="dt-chip" title={w('目标仓库', 'Target repository')}>{repository}</span> : null
}
