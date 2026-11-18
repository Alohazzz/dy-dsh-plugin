import type * as ReactType from 'react'
import type { ConnectionSettings, Details, Issue, Meta, Option, Plan, PlanResult, Preview } from './contracts.ts'

type Navigation = { openSession(id: string): void }
type Slots = {
  inject(name: string, register: () => unknown): void
  register(slot: { name: string; id?: string; key?: string; label?: string; order?: number; inject?: () => object },
    component: ReactType.ComponentType<any>): unknown
}
declare const window: Window & { __ModuleLoader__: { load(plugin: {
  id: string; factory(require: (name: 'react') => typeof ReactType): object
}): void } }

async function rpc<T>(method: string, input: object = {}, signal?: AbortSignal): Promise<T> {
  const result = await fetch('/api/dy-yunxiao', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, input }), signal,
  })
  const payload = await result.json().catch(() => null)
  if (!result.ok || !payload || 'error' in payload) throw new Error(payload?.error || 'DSH 请求失败（' + result.status + '）')
  return payload.value
}

const dayKey = (date: Date) => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date)
function dateRange(kind: string): [string, string] {
  if (!kind || kind === 'custom') return ['', '']
  const today = new Date(dayKey(new Date()) + 'T12:00:00+08:00')
  if (kind === 'month') {
    const [year, month] = dayKey(today).split('-').map(Number)
    return [dayKey(new Date(Date.UTC(year, month - 1, 1))), dayKey(new Date(Date.UTC(year, month, 0)))]
  }
  const monday = today.getTime() - ((today.getUTCDay() + 6) % 7) * 86400000
  return [dayKey(new Date(monday)), dayKey(new Date(monday + 6 * 86400000))]
}
const categories: Record<string, string> = { Req: '需求', Bug: '缺陷', Task: '任务' }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

const emptyConditions = {
  category: '', query: '', mine: false, period: '', from: '', to: '',
  status: [] as string[], product: [] as string[], version: [] as string[],
}
type Selection = typeof emptyConditions & { project: string; workspaceId: string }

function preferenceKey(meta: Meta) {
  return 'dy-yunxiao:selection:v1:' + JSON.stringify([meta.organization, meta.user])
}

function restoreSelection(meta: Meta, preferDefault: boolean): Selection {
  let saved: Partial<Selection> = {}
  try {
    saved = JSON.parse(localStorage.getItem(preferenceKey(meta)) || '{}') || {}
  } catch { /* Use defaults when storage is unavailable. */ }
  const available = (id: unknown, options: Option[]) =>
    typeof id === 'string' && (!id || options.some(option => option.id === id))
  const project = !preferDefault && available(saved.project, meta.projects) ? saved.project! :
    meta.projects.find(item => item.id === meta.defaultProject)?.id || meta.projects[0]?.id || ''
  const workspaceId = available(saved.workspaceId, meta.workspaces) ? saved.workspaceId! : meta.workspaces[0]?.id || ''
  const selection = { ...emptyConditions, project, workspaceId }
  if (!project || project !== saved.project) return selection
  for (const key of ['status', 'product', 'version'] as const) {
    if (Array.isArray(saved[key])) selection[key] = saved[key].filter(id => typeof id === 'string')
  }
  selection.mine = saved.mine === true
  selection.query = typeof saved.query === 'string' ? saved.query : ''
  selection.category = saved.category && Object.hasOwn(categories, saved.category) ? saved.category : ''
  selection.period = ['custom', 'week', 'month'].includes(saved.period || '') ? saved.period! : ''
  if (selection.period === 'custom') {
    selection.from = typeof saved.from === 'string' ? saved.from : ''
    selection.to = typeof saved.to === 'string' ? saved.to : ''
  } else {
    ;[selection.from, selection.to] = dateRange(selection.period)
  }
  return selection
}

type Modal =
  | { kind: 'discuss' | 'add' | 'create'; issues: Issue[] }
  | { kind: 'start' | 'publish' | 'move'; issue: Issue }

window.__ModuleLoader__.load({
  id: 'dy-dsh-plugin',
  factory(require) {
    const React = require('react')
    const { useEffect, useRef, useState } = React

    function Multi({ title, options, values, change }: {
      title: string; options: Option[]; values: string[]; change(value: string[]): void
    }) {
      const menu = useRef<HTMLDivElement>(null)
      const trigger = useRef<HTMLButtonElement>(null)
      const id = React.useId()
      const [open, setOpen] = useState(false)
      return <div className="dy-yx-multi" onBlur={event => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) menu.current?.hidePopover()
      }}>
        <button ref={trigger} type="button" popoverTarget={id} aria-expanded={open} aria-controls={id}
          className="dy-yx-filter-trigger" data-selected={values.length > 0}>
          {values.length ? title + ' · ' + values.length : '全部' + title}
        </button>
        <div id={id} ref={menu} popover="auto" role="group" aria-label={title}
          onToggle={event => setOpen(event.currentTarget.matches(':popover-open'))}>
          {options.length === 0 && <small>暂无可选{title}</small>}
          {options.map(item => <label key={item.id}><input type="checkbox" checked={values.includes(item.id)}
            onChange={event => {
              change(event.target.checked ? [...values, item.id] : values.filter(id => id !== item.id))
              menu.current?.hidePopover()
              trigger.current?.focus()
            }} />
            {item.name}</label>)}
        </div>
      </div>
    }

    function Attachment({ file }: { file: Details['files'][number] }) {
      const viewer = useRef<HTMLDialogElement>(null)
      const [original, setOriginal] = useState(false)
      const [open, setOpen] = useState(false)
      const [failed, setFailed] = useState(false)
      if (!file.url) return <>{file.name}</>
      if (!file.image) return <a href={file.url} target="_blank" rel="noreferrer">{file.name}</a>
      function preview() {
        setOriginal(false)
        setFailed(false)
        setOpen(true)
        viewer.current?.showModal()
      }
      return <>
        <button type="button" className="dy-yx-image-link" onClick={preview}>{file.name}</button>
        <button type="button" className="dy-yx-thumbnail" aria-label={'预览 ' + file.name} onClick={preview}>
          <img className="dy-yx-attachment" src={file.url} alt="" loading="lazy" referrerPolicy="no-referrer" />
        </button>
        <dialog ref={viewer} className="dy-yx-viewer" aria-label="图片预览"
          onCancel={event => event.stopPropagation()} onClose={() => setOpen(false)}>
          <div className="dy-yx-viewer-head">
            <strong>{file.name}</strong>
            <button type="button" disabled={failed} onClick={() => setOriginal(!original)}>{original ? '适应窗口' : '原始尺寸'}</button>
            <button type="button" autoFocus onClick={() => viewer.current?.close()}>关闭预览</button>
          </div>
          <div className="dy-yx-image-stage" data-original={original}>
            {open && (failed ? <p role="alert">图片加载失败，请关闭预览并刷新议题后重试。</p> :
              <img src={file.url} alt={file.name} referrerPolicy="no-referrer" onError={() => setFailed(true)} />)}
          </div>
        </dialog>
      </>
    }

    function Panel({ ctx }: { ctx: { uiWorkspace: Navigation } }) {
      const [meta, setMeta] = useState<Meta>()
      const [metaError, setMetaError] = useState('')
      const [selection, setSelection] = useState<Selection>({ ...emptyConditions, project: '', workspaceId: '' })
      const { project, workspaceId, category, mine, query, status, product, version, period, from, to } = selection
      function updateSelection(patch: Partial<Selection>) {
        setSelection(previous => ({ ...previous, ...patch }))
      }
      const [opts, setOpts] = useState({ statuses: [] as Option[], versions: [] as Option[], products: [] as string[] })
      const [seenProducts, setSeenProducts] = useState<string[]>([])
      const [optsError, setOptsError] = useState('')
      const [rows, setRows] = useState<Issue[]>([])
      const [more, setMore] = useState(false)
      const [page, setPage] = useState(1)
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(false)
      const [revision, refresh] = useState(0)
      const [active, setActive] = useState<Issue>()
      const [detail, setDetail] = useState<Details>()
      const [detailError, setDetailError] = useState('')
      const [marked, setMarked] = useState<Issue[]>([])
      const [modal, setModal] = useState<Modal>()
      const [settingsOpen, setSettingsOpen] = useState(false)
      const [notice, setNotice] = useState('')
      const [pending, setPending] = useState<Record<string, string>>({})
      const listGeneration = useRef(0)
      const filters = { project, workspaceId, query, category, mine, status, version, from, to }
      const productOptions = [...new Set(opts.products.concat(seenProducts, product))]
      const today = dayKey(new Date())
      const visible = rows.filter(row => (!product.length || product.includes(row.product)) &&
        ((!from && !to) || (row.deadline && (!from || row.deadline >= from) && (!to || row.deadline <= to))))

      async function connect(preferDefault = false) {
        setMetaError('')
        try {
          const value = await rpc<Meta>('meta')
          setMeta(value)
          setSelection(restoreSelection(value, preferDefault))
          refresh(value => value + 1)
        } catch (failure) { setMetaError(errorText(failure)) }
      }

      useEffect(() => {
        if (!meta || meta.setupError) return
        try {
          localStorage.setItem(preferenceKey(meta), JSON.stringify(selection))
        } catch { /* Keep filtering available when storage is disabled. */ }
      }, [meta, selection])

      useEffect(() => { void connect() }, [])
      useEffect(() => {
        if (!project) return
        const abort = new AbortController()
        setOptsError('')
        rpc<typeof opts>('filters', { project }, abort.signal).then(setOpts, failure => {
          if (!abort.signal.aborted) setOptsError(errorText(failure))
        })
        return () => abort.abort()
      }, [project, revision])

      async function load(pageNumber: number, filtersSnapshot = filters, signal?: AbortSignal) {
        const generation = ++listGeneration.current
        setError('')
        setLoading(true)
        try {
          const result = await rpc<{ rows: Issue[]; more: boolean }>('search', {
            ...filtersSnapshot, page: pageNumber,
          }, signal)
          if (generation !== listGeneration.current) return
          setRows(previous => pageNumber === 1 ? result.rows : [...new Map(previous.concat(result.rows).map(issue => [issue.id, issue])).values()])
          setSeenProducts(previous => [...new Set(previous.concat(result.rows.map(row => row.product).filter(Boolean)))])
          setMore(result.more)
          setPage(pageNumber)
        } catch (failure) {
          if (generation === listGeneration.current && !signal?.aborted) setError(errorText(failure))
        } finally {
          if (generation === listGeneration.current && !signal?.aborted) setLoading(false)
        }
      }

      useEffect(() => {
        setRows([])
        setMore(false)
        if (!project) return
        const abort = new AbortController()
        const timer = setTimeout(() => { void load(1, filters, abort.signal) }, 180)
        return () => {
          clearTimeout(timer)
          abort.abort()
          listGeneration.current++
        }
      }, [project, workspaceId, category, mine, query, status, version, from, to, opts, revision])

      useEffect(() => {
        setDetail(undefined)
        setDetailError('')
        if (!active) return
        const abort = new AbortController()
        rpc<Details>('detail', { project, id: active.id, workspaceId }, abort.signal).then(setDetail, failure => {
          if (!abort.signal.aborted) setDetailError(errorText(failure))
        })
        return () => abort.abort()
      }, [active, workspaceId, revision])

      function reset() {
        updateSelection(emptyConditions)
        setMarked([])
      }

      function clearContext() {
        setActive(undefined); setMarked([]); setNotice('')
      }

      function passed(issue: Issue, result: string) {
        setNotice(issue.reference + ' · ' + result)
        refresh(value => value + 1)
      }

      function openModal(kind: 'start' | 'publish' | 'move', issue: Issue) {
        if (active?.id !== issue.id) setDetailError('')
        setActive(issue)
        setModal({ kind, issue })
      }

      if (!meta && !metaError) return <main className="dy-yx">正在读取 DSH 工作区与云效配置…</main>
      return <main className="dy-yx">
        <header><div><h1>云效议题</h1><small>{meta?.user ? '已连接 · ' + meta.organization + ' · ' + meta.user : '云效连接待配置'}</small></div>
          <div className="dy-yx-actions">
            <button onClick={() => refresh(value => value + 1)}>刷新</button>
            <button onClick={() => void connect()}>重新连接</button>
            <button className={meta?.setupError ? 'dy-yx-primary' : undefined} onClick={() => setSettingsOpen(true)}>连接设置</button>
          </div>
        </header>
        {(metaError || meta?.setupError) && <div role="alert" className="dy-yx-error">
          {metaError || meta?.setupError}
        </div>}
        <div className="dy-yx-bar dy-yx-context">
          <label>云效项目 <select value={project} onChange={event => {
            clearContext(); reset(); setOpts({ statuses: [], versions: [], products: [] }); setSeenProducts([]); updateSelection({ project: event.target.value })
          }}><option value="">请选择</option>{meta?.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>目标工作区 <select value={workspaceId} onChange={event => { clearContext(); updateSelection({ workspaceId: event.target.value }) }}>
            <option value="">请选择</option>{meta?.workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
          <button disabled={!workspaceId || !project} onClick={() => setModal({ kind: 'create', issues: [] })}>创建计划</button>
        </div>
        {project && <>
          <div className="dy-yx-bar dy-yx-filters" aria-label="筛选议题">
            <select aria-label="议题类型" value={category} onChange={event => updateSelection({ category: event.target.value })}>
              <option value="">全部类型</option>{Object.entries(categories).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
            <label><input type="checkbox" checked={mine} onChange={event => updateSelection({ mine: event.target.checked })} /> 我负责的</label>
            <Multi title="状态" options={opts.statuses} values={status} change={status => updateSelection({ status })} />
            <Multi title="产品" options={productOptions.map(name => ({ name, id: name }))} values={product} change={product => updateSelection({ product })} />
            <Multi title="版本" options={opts.versions} values={version} change={version => updateSelection({ version })} />
            <select aria-label="计划完成日期" value={period} onChange={event => {
              const [start, end] = dateRange(event.target.value)
              updateSelection({ period: event.target.value, from: start, to: end })
            }}>
              <option value="">全部日期</option><option value="week">本周</option><option value="month">本月</option><option value="custom">自定义日期</option>
            </select>
            {period === 'custom' && <>
              <input aria-label="截止日期起" type="date" value={from} onChange={event => updateSelection({ from: event.target.value })} />
              <input aria-label="截止日期止" type="date" value={to} onChange={event => updateSelection({ to: event.target.value })} />
            </>}
            <input aria-label="编号或标题" placeholder="按编号或标题搜索" value={query} onChange={event => updateSelection({ query: event.target.value })} />
            <button onClick={reset}>清空筛选</button>
          </div>
          {optsError && <div role="alert" className="dy-yx-error">筛选选项加载失败。{optsError} <button onClick={() => refresh(value => value + 1)}>重试</button></div>}
          {notice && <div className="dy-yx-notice" role="status">{notice}</div>}
          {marked.length > 0 && <div className="dy-yx-bar dy-yx-selection">
            <strong>已选 {marked.length} 项</strong>
            <button disabled={!workspaceId} onClick={() => setModal({ kind: 'discuss', issues: marked })}>发起讨论</button>
            <button disabled={!workspaceId} onClick={() => setModal({ kind: 'add', issues: marked })}>添加到计划</button>
            <button onClick={() => setMarked([])}>取消选择</button>
          </div>}
          <div className="dy-yx-layout" data-detail={Boolean(active)}>
            <section aria-label="议题列表" className="dy-yx-list">
              <div className="dy-yx-list-head">议题列表 <small>{visible.length} 条{more ? ' · 可加载更多' : ''}</small></div>
              {visible.map(issue => <article key={issue.id} aria-current={active?.id === issue.id} className="dy-yx-row"
                onClick={event => {
                  if (event.target instanceof Element && !event.target.closest('button, a, input')) setActive(issue)
                }}>
                <input type="checkbox" aria-label={'勾选 ' + issue.reference} disabled={Boolean(issue.plan || issue.sessionId || issue.id === detail?.id && detail.sessionId)}
                  checked={marked.some(item => item.id === issue.id)}
                  onChange={event => {
                    const checked = event.target.checked
                    setMarked(items => checked ? [...items, issue] : items.filter(item => item.id !== issue.id))
                  }} />
                <div>
                  <button className="dy-yx-title" onClick={() => setActive(issue)}>{issue.title || issue.reference}</button>
                  <div className="dy-yx-meta"><a href={issue.url} target="_blank" rel="noreferrer" title="在云效打开">{issue.reference}</a>
                    <span>{categories[issue.category] || issue.category}</span><span className="dy-yx-tag">{issue.state.name}</span>
                    {[issue.product, issue.priority, issue.owner, issue.created && '创建 ' + issue.created].filter(Boolean).map((item, i) => <span key={i}>{item}</span>)}
                    {issue.deadline && <span className={issue.deadline < today && !['已完成','已关闭'].includes(issue.state.name) ? 'dy-yx-overdue' : ''}>截止 {issue.deadline}</span>}
                    {issue.plan && <span className="dy-yx-tag">{issue.plan}</span>}
                  </div>
                  {marked.length === 0 && <div className="dy-yx-actions">
                    <button disabled={!workspaceId} onClick={() => issue.sessionId ? ctx.uiWorkspace.openSession(issue.sessionId) : openModal('start', issue)}>
                      {issue.sessionId ? '返回绑定会话' : '直接开工'}</button>
                    {!issue.plan && <button disabled={!workspaceId} onClick={() => setModal({ kind: 'add', issues: [issue] })}>加到计划</button>}
                    {!issue.plan && !issue.sessionId && <button disabled={!workspaceId} onClick={() => setModal({ kind: 'discuss', issues: [issue] })}>发起讨论</button>}
                  </div>}
                </div>
              </article>)}
              {loading && <p role="status">正在读取议题…</p>}
              {error && <p role="alert">{error} <button onClick={() => void load(rows.length ? page + 1 : 1)}>重试</button></p>}
              {!loading && !error && !visible.length && <p>当前没有匹配议题{more ? '，可继续加载' : ''}。</p>}
              {more && <button disabled={loading} onClick={() => void load(page + 1)}>加载更多</button>}
            </section>
            <section aria-label="议题详情" className="dy-yx-detail">
              {!active && <p>选择议题查看详情。</p>}
              {active && <>
                <button className="dy-yx-back" onClick={() => setActive(undefined)}>返回列表</button>
                <h2>{active.title}</h2>
                <div className="dy-yx-meta"><a href={active.url} target="_blank" rel="noreferrer">在云效打开 · {active.reference}</a>
                  <span className="dy-yx-tag">{detail?.state.name || active.state.name}</span></div>
                <div className="dy-yx-actions">
                  {detail?.sessionId
                    ? <button className="dy-yx-primary" onClick={() => ctx.uiWorkspace.openSession(detail.sessionId!)}>返回绑定会话</button>
                    : <button className="dy-yx-primary" disabled={!workspaceId} onClick={() => openModal('start', active)}>直接开工</button>}
                  <button disabled={!detail?.sessionId} onClick={() => openModal('publish', active)}>回写预览</button>
                  <button onClick={() => openModal('move', active)}>{(pending[active.id] || detail?.pendingTarget) ? '回查状态' : '状态流转'}</button>
                </div>
                {detailError && <p role="alert">{detailError} <button onClick={() => refresh(value => value + 1)}>重试读取</button></p>}
                {!detail && !detailError && <p role="status">正在读取议题详情…</p>}
                {detail && <>
                  <h3>议题正文</h3><p className="dy-yx-description">{detail.text || '无正文'}</p>
                  {detail.materialsError && <p role="alert">{detail.materialsError}</p>}
                  {detail.files.length > 0 && <><h3>附件与正文图片</h3><ul>
                    {detail.files.map((file, i) => <li key={i}>
                      <Attachment file={file} />
                    </li>)}
                  </ul></>}
                </>}
              </>}
            </section>
          </div>
        </>}
        {settingsOpen && <SettingsDialog close={() => setSettingsOpen(false)} onChange={async () => {
          clearContext()
          setOpts({ statuses: [], versions: [], products: [] })
          setSeenProducts([])
          setPending({})
          await connect(true)
        }} />}
        {modal && <Dialog key={modal.kind} modal={modal} detail={'issue' in modal && detail?.id === modal.issue.id ? detail : undefined} detailError={detailError} meta={meta}
          workspaceId={workspaceId} project={project} close={() => setModal(undefined)} pending={pending}
          setPending={(id, target) => setPending(previous => ({ ...previous, [id]: target }))}
          refresh={() => refresh(value => value + 1)} onSuccess={passed}
          onPlan={() => { setMarked([]); refresh(value => value + 1) }}
          onOpenSession={id => { setModal(undefined); refresh(value => value + 1); ctx.uiWorkspace.openSession(id) }} />}
      </main>
    }

    function SettingsDialog({ close, onChange }: { close(): void; onChange(): Promise<void> }) {
      const element = useRef<HTMLDialogElement>(null)
      const [settings, setSettings] = useState<ConnectionSettings>()
      const [organization, setOrganization] = useState('')
      const [project, setProject] = useState('')
      const [token, setToken] = useState('')
      const [organizations, setOrganizations] = useState<Option[] | undefined>()
      const [projects, setProjects] = useState<Option[] | undefined>()
      const [manual, setManual] = useState(false)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [confirmClear, setConfirmClear] = useState(false)
      const [revision, retry] = useState(0)

      useEffect(() => {
        const dialog = element.current!
        dialog.showModal()
        return () => dialog.close()
      }, [])

      useEffect(() => {
        const abort = new AbortController()
        setError('')
        rpc<ConnectionSettings>('connectionSettings', {}, abort.signal).then(value => {
          setSettings(value)
          setOrganization(value.organization)
          setProject(value.project)
        }, failure => {
          if (!abort.signal.aborted) setError(errorText(failure))
        })
        return () => abort.abort()
      }, [revision])

      async function loadProjects(org: string, selection: string) {
        setBusy('projects')
        const next = await rpc<Option[]>('connectionProjects', { token, organization: org })
        setProjects(next)
        setProject(next.find(item => item.id === selection)?.id || next[0]?.id || '')
        if (!next.length) setNotice('该组织下暂无可访问项目。')
      }

      async function run(action: 'organizations' | 'projects' | 'testConnection' | 'saveConnection' | 'clearConnection') {
        if (busy) return
        setBusy(action)
        setError('')
        setNotice('')
        try {
          if (action === 'organizations') {
            const next = await rpc<Option[]>('connectionOrganizations', { token })
            setOrganizations(next)
            const org = next.length === 1 ? next[0].id : next.find(item => item.id === organization)?.id || ''
            setOrganization(org)
            setProjects(undefined)
            setProject(org === organization ? project : '')
            if (next.length === 1) await loadProjects(org, org === organization ? project : '')
            if (!next.length) setNotice('当前 Token 未返回可访问组织。')
          } else if (action === 'projects') {
            await loadProjects(organization.trim(), project.trim())
          } else if (action === 'testConnection') {
            const result = await rpc<{ user: string; projectCount: number }>(action, { token, organization, project })
            setNotice(`连接成功 · ${result.user} · ${result.projectCount} 个可访问项目`)
          } else {
            await rpc(action, action === 'clearConnection' ? {} : { token, organization, project })
            setToken('')
            await onChange()
            close()
          }
        } catch (failure) {
          setError(errorText(failure))
        } finally {
          setBusy('')
        }
      }

      function resetFeedback() {
        setNotice('')
        setError('')
        setConfirmClear(false)
      }

      const hasToken = Boolean(settings && (token.trim() || settings.hasToken))
      const canSubmit = Boolean(hasToken && organization.trim())
      function changeOrganization(value: string) {
        setOrganization(value)
        setProjects(undefined)
        setProject('')
        resetFeedback()
      }
      const status = settings?.source === 'saved' ? '已保存 Token。留空继续使用，填入新 Token 即可更换。'
        : settings?.source === 'env' ? '当前使用环境变量提供的 Token。留空继续使用。' : '需要云效中心版个人访问令牌。'
      return <dialog className="dy-yx dy-yx-dialog" ref={element} aria-labelledby="dy-yx-settings-title"
        onCancel={event => { event.preventDefault(); if (!busy) close() }}>
        <form onSubmit={event => { event.preventDefault(); if (canSubmit && !busy) void run('saveConnection') }}>
          <h2 id="dy-yx-settings-title">云效连接设置</h2>
          {!settings && !error && <p role="status">正在读取连接配置…</p>}
          {settings && <fieldset disabled={Boolean(busy)}>
            <label>云效 Token<input type="password" name="yunxiaoToken" autoComplete="new-password" spellCheck={false}
              placeholder={settings.hasToken ? '填写新 Token' : '粘贴个人访问令牌'} maxLength={4096}
              value={token} onChange={event => {
                setToken(event.target.value)
                setOrganizations(undefined)
                setOrganization(settings.organization)
                setProjects(undefined)
                setProject(settings.project)
                resetFeedback()
              }} aria-describedby="dy-yx-token-status" /></label>
            <p id="dy-yx-token-status"><small>{status}</small></p>
            <div className="dy-yx-actions dy-yx-discovery">
              <button type="button" disabled={!hasToken} onClick={() => void run('organizations')}>
                {busy === 'organizations' ? '正在获取组织…' : '获取组织'}
              </button>
              <button type="button" onClick={() => setManual(value => !value)}>{manual ? '按名称选择' : '手动填写 ID'}</button>
            </div>
            {manual ? <label>组织 ID<input value={organization} maxLength={128} spellCheck={false}
              onChange={event => changeOrganization(event.target.value)} /></label>
              : <label>云效组织<select value={organization} disabled={!organizations?.length}
                onChange={event => changeOrganization(event.target.value)}>
                <option value="">{organizations?.length ? '请选择组织' : '请先获取组织'}</option>
                {organization && !organizations?.some(item => item.id === organization) &&
                  <option value={organization}>{organization}</option>}
                {organizations?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select></label>}
            <div className="dy-yx-actions dy-yx-discovery">
              <button type="button" disabled={!canSubmit} onClick={() => void run('projects')}>
                {busy === 'projects' ? '正在获取项目…' : '获取项目'}
              </button>
            </div>
            {manual ? <label>默认项目 ID（选填）<input value={project} maxLength={128} spellCheck={false}
              onChange={event => { setProject(event.target.value); resetFeedback() }} /></label>
              : <label>默认项目（选填）<select value={project} disabled={!projects?.length}
                onChange={event => { setProject(event.target.value); resetFeedback() }}>
                <option value="">{projects?.length ? '暂不指定默认项目' : '请先获取项目'}</option>
                {project && !projects?.some(item => item.id === project) && <option value={project}>{project}</option>}
                {projects?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select></label>}
            {settings.source === 'saved' && <div className="dy-yx-actions">
              {confirmClear && <small>移除本地保存的连接设置。已配置环境变量时将恢复使用环境变量。</small>}
              <button type="button" onClick={() => {
                if (confirmClear) void run('clearConnection')
                else setConfirmClear(true)
              }}>{confirmClear ? '确认清除' : '清除已保存设置'}</button>
              {confirmClear && <button type="button" onClick={() => setConfirmClear(false)}>取消清除</button>}
            </div>}
          </fieldset>}
          {notice && <p role="status" className="dy-yx-notice">{notice}</p>}
          {error && <p role="alert" className="dy-yx-error">{error}</p>}
          {error && !settings && <button type="button" onClick={() => retry(value => value + 1)}>重试读取</button>}
          <div className="dy-yx-actions">
            <button type="button" disabled={Boolean(busy)} onClick={close}>关闭</button>
            <button type="button" disabled={!canSubmit || Boolean(busy)} onClick={() => void run('testConnection')}>{busy === 'testConnection' ? '正在测试…' : '测试连接'}</button>
            <button type="submit" className="dy-yx-primary" disabled={!canSubmit || Boolean(busy)}>{busy === 'saveConnection' ? '正在保存…' : '保存并连接'}</button>
          </div>
        </form>
      </dialog>
    }

    function Dialog(props: {
      modal: Modal; detail?: Details; detailError: string; meta?: Meta; workspaceId: string; project: string
      close(): void; refresh(): void; pending: Record<string, string>; setPending(id: string, target: string): void
      onSuccess(issue: Issue, result: string): void; onPlan(): void; onOpenSession(id: string): void
    }) {
      const { modal, close, detail, meta, project, workspaceId, pending, setPending } = props
      const { kind } = modal
      const issue = 'issue' in modal ? modal.issue : undefined
      const issues = 'issues' in modal ? modal.issues : []
      const base = { project, workspaceId, id: issue?.id }
      const element = useRef<HTMLDialogElement>(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [revision, retryRead] = useState(0)
      const [plans, setPlans] = useState<Plan[]>()
      const [planId, setPlan] = useState('')
      const [results, setResults] = useState<PlanResult[]>()
      const [draft, setDraft] = useState<Preview>()
      const [states, setStates] = useState<{ current: Option; options: Option[] }>()
      const [target, setTarget] = useState('')
      const [notes, setNotes] = useState('')
      const [clarify, setClarify] = useState(false)
      const targetPending = issue ? pending[issue.id] || detail?.pendingTarget : ''
      const title = { discuss: '发起讨论', add: '添加到计划', create: '创建计划', start: '直接开工',
        publish: '回写预览', move: targetPending ? '回查状态' : '状态流转' }[kind]

      useEffect(() => {
        const dialog = element.current!
        dialog.showModal()
        return () => dialog.close()
      }, [])

      useEffect(() => {
        const abort = new AbortController()
        setError('')
        const failure = (reason: unknown) => { if (!abort.signal.aborted) setError(errorText(reason)) }
        if (kind === 'add') rpc<Plan[]>('plans', base, abort.signal).then(rows => {
          setPlans(rows); setPlan(rows[0]?.id || '')
        }, failure)
        if (kind === 'publish') rpc<Preview>('preview', base, abort.signal).then(setDraft, failure)
        if (kind === 'move' && !targetPending) rpc<typeof states>('statuses', base, abort.signal).then(setStates, failure)
        return () => abort.abort()
      }, [revision])

      async function run(operation: () => Promise<void>) {
        if (busy) return
        setBusy(true); setError('')
        try { await operation() } catch (failure) { setError(errorText(failure)) }
        finally { setBusy(false) }
      }

      async function submit(form: HTMLFormElement) {
        if (kind === 'create') {
          const values = Object.fromEntries(new FormData(form))
          await rpc('createPlan', { ...base, ...values })
          props.onPlan(); close()
        }
        if (kind === 'add') {
          const ids = results ? results.filter(row => row.retryable).map(row => row.id) : issues.map(row => row.id)
          const update = await rpc<PlanResult[]>('addToPlan', { ...base, planId, ids })
          setResults(results ? results.map(row => update.find(item => item.id === row.id) ?? row) : update)
          props.onPlan()
        }
        if (kind === 'start') {
          if (detail?.sessionId) { props.onOpenSession(detail.sessionId); return }
          try {
            const started = await rpc<{ sessionId: string }>('start', { ...base, notes, clarify, preset: 'standard', permission: 'danger-full-access' })
            props.onOpenSession(started.sessionId)
          } catch (error) {
            props.refresh()
            throw error
          }
        }
        if (kind === 'publish' && draft) {
          setDraft(await rpc<Preview>('publish', { ...base, sections: draft.sections, code: draft.code }))
        }
        if (kind === 'move' && issue) {
          if (targetPending) {
            const actual = await rpc<{ mismatch?: boolean; status?: Option; error?: string }>('checkTransition', base)
            if (!actual.status) throw new Error(actual.error || '尚未核实到目标状态')
            setPending(issue.id, '')
            props.onSuccess(issue, actual.mismatch
              ? '当前状态为「' + actual.status.name + '」。如需继续，请重新选择并确认目标。'
              : '云效已确认「' + actual.status.name + '」')
            close()
            return
          }
          if (!states) return
          const result = await rpc<{ pending?: boolean; target?: string; status?: Option; error?: string }>('transition', {
            ...base, current: states.current.id, target,
          })
          if (result.pending) {
            setPending(issue.id, result.target || target)
            setError(result.error || '等待云效核对结果')
          } else {
            props.onSuccess(issue, '已流转至「' + result.status?.name + '」')
            close()
          }
        }
      }

      const canSubmit = kind === 'create' || kind === 'start' && (detail || props.detailError && notes.trim()) ||
        kind === 'add' && planId && (!results || results.some(row => row.retryable)) ||
        kind === 'publish' && draft && draft.receipts.some(receipt => !receipt) ||
        kind === 'move' && (targetPending || target)
      let action = { discuss: '', add: results ? '重试未完成项' : '确认加入', create: '创建计划',
        start: detail?.sessionId ? '返回绑定会话' : '确认开工',
        publish: draft?.receipts.some(Boolean) ? '重试未发布评论' : '确认发布',
        move: targetPending ? '仅回查' : '确认流转并回查' }[kind]
      if (busy) action = '处理中…'

      return <dialog className="dy-yx dy-yx-dialog" ref={element} aria-labelledby="dy-yx-dialog-title"
        onCancel={event => { event.preventDefault(); if (!busy) close() }}>
        <form onSubmit={event => { event.preventDefault(); void run(() => submit(event.currentTarget)) }}>
          <h2 id="dy-yx-dialog-title">{title}</h2>
          {issue && <p>{issue.reference} · {issue.title}</p>}
          {issues.length > 0 && <ol>{issues.map(row => <li key={row.id}>{row.reference} · {row.title}</li>)}</ol>}
          {(kind === 'discuss' || kind === 'create' || kind === 'add') &&
            <p>目标工作区 · {meta?.workspaces.find(item => item.id === workspaceId)?.name}</p>}
          <fieldset disabled={busy}>
            {kind === 'discuss' && <p>讨论流程待定。</p>}
            {kind === 'create' && <>
              <label>计划名称<input name="name" required maxLength={100} /></label>
              <label>已有本地分支<input name="branch" required placeholder="feature/example" /></label>
              <label>计划完成日期<input type="date" name="end" required /></label>
            </>}
            {kind === 'add' && <>
              {!plans && !error && <p>正在读取计划…</p>}
              {plans?.length === 0 && <p>本工作区暂无可用计划，请先创建计划。</p>}
              {Boolean(plans?.length) && <label>目标计划
                <select value={planId} disabled={Boolean(results)} onChange={event => setPlan(event.target.value)}>
                  {plans?.map(item => <option key={item.id} value={item.id}>{item.name} · {item.end}</option>)}
                </select></label>}
              <p>待开发议题只补计划归属。其余议题将设为待开发，负责人设为当前用户，计划开始日设为当天。</p>
              {results && <ul>{results.map(row => <li key={row.id}>
                {issues.find(item => item.id === row.id)?.reference} · {row.result}{row.error && ' · ' + row.error}
              </li>)}</ul>}
            </>}
            {kind === 'start' && <>
              {detail?.sessionId ? <p>本工作区已有绑定会话 {detail.sessionId}。</p> : <>
                <p>工作区 · {meta?.workspaces.find(item => item.id === workspaceId)?.name}</p>
                {detail ? <p>已读取正文，附件与图片 {detail.files.length} 项。{detail.materialsError}</p> :
                  <p>{props.detailError || '正在读取议题原文…'}</p>}
                {detail && <details><summary>查看原文与附件</summary>
                  <p className="dy-yx-description">{detail.text || '无正文'}</p>
                  <ul>{detail.files.map((file, i) => <li key={i}>
                    <Attachment file={file} />
                  </li>)}</ul>
                </details>}
                {detail?.preparedSessionId && <button type="button" onClick={() => props.onOpenSession(detail.preparedSessionId!)}>
                  打开已准备会话
                </button>}
                {props.detailError && <button type="button" onClick={props.refresh}>重试读取</button>}
                {issue?.category === 'Bug' ? <p>缺陷取证 · 先复现并定位根因</p> :
                  <label className="dy-yx-inline"><input type="checkbox" checked={clarify} onChange={event => setClarify(event.target.checked)} />先澄清需求再执行</label>}
                <label>发起人补充<textarea value={notes} maxLength={12000} onChange={event => setNotes(event.target.value)} /></label>
              </>}
            </>}
            {kind === 'publish' && draft && <>
              {draft.sections.map((value, i) => <label key={i}>{i === 0 ? '开发向评论' : '测试向评论'}
                {draft.receipts[i] && ' · 已发布 ' + draft.receipts[i]?.id + ' · ' + new Date(draft.receipts[i]!.time).toLocaleString()}
                <textarea required value={value} readOnly={draft.receipts.some(Boolean) || Boolean(draft.error)} onChange={event => {
                  const update = [...draft.sections]; update[i] = event.target.value
                  setDraft({ ...draft, sections: update })
                }} />
              </label>)}
              {draft.error && <p role="alert">{draft.error}</p>}
              {!draft.receipts.some(Boolean) && !draft.error && <button type="button"
                onClick={() => void run(async () => setDraft(await rpc('preview', { ...base, regenerate: true })))}>重新生成草稿</button>}
            </>}
            {kind === 'move' && (targetPending ? <p>流转结果等待核对。重新回查只读取当前云效状态。</p> :
              states && <>
                <p>当前状态 · {states.current.name}。云效将在提交时检查流转条件。</p>
                <label>工作流目标状态<select required value={target} onChange={event => setTarget(event.target.value)}>
                  <option value="">请选择</option>{states.options.filter(item => item.id !== states.current.id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select></label>
                {!states.options.some(item => item.id !== states.current.id) && <p>当前议题无可选的目标状态。</p>}
              </>)}
          </fieldset>
          {error && <p role="alert" className="dy-yx-error">{error}</p>}
          {error && !draft && !states && ['publish','move','add'].includes(kind) && !targetPending &&
            <button type="button" onClick={() => retryRead(value => value + 1)}>重试读取</button>}
          <div className="dy-yx-actions">
            <button type="button" disabled={busy} onClick={close}>返回</button>
            {kind !== 'discuss' && <button type="submit" className="dy-yx-primary" disabled={busy || !canSubmit}>{action}</button>}
          </div>
        </form>
      </dialog>
    }

    function Icon() { return <span aria-hidden="true">☷</span> }

    return {
      inject: ['slots', 'uiWorkspace'],
      apply(ctx: { slots: Slots; uiWorkspace: Navigation }) {
        if (!document.querySelector('link[data-dy-yunxiao]')) {
          const stylesheet = document.createElement('link')
          stylesheet.rel = 'stylesheet'
          stylesheet.href = '/api/dy-yunxiao/panel.css'
          stylesheet.dataset.dyYunxiao = ''
          document.head.append(stylesheet)
        }
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'dy-yunxiao', label: '云效议题', order: 40,
        }, Icon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'dy-yunxiao', inject: () => ({ ctx }),
        }, Panel))
      },
    }
  },
})
