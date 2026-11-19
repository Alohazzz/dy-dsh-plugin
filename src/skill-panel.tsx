import type * as ReactType from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { dshSkillTarget, type CatalogSkill, type SkillInstallation, type SkillSource, type SkillSourceInput, type SkillTarget } from './skill-catalog.ts'

type Rpc = <T>(method: string, input?: object) => Promise<T>
type SourceAction = 'git' | 'local' | 'rename' | 'unbind'
const time = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false })
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
const targetLabel = (target: SkillTarget) => {
  if (target.kind === 'project') return '项目 · ' + target.name
  return target.id === dshSkillTarget.id ? '.dsh Agent（实例共享）' : '会话 Agent · ' + target.name
}
const targetKey = (target: SkillTarget) => target.kind + ':' + target.id

export function createSkillPanel(React: typeof ReactType, rpc: Rpc) {
  const { useEffect, useLayoutEffect, useMemo, useRef, useState } = React

  function SourceDialog({ action, source, close, saved }: {
    action: SourceAction
    source?: SkillSource
    close: () => void
    saved: (source?: SkillSource, duplicate?: boolean) => void
  }) {
    const element = useRef<HTMLDialogElement>(null)
    const [name, setName] = useState(action === 'rename' ? source?.name ?? '' : '')
    const [location, setLocation] = useState('')
    const [branch, setBranch] = useState('')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const binding = action === 'git' || action === 'local'
    const title = { git: '绑定 Git 仓库', local: '添加本地目录', rename: '重命名来源', unbind: '解除绑定' }[action]
    useEffect(() => { element.current?.showModal() }, [])
    async function submit(event: ReactType.FormEvent) {
      event.preventDefault()
      if (busy) return
      setBusy(true)
      setError('')
      try {
        if (binding) {
          const input: SkillSourceInput = { kind: action, name, location, branch }
          const result = await rpc<{ source: SkillSource; duplicate: boolean }>('bindSkillSource', input)
          saved(result.source, result.duplicate)
        } else if (action === 'rename') {
          saved(await rpc<SkillSource>('renameSkillSource', { id: source?.id, name }))
        } else {
          await rpc('unbindSkillSource', { id: source?.id })
          saved()
        }
      } catch (failure) {
        setError(errorMessage(failure))
      } finally {
        setBusy(false)
      }
    }

    return <dialog className="dy-yx dy-yx-dialog dy-sk-dialog" ref={element} aria-label={title}
      onCancel={event => { event.preventDefault(); if (!busy) close() }}>
      <form onSubmit={submit}>
        <h2>{title}</h2>
        {action === 'unbind' ? <p>解除「{source?.name}」的绑定并清理工作台内的目录缓存？源文件将保留。</p> :
          <label>来源名称<input required autoFocus disabled={busy} value={name} onChange={event => setName(event.target.value)} /></label>}
        {binding && <label>{action === 'git' ? '仓库地址' : '本地目录'}
          <input required disabled={busy} value={location} onChange={event => setLocation(event.target.value)}
            placeholder={action === 'git' ? 'HTTPS 或 SSH 地址' : '本地目录的绝对路径'} />
        </label>}
        {action === 'git' && <label>分支<input disabled={busy} value={branch} onChange={event => setBranch(event.target.value)}
          placeholder="留空跟随仓库默认分支" /></label>}
        {error && <p className="dy-yx-error" role="alert">{error}</p>}
        <div className="dy-yx-actions">
          <button type="button" disabled={busy} onClick={close}>取消</button>
          <button className={action === 'unbind' ? undefined : 'dy-yx-primary'} disabled={busy}>
            {busy ? '处理中…' : binding ? '绑定并读取' : action === 'rename' ? '保存' : title}
          </button>
        </div>
      </form>
    </dialog>
  }

  function InstallationRows({ rows, remove }: { rows: SkillInstallation[]; remove: (row: SkillInstallation) => void }) {
    return rows.length ? <ul className="dy-sk-installations">
      {rows.map(row => <li key={row.id}>
        <div>
          <strong>{row.name}</strong> <small>{targetLabel(row.target)}</small>
          <div><small>{row.sourceName} · {row.path} · {row.commit ? row.commit.slice(0, 12) : time(row.readAt)}
            {row.broken && ' · 文件缺失'}</small></div>
        </div>
        <button onClick={() => remove(row)} aria-label={'从' + targetLabel(row.target) + '卸载 ' + row.name}>卸载</button>
      </li>)}
    </ul> : <p>未安装技能。</p>
  }

  function InstallationDialog({ operation, rows, close, saved }: {
    operation: { skill: CatalogSkill } | { remove: SkillInstallation }
    rows: SkillInstallation[]
    close: () => void
    saved: (rows: SkillInstallation[]) => void
  }) {
    const element = useRef<HTMLDialogElement>(null)
    const [targets, setTargets] = useState<SkillTarget[]>()
    const [selection, setSelection] = useState('')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const skill = 'skill' in operation ? operation.skill : undefined
    const remove = 'remove' in operation ? operation.remove : undefined
    const title = remove ? '卸载技能' : '安装技能'
    const target = targets?.find(item => targetKey(item) === selection)
    const projects = targets?.filter(item => item.kind === 'project')
    const agents = targets?.filter(item => item.kind === 'agent' && item.id !== dshSkillTarget.id)
    const dsh = targets?.find(item => item.kind === 'agent' && item.id === dshSkillTarget.id)
    const installed = new Set(rows.filter(row => row.sourceId === skill?.sourceId && row.path === skill?.path).map(row => targetKey(row.target)))
    function targetOption(item: SkillTarget) {
      const key = targetKey(item)
      const alreadyInstalled = installed.has(key)
      const name = item.kind === 'agent' && item.id === dshSkillTarget.id ? targetLabel(item) : item.name
      return <option key={key} value={key} disabled={alreadyInstalled}>{name}{alreadyInstalled && '（已安装）'}</option>
    }
    function loadTargets() {
      setError('')
      void rpc<SkillTarget[]>('skillTargets').then(setTargets, failure => setError(errorMessage(failure)))
    }
    useEffect(() => {
      element.current?.showModal()
      if (skill) loadTargets()
    }, [])
    async function submit(event: ReactType.FormEvent) {
      event.preventDefault()
      if (busy) return
      setBusy(true)
      setError('')
      try {
        if (remove) saved(await rpc<SkillInstallation[]>('uninstallSkill', { id: remove.id }))
        if (skill && target) saved(await rpc<SkillInstallation[]>('installSkill', {
          sourceId: skill.sourceId, path: skill.path, readAt: skill.readAt, targetKind: target.kind, targetId: target.id,
        }))
      } catch (failure) {
        setError(errorMessage(failure))
      } finally {
        setBusy(false)
      }
    }
    return <dialog ref={element} className="dy-yx dy-yx-dialog dy-sk-dialog" aria-label={title}
      onCancel={event => { event.preventDefault(); if (!busy) close() }}>
      <form onSubmit={submit}>
        <h2>{title}</h2>
        <p><strong>{skill?.name ?? remove?.name}</strong></p>
        {remove ? <p>从「{targetLabel(remove.target)}」卸载此技能？</p> : <>
          <label>安装目标<select required disabled={!targets?.length || busy} value={selection}
            onChange={event => setSelection(event.target.value)}>
            <option value="">{targets ? '选择安装目标' : '正在读取目标…'}</option>
            {!!projects?.length && <optgroup label="项目">{projects.map(targetOption)}</optgroup>}
            {!!agents?.length && <optgroup label="会话 Agent">{agents.map(targetOption)}</optgroup>}
            {dsh && targetOption(dsh)}
          </select></label>
          {target?.kind === 'agent' && <p>{target.id === dshSkillTarget.id ? '当前 DSH 实例中的 Agent 均可发现此技能。' :
            '仅所选会话的 Agent 可发现此技能。'}</p>}
        </>}
        {error && <p role="alert" className="dy-yx-error">{error} {skill && !targets &&
          <button type="button" onClick={loadTargets}>重试读取目标</button>}</p>}
        <div className="dy-yx-actions">
          <button type="button" disabled={busy} onClick={close}>取消</button>
          <button className={remove ? undefined : 'dy-yx-primary'} disabled={busy || (!remove && !target)}>
            {busy ? '处理中…' : remove ? '确认卸载' : '确认安装'}
          </button>
        </div>
      </form>
    </dialog>
  }

  return function SkillPanel() {
    const [sources, setSources] = useState<SkillSource[]>()
    const [selected, setSelected] = useState('')
    const [query, setQuery] = useState('')
    const [active, setActive] = useState('')
    const [action, setAction] = useState<SourceAction>()
    const [busy, setBusy] = useState<string[]>([])
    const [error, setError] = useState('')
    const [notice, setNotice] = useState('')
    const [installations, setInstallations] = useState<SkillInstallation[]>()
    const [installError, setInstallError] = useState('')
    const [operation, setOperation] = useState<{ skill: CatalogSkill } | { remove: SkillInstallation }>()
    const [view, setView] = useState<'catalog' | 'installed'>('catalog')
    const [detailTab, setDetailTab] = useState<'read' | 'files'>('read')
    const [installedTarget, setInstalledTarget] = useState('')
    const installationRead = useRef(0)
    const listElement = useRef<HTMLDivElement>(null)
    const scroll = useRef(0)
    const returnFocus = useRef(false)
    const returningPath = useRef('')
    const source = sources?.find(item => item.id === selected) ?? sources?.[0]
    const skill = source?.skills.find(item => item.path === active)
    const refreshing = !!source && busy.includes(source.id)
    const search = query.trim().toLowerCase()
    const results = source?.skills.filter(item => [item.name, item.description, item.path]
      .some(value => value.toLowerCase().includes(search))) ?? []
    const installationsByPath = useMemo(() => {
      const byPath = new Map<string, SkillInstallation[]>()
      for (const row of installations ?? []) {
        if (row.sourceId !== source?.id) continue
        const rows = byPath.get(row.path)
        if (rows) rows.push(row)
        else byPath.set(row.path, [row])
      }
      return byPath
    }, [installations, source?.id])
    const markdown = useMemo(() => skill && DOMPurify.sanitize(marked.parse(skill.markdown, { async: false }), {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['img', 'video', 'audio', 'source', 'iframe', 'form', 'input', 'button', 'style'],
      FORBID_ATTR: ['style', 'id', 'name', 'class'],
    }), [skill])

    function load() {
      setError('')
      void rpc<SkillSource[]>('skillSources').then(setSources, failure => setError(errorMessage(failure)))
    }
    function loadInstalled() {
      const read = ++installationRead.current
      setInstallError('')
      void rpc<SkillInstallation[]>('skillInstallations').then(rows => {
        if (read === installationRead.current) setInstallations(rows)
      }, failure => {
        if (read === installationRead.current) setInstallError(errorMessage(failure))
      })
    }
    useEffect(load, [])
    useEffect(loadInstalled, [])
    useLayoutEffect(() => {
      const element = listElement.current
      if (!element) return
      element.scrollTop = scroll.current
      if (returnFocus.current) {
        element.querySelector<HTMLButtonElement>('[data-skill-return]')?.focus({ preventScroll: true })
        returnFocus.current = false
      }
    }, [skill, source?.id])

    function replace(result: SkillSource) {
      setSources(previous => {
        const items = previous ?? []
        return items.some(item => item.id === result.id) ?
          items.map(item => item.id === result.id ? result : item) : [...items, result]
      })
    }
    function select(id: string) {
      setSelected(id)
      setActive('')
      scroll.current = 0
      if (listElement.current) listElement.current.scrollTop = 0
      setError('')
      setNotice('')
    }
    async function refresh(target: SkillSource) {
      setBusy(ids => [...ids, target.id])
      setError('')
      setNotice('')
      try {
        replace(await rpc<SkillSource>('refreshSkillSource', { id: target.id }))
      } catch (failure) {
        setError(target.name + '：' + errorMessage(failure))
      } finally {
        setBusy(ids => ids.filter(id => id !== target.id))
      }
    }
    function saved(result?: SkillSource, duplicate?: boolean) {
      if (result) {
        replace(result)
        if (action !== 'rename') {
          select(result.id)
          setQuery('')
        }
        if (duplicate) setNotice('此来源已绑定，已打开现有目录。')
      } else if (source) {
        setSources(items => items?.filter(item => item.id !== source.id))
        select('')
      }
      setAction(undefined)
    }

    return <main className="dy-yx dy-sk">
      <header><div><h2>技能管理</h2><div className="dy-sk-tabs">
        <button aria-pressed={view === 'catalog'} onClick={() => setView('catalog')}>技能目录</button>
        <button aria-pressed={view === 'installed'} onClick={() => { setView('installed'); loadInstalled() }}>已安装</button>
      </div></div>
        <div className="dy-yx-actions">
          <button disabled={!sources} onClick={() => setAction('git')}>绑定 Git 仓库</button>
          <button disabled={!sources} onClick={() => setAction('local')}>添加本地目录</button>
        </div>
      </header>
      {installError && <p role="alert" className="dy-yx-error">{installError} <button onClick={loadInstalled}>重试读取安装状态</button></p>}
      {view === 'installed' && <section aria-label="已安装技能" className="dy-sk-scroll">
        {installations ? <>
          <label>安装目标 <select value={installedTarget} onChange={event => setInstalledTarget(event.target.value)}>
            <option value="">所有安装目标</option>
            {[...new Map(installations.map(row => [targetKey(row.target), row.target])).values()].map(item =>
              <option key={targetKey(item)} value={targetKey(item)}>{targetLabel(item)}</option>)}
          </select></label>
          <InstallationRows rows={installations.filter(row => !installedTarget || targetKey(row.target) === installedTarget)}
            remove={remove => setOperation({ remove })} />
        </> : !installError && <p role="status">正在读取安装状态…</p>}
      </section>}
      <div className="dy-sk-catalog" hidden={view !== 'catalog'}>
      {error && <p role="alert" className="dy-yx-error">{error} {!sources && <button onClick={load}>重试读取</button>}</p>}
      {notice && <p role="status">{notice}</p>}
      {!sources && !error && <p role="status">正在读取技能源…</p>}
      {sources && !source && <p>尚未绑定技能源。</p>}
      {source && <>
        <div className="dy-sk-toolbar">
          <label>技能源 <select value={source.id} onChange={event => select(event.target.value)}>
            {sources?.map(item => <option key={item.id} value={item.id}>{item.name} · {item.kind === 'git' ? 'Git' : '本地'}</option>)}
          </select></label>
          <button onClick={() => void refresh(source)} disabled={refreshing}>{refreshing ? '刷新中…' : '刷新'}</button>
          <button onClick={() => setAction('rename')} disabled={refreshing}>重命名</button>
          <button onClick={() => setAction('unbind')} disabled={refreshing}>解除绑定</button>
        </div>
        <details className="dy-sk-status">
          <summary>来源信息 · {source.skills.length} 个技能</summary>
          <span>{source.location}</span>
          {source.kind === 'git' && <span>分支 {source.actualBranch} · {source.branch ? '固定分支' : '跟随默认分支'}</span>}
          {source.commit && <code title={source.commit}>{source.commit.slice(0, 12)}</code>}
          <span>{refreshing ? '正在刷新 · ' : ''}上次读取 {time(source.readAt)} · {source.skills.length} 个技能</span>
        </details>
        {source.error && <p role="alert" className="dy-yx-error">刷新失败，正在显示上次结果。{source.error}</p>}
        {!!source.problems.length && <details className="dy-sk-status">
          <summary>{source.problems.length} 项读取异常</summary>
          <ul>{source.problems.map(({ path, error }) => <li key={path}><code>{path}</code> · {error}</li>)}</ul>
        </details>}
        {!!source.removed.length && <details className="dy-sk-status">
          <summary>本次刷新移除 {source.removed.length} 项</summary>
          <ul>{source.removed.map(path => <li key={path}><code>{path}</code></li>)}</ul>
        </details>}
        <div className="dy-sk-split" data-selected={!!skill}>
          <section className="dy-sk-index" aria-label="技能目录">
          <input type="search" aria-label="搜索技能" placeholder="搜索技能名称、简介或路径"
            value={query} onChange={event => { setQuery(event.target.value); scroll.current = 0; if (listElement.current) listElement.current.scrollTop = 0 }} />
          <div className="dy-sk-scroll" ref={listElement}>
            {!results.length && <p>{search ? '没有匹配的技能。' : '此来源没有可浏览的技能。'}</p>}
            <ul className="dy-sk-list">{results.map(item => {
              const rows = installationsByPath.get(item.path) ?? []
              const missing = rows.filter(row => row.broken).length
              const status = installError ? '状态不可用' : !installations ? '读取中…' :
                missing ? `文件缺失 · ${missing}/${rows.length}` : rows.length ? `已安装 · ${rows.length}` : '未安装'
              const tone = installError || !installations ? undefined : missing ? 'missing' : rows.length ? 'installed' : undefined
              return <li key={item.path}>
                <button data-skill-return={returningPath.current === item.path ? '' : undefined}
                  aria-current={skill?.path === item.path ? 'true' : undefined} onClick={() => {
                    scroll.current = listElement.current?.scrollTop ?? 0
                    returningPath.current = item.path
                    setActive(item.path)
                    setDetailTab('read')
                  }}>
                  <strong>{item.name}</strong>
                  <span className="dy-sk-install-status" data-tone={tone}
                    title={tone === 'missing' ? `${rows.length} 个安装目标，${missing} 个目标文件缺失` :
                      tone === 'installed' ? `已安装到 ${rows.length} 个目标` : undefined}>{status}</span>
                  <small title={item.path}>{source.skills.some(other => other.path !== item.path && other.name === item.name) ?
                    item.path : item.description || '未提供简介'}{item.stale && ' · 上次成功结果'}</small>
                </button>
              </li>
            })}</ul>
          </div>
          </section>
          <section className="dy-sk-reader dy-sk-scroll" key={skill?.path} aria-label="技能详情">
            {skill ? <>
              <button className="dy-sk-back" onClick={() => { returnFocus.current = true; setActive('') }}>返回技能目录</button>
              <article className="dy-sk-detail">
                <div className="dy-sk-detail-heading"><h3>{skill.name}</h3>
                  <button className="dy-yx-primary" onClick={() => setOperation({ skill })}
                    disabled={!installations || !!skill.stale} title={skill.stale ? '刷新来源后再安装' : undefined}>安装到…</button>
                </div>
                <div className="dy-sk-detail-body">
                  <div className="dy-sk-detail-info">
                    <code>{skill.path}</code>
                    <p><small>{skill.stale ? '上次成功结果 · ' : ''}{time(skill.readAt)}{skill.version && ' · 版本 ' + skill.version}
                      {skill.commit && <> · 来源提交 <code>{skill.commit}</code></>}</small></p>
                    {!!skill.missing.length && <p>说明缺少字段 {skill.missing.join('、')}</p>}
                    {installations && <section aria-label="当前技能安装状态">
                      <InstallationRows rows={installationsByPath.get(skill.path) ?? []}
                        remove={remove => setOperation({ remove })} />
                    </section>}
                  </div>
                  <div className="dy-sk-detail-content">
                    {skill.description && <p className="dy-sk-description">{skill.description}</p>}
                    <div className="dy-sk-tabs">
                      <button aria-pressed={detailTab === 'read'} onClick={() => setDetailTab('read')}>技能说明</button>
                      <button aria-pressed={detailTab === 'files'} onClick={() => setDetailTab('files')}>配套文件（{skill.files.length}）</button>
                    </div>
                    {detailTab === 'read' ? <div className="dy-sk-markdown" dangerouslySetInnerHTML={{ __html: markdown ?? '' }} />
                      : skill.files.length ? <ul>{skill.files.map(file => <li key={file}><code>{file}</code></li>)}</ul> : <p>无配套文件。</p>}
                  </div>
                </div>
              </article>
            </> : <p className="dy-yx-meta">从左侧目录选择一个技能。</p>}
          </section>
        </div>
      </>}
      </div>
      {action && <SourceDialog action={action} source={source} close={() => setAction(undefined)} saved={saved} />}
      {operation && <InstallationDialog operation={operation} rows={installations ?? []} close={() => setOperation(undefined)}
        saved={rows => {
          installationRead.current++
          setInstallError('')
          setInstallations(rows)
          setOperation(undefined)
          setInstalledTarget('')
        }} />}
    </main>
  }
}
