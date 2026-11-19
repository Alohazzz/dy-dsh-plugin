import type * as ReactType from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { Meta, MrRef, MrReviewView, Plan, PlanDetails, PlanIssue, PlanKey, PlanRow } from './contracts.ts'
import type { codeupApi } from './codeup.mjs'
import type { deliveryOptions, mrRepos } from './merge-request.ts'
import { createMrPanel, type Rpc } from './mr-panel.tsx'

type Codeup = ReturnType<typeof codeupApi>
type Mr = Awaited<ReturnType<Codeup['detail']>>
type MrPage = Awaited<ReturnType<Codeup['list']>> & { user?: string }
type BranchOptions = Awaited<ReturnType<typeof deliveryOptions>>
type Scope = Omit<PlanKey, 'planId'>
type Queue = 'mine' | 'review' | 'all'
const queues: Record<Queue, string> = { mine: '我的发起', review: '待我审核', all: '仓库内全部' }
const states: Record<string, string> = {
  UNDER_DEV: '开发中', UNDER_REVIEW: '待审核', TO_BE_MERGED: '待合并', MERGED: '已合并', CLOSED: '已关闭', UNAVAILABLE: 'MR 状态暂不可读',
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const keyOf = (ref: MrRef) => ref.repositoryId + ':' + ref.localId
const planKey = ({ project, workspaceId, planId }: PlanKey) => ({ project, workspaceId, planId })
const planStatus = (plan: Plan, status?: string) => !plan.delivery ? '分支待配置' : !plan.delivery.mr ? '未提 MR' :
  status === 'MERGED' ? '代码已合并' : states[status || 'UNAVAILABLE'] || 'MR 状态未知'

export function createDeliveryPanels(React: typeof ReactType, rpc: Rpc) {
  const { useEffect, useMemo, useRef, useState } = React
  const MrPanel = createMrPanel(React, rpc)

  function useRead<T>(method: string, input: object | undefined, revision = 0) {
    const id = input === undefined ? '' : JSON.stringify(input)
    const [attempt, retry] = useState(0)
    const key = JSON.stringify([id, revision, attempt])
    const [result, setResult] = useState<{ key: string; value?: T; error?: string }>()
    useEffect(() => {
      if (!id) return
      const abort = new AbortController()
      rpc<T>(method, JSON.parse(id), abort.signal).then(value => {
        if (!abort.signal.aborted) setResult({ key, value })
      }, error => {
        if (!abort.signal.aborted) setResult({ key, error: errorText(error) })
      })
      return () => abort.abort()
    }, [method, key])
    return { ...(result?.key === key ? result : undefined), retry: () => retry(value => value + 1) }
  }

  function Status({ label }: { label: string }) {
    const tone = label.includes('已合并') ? 'green' : label === '待审核' || label === '待合并' ? 'orange' : 'grey'
    return <span className="dy-yx-status" data-tone={tone}>{label}</span>
  }
  function Branches({ source, target }: { source: string; target?: string }) {
    return <span className="dy-delivery-branches"><code>{source || '—'}</code>
      <span aria-hidden="true">→</span>{target ? <code>{target}</code> : <small>待配置</small>}</span>
  }
  function Problem({ error, retry }: { error: string; retry?(): void }) {
    return <p className="dy-yx-error" role="alert">{error} {retry && <button type="button" onClick={retry}>重试</button>}</p>
  }
  function Table({ headers, children }: { headers: string[]; children: ReactType.ReactNode }) {
    return <div className="dy-delivery-table" tabIndex={0}><table>
      <thead><tr>{headers.map(label => <th key={label} scope="col" className={label === '议题数' ? 'dy-delivery-number' : undefined}>{label}</th>)}</tr></thead>
      <tbody>{children}</tbody>
    </table></div>
  }
  function Modal({ label, drawer, busy, close, children }: {
    label: string; drawer?: boolean; busy: boolean; close(): void; children: ReactType.ReactNode
  }) {
    const element = useRef<HTMLDialogElement>(null)
    useEffect(() => {
      const dialog = element.current!
      dialog.showModal()
      return () => dialog.close()
    }, [])
    return <dialog ref={element} className={'dy-yx dy-yx-dialog' + (drawer ? ' dy-delivery-drawer' : '')} aria-label={label}
      onCancel={event => { event.preventDefault(); if (!busy) close() }}>{children}</dialog>
  }

  function Configure({ scope, plan, close, saved }: { scope: PlanKey; plan: Plan; close(): void; saved(): void }) {
    const rows = useRead<Awaited<ReturnType<typeof mrRepos>>>('mrRepos', { workspaceId: scope.workspaceId })
    const [choice, setChoice] = useState(plan.delivery?.key ?? plan.repositoryKey)
    const key = choice ?? rows.value?.find(row => row.branch === plan.branch)?.key ?? rows.value?.[0]?.key ?? ''
    const options = useRead<BranchOptions>('planDeliveryOptions', key ? { ...scope, key } : undefined)
    const [target, setTarget] = useState(plan.delivery?.target ?? plan.targetBranch ?? '')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const selected = options.value?.targets.includes(target) ? target : ''
    async function submit(event: ReactType.FormEvent) {
      event.preventDefault()
      if (!options.value || !selected || busy) return
      setBusy(true); setError('')
      try {
        await rpc('bindPlanDelivery', { ...scope, key, repositoryId: options.value.repository.id, target: selected })
        saved()
      } catch (failure) { setError(errorText(failure)) }
      finally { setBusy(false) }
    }
    return <Modal label="配置交付分支" drawer busy={busy} close={close}>
      <h2>配置交付分支</h2><p>{plan.name} · <code>{plan.branch}</code></p>
      <form onSubmit={submit}><fieldset disabled={busy}>
        <label>仓库<select value={key} disabled={Boolean(plan.kind)} onChange={event => { setChoice(event.target.value); setTarget(''); setError('') }}>
          <option value="">请选择</option>
          {rows.value?.map(row => <option key={row.key} value={row.key}>{row.name} · {row.key}</option>)}
        </select></label>
        {rows.error && <Problem error={rows.error} retry={rows.retry} />}
        {!rows.value && !rows.error && <p role="status">正在读取工作区仓库…</p>}
        {rows.value?.length === 0 && <p>目标工作区没有 Git 仓库。</p>}
        {options.error && <Problem error={options.error} retry={options.retry} />}
        {key && !options.value && !options.error && <p role="status">正在核对仓库和远端分支…</p>}
        {options.value && <label>目标分支 <small>{options.value.repository.path}</small>
          <select required value={selected} onChange={event => setTarget(event.target.value)}>
            <option value="">{options.value.targets.length ? '请选择' : '无可用目标分支'}</option>
            {options.value.targets.map(branch => <option key={branch}>{branch}</option>)}
          </select></label>}
      </fieldset>{error && <Problem error={error} />}
        <div className="dy-yx-actions dy-delivery-footer"><button type="button" disabled={busy} onClick={close}>取消</button>
          <button className="dy-yx-primary" disabled={!selected || busy}>{busy ? '保存中…' : '保存交付分支'}</button></div>
      </form>
    </Modal>
  }

  function LinkRequest({ scope, detail, close, saved }: { scope: PlanKey; detail: PlanDetails; close(): void; saved(ref: MrRef): void }) {
    const delivery = detail.plan.delivery!
    const [id, setId] = useState(detail.candidates.length === 1 ? detail.candidates[0].localId : 0)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    async function submit(event: ReactType.FormEvent) {
      event.preventDefault()
      if (!id || busy) return
      const ref = { repositoryId: delivery.repositoryId, localId: id }
      setBusy(true); setError('')
      try {
        await rpc('linkPlanMr', { ...scope, ...ref })
        saved(ref)
      } catch (failure) { setError(errorText(failure)) }
      finally { setBusy(false) }
    }
    return <Modal label="关联已有 MR" drawer busy={busy} close={close}>
      <h2>关联已有 MR</h2><p>{detail.plan.name} · {delivery.path}</p>
      <Branches source={detail.plan.branch} target={delivery.target} />
      <form onSubmit={submit}><fieldset disabled={busy}>
        {detail.candidates.map(mr => <label className="dy-yx-inline dy-delivery-candidate" key={mr.localId}>
          <input type="radio" name="mr" value={mr.localId} checked={id === mr.localId} onChange={() => setId(mr.localId)} />
          !{mr.localId} {mr.title}</label>)}
      </fieldset>{error && <Problem error={error} />}
        <div className="dy-yx-actions dy-delivery-footer"><button type="button" disabled={busy} onClick={close}>取消</button>
          <button className="dy-yx-primary" disabled={!id || busy}>{busy ? '关联中…' : '确认关联'}</button></div>
      </form>
    </Modal>
  }

  function IssueTable({ issues }: { issues: PlanIssue[] }) {
    return <Table headers={['议题编号', '标题', '负责人', '云效状态']}>
      {issues.map(issue => <tr key={issue.id}><td>{issue.url ? <a href={issue.url} target="_blank" rel="noreferrer">{issue.reference}</a> : issue.reference}</td>
        <td>{issue.error || issue.title || '—'}</td><td>{issue.owner || '—'}</td><td>{issue.state.name || '—'}</td></tr>)}
      {!issues.length && <tr><td colSpan={4}>暂无计划议题</td></tr>}
    </Table>
  }

  function PlanDetail({ scope, meta, revision, back, openMr, changed }: {
    scope: PlanKey; meta?: Meta; revision: number; back(): void; openMr(ref: MrRef): void; changed(): void
  }) {
    const result = useRead<PlanDetails>('workbenchPlan', scope, revision)
    const [modal, setModal] = useState<'configure' | 'link' | 'create'>()
    const [busy, setBusy] = useState(false)
    const [notice, setNotice] = useState('')
    const detail = result.value
    function done(ref?: MrRef) {
      setNotice(ref ? (modal === 'link' ? '已关联 MR !' : '已关联计划与 MR !') + ref.localId : '已保存交付分支')
      setModal(undefined)
      changed()
    }
    const refreshOnClose = () => { setModal(undefined); result.retry() }
    return <div className="dy-delivery-stack">
      <header><div><button className="dy-delivery-link" onClick={back}>返回交付计划</button>
        <h2>{detail?.plan.name || '交付计划详情'}</h2></div>
        <div className="dy-yx-actions"><button onClick={result.retry}>刷新</button>
          {detail && <Status label={planStatus(detail.plan, detail.mrStatus)} />}</div>
      </header>
      {result.error && <Problem error={result.error} retry={result.retry} />}
      {!detail && !result.error && <p role="status">正在读取交付计划…</p>}
      {notice && <p role="status" className="dy-yx-notice">{notice}</p>}
      {detail && <><dl className="dy-delivery-facts dy-delivery-card">
        <div><dt>云效项目</dt><dd>{meta?.projects.find(row => row.id === scope.project)?.name || scope.project}</dd></div>
        <div><dt>目标工作区</dt><dd>{meta?.workspaces.find(row => row.id === scope.workspaceId)?.name || scope.workspaceId}</dd></div>
        <div><dt>计划完成日</dt><dd>{detail.plan.end}</dd></div><div><dt>议题数</dt><dd>{detail.plan.members.length} 条</dd></div>
        {detail.plan.baseBranch && <div><dt>基础分支</dt><dd>{detail.plan.baseBranch}</dd></div>}
        {detail.plan.kind && <div><dt>代码目录</dt><dd>{detail.plan.worktree || '主工作区'}</dd></div>}
      </dl><section className="dy-delivery-card" aria-label="交付分支">
        <div className="dy-delivery-section dy-yx-actions"><h3>交付分支</h3>
          <div className="dy-yx-actions">{!detail.plan.delivery?.mr && <button
            className={!detail.plan.delivery ? 'dy-yx-primary' : undefined} onClick={() => setModal('configure')}>配置交付分支</button>}
            {detail.plan.delivery?.mr ? <button className="dy-yx-primary" onClick={() => openMr(detail.plan.delivery!.mr!)}>
              查看 MR !{detail.plan.delivery.mr.localId}</button>
            : detail.plan.delivery && !detail.mrError && <button className="dy-yx-primary"
              onClick={() => setModal(detail.candidates.length ? 'link' : 'create')}>
              {detail.candidates.length ? '关联已有 MR' : '发起合并请求'}</button>}</div>
        </div><dl className="dy-delivery-facts dy-delivery-branch-facts">
          <div><dt>仓库</dt><dd>{detail.plan.delivery?.path || (detail.plan.repositoryKey === '.' ? '工作区根仓库' : detail.plan.repositoryKey) || '待配置'}</dd></div>
          <div><dt>源分支 → 目标分支</dt><dd><Branches source={detail.plan.branch} target={detail.plan.delivery?.target || detail.plan.targetBranch} /></dd></div>
          <div><dt>关联 MR</dt><dd>{detail.plan.delivery?.mr ? '!' + detail.plan.delivery.mr.localId : '—'}</dd></div>
        </dl>{detail.mrError && <Problem error={detail.mrError} retry={result.retry} />}
      </section><section className="dy-delivery-card" aria-label="计划议题"><h3 className="dy-delivery-section">计划议题</h3>
        <IssueTable issues={detail.issues} /></section>
      {modal === 'configure' && <Configure scope={scope} plan={detail.plan} close={() => setModal(undefined)} saved={done} />}
      {modal === 'link' && <LinkRequest scope={scope} detail={detail} close={refreshOnClose} saved={done} />}
      {modal === 'create' && detail.plan.delivery && <Modal label="发起合并请求" drawer busy={busy} close={refreshOnClose}>
        <MrPanel workspaceId={scope.workspaceId} plan={{ ...scope, name: detail.plan.name, branch: detail.plan.branch, delivery: detail.plan.delivery }}
          close={refreshOnClose} onLinked={done} onBusy={setBusy} /></Modal>}
      </>}
    </div>
  }

  function Plans({ selected, revision, openPlan, openMr, changed, renderCreate }: {
    selected?: PlanKey; revision: number; openPlan(plan?: PlanKey): void; openMr(ref: MrRef): void; changed(): void
    renderCreate(scope: Scope, meta: Meta, close: () => void, saved: (plan?: Plan, scope?: Scope) => void): ReactType.ReactNode
  }) {
    const meta = useRead<Meta>('meta', {}, revision)
    const [scope, setScope] = useState<Scope>({ project: '', workspaceId: '' })
    const [query, setQuery] = useState('')
    const [phase, setPhase] = useState('')
    const [creating, setCreating] = useState(false)
    const result = useRead<PlanRow[]>('workbenchPlans', !selected && meta.value && !meta.value.setupError ? scope : undefined, revision)
    const phases = ['分支待配置', '未提 MR', ...Object.values(states).map(value => value === '已合并' ? '代码已合并' : value)]
    const term = query.trim().toLowerCase()
    const rows = (result.value || []).filter(row => (!phase || planStatus(row.plan, row.mrStatus) === phase) && [
      row.plan.name, row.plan.branch, row.plan.delivery?.path, row.plan.delivery?.target || row.plan.targetBranch,
    ].some(value => value?.toLowerCase().includes(term)))
    return <main className="dy-yx dy-delivery">
      {selected ? <PlanDetail key={JSON.stringify(selected)} scope={selected} meta={meta.value} revision={revision}
        back={() => openPlan()} openMr={openMr} changed={changed} /> : <>
        <header><h2>交付计划</h2><div className="dy-yx-actions">
          <button onClick={() => { meta.retry(); result.retry() }}>刷新</button>
          <button className="dy-yx-primary" disabled={!meta.value?.projects.length || !meta.value?.workspaces.length}
            onClick={() => setCreating(true)}>创建计划</button>
        </div></header>
        {(meta.error || meta.value?.setupError) && <Problem error={meta.error || meta.value!.setupError!} retry={meta.retry} />}
        <section className="dy-delivery-card">
          <div className="dy-delivery-filters dy-yx-actions">
            <label>云效项目 <select value={scope.project} onChange={event => setScope({ ...scope, project: event.target.value })}>
              <option value="">全部项目</option>{meta.value?.projects.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
            </select></label>
            <label>目标工作区 <select value={scope.workspaceId} onChange={event => setScope({ ...scope, workspaceId: event.target.value })}>
              <option value="">全部工作区</option>{meta.value?.workspaces.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
            </select></label>
            <label>代码交付 <select value={phase} onChange={event => setPhase(event.target.value)}>
              <option value="">全部进度</option>{phases.map(value => <option key={value}>{value}</option>)}
            </select></label>
            <input type="search" aria-label="搜索交付计划" placeholder="搜索计划、仓库或分支" value={query} onChange={event => setQuery(event.target.value)} />
          </div>
          {result.error && <Problem error={result.error} retry={result.retry} />}
          <Table headers={['交付计划', '仓库 / 交付分支', '计划完成日', '议题数', '代码交付']}>
            {rows.map(row => <tr key={JSON.stringify(planKey(row))}>
              <td><button className="dy-delivery-link" onClick={() => openPlan(planKey(row))}>{row.plan.name}</button>
                <small>{row.projectName} · {row.workspaceName}</small></td>
              <td><small>{row.plan.delivery?.path || (row.plan.repositoryKey === '.' ? '工作区根仓库' : row.plan.repositoryKey)}</small>
                <Branches source={row.plan.branch} target={row.plan.delivery?.target || row.plan.targetBranch} /></td>
              <td>{row.plan.end}</td><td className="dy-delivery-number">{row.plan.members.length}</td>
              <td><Status label={planStatus(row.plan, row.mrStatus)} /></td></tr>)}
            {!rows.length && <tr><td colSpan={5} role="status">{result.value ? '没有符合条件的交付计划' :
              meta.error || meta.value?.setupError || result.error ? '暂时无法读取交付计划' : '正在读取交付计划…'}</td></tr>}
          </Table>
          {result.value && <p className="dy-delivery-count">共 {rows.length} 个计划</p>}
        </section>
        {creating && meta.value && renderCreate(scope, meta.value, () => setCreating(false), (plan, createdScope) => {
          setCreating(false); changed()
          if (plan) openPlan({ ...(createdScope || scope), planId: plan.id })
        })}
      </>}
    </main>
  }

  function Requests({ revision, active, openMr }: { revision: number; active: boolean; openMr(ref: MrRef, origin: Queue): void }) {
    const [queue, setQueue] = useState<Queue>('mine')
    const [workspaceId, setWorkspace] = useState('')
    const [creating, setCreating] = useState(false)
    const [query, setQuery] = useState('')
    const [repository, setRepository] = useState('')
    const [page, setPage] = useState(1)
    const [busy, setBusy] = useState(false)
    const result = useRead<MrPage>('workbenchMrs', !active || creating ? undefined : { queue, page, repository }, revision)
    const meta = useRead<Meta>('meta', active && creating ? {} : undefined, revision)
    const target = meta.value?.workspaces.some(row => row.id === workspaceId) ? workspaceId : meta.value?.workspaces[0]?.id || ''
    if (creating) return <main className="dy-yx dy-delivery">
      {meta.error && <Problem error={meta.error} retry={meta.retry} />}
      <div className="dy-yx-bar"><label>目标工作区 <select disabled={busy} value={target} onChange={event => setWorkspace(event.target.value)}>
        <option value="">请选择</option>{meta.value?.workspaces.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
      </select></label>{!target && <button onClick={() => setCreating(false)}>返回合并请求</button>}</div>
      {target ? <MrPanel key={target} workspaceId={target} close={() => { setCreating(false); result.retry() }} onBusy={setBusy} />
        : <p role="status">{meta.value ? '请先在 DSH 中添加工作区。' : '正在读取 DSH 工作区…'}</p>}
    </main>
    return <main className="dy-yx dy-delivery"><header><div><h2>合并请求</h2>{result.value?.user && <small>Codeup · {result.value.user}</small>}</div>
      <div className="dy-yx-actions"><button onClick={result.retry}>刷新</button>
        <button className="dy-yx-primary" onClick={() => setCreating(true)}>发起合并请求</button></div></header>
      <section className="dy-delivery-card">
        <nav className="dy-delivery-tabs dy-yx-actions" aria-label="合并请求视图">{(Object.keys(queues) as Queue[]).map(value =>
          <button key={value} aria-current={queue === value ? 'page' : undefined}
            onClick={() => { setQueue(value); setPage(1) }}>{queues[value]}</button>)}</nav>
        <form className="dy-delivery-filters dy-yx-actions" onSubmit={event => { event.preventDefault(); setRepository(query.trim()); setPage(1) }}>
          <label>仓库 <input type="search" value={query} maxLength={256} placeholder="仓库 ID 或完整路径" onChange={event => setQuery(event.target.value)} /></label>
          <button>查询</button>
        </form>
        {result.error && <Problem error={result.error} retry={result.retry} />}
        <Table headers={['合并请求', '源分支 → 目标分支', '发起人', '状态']}>
          {result.value?.rows.map(row => <tr key={keyOf(row)}><td>
            <button className="dy-delivery-link" onClick={() => openMr(row, queue)}>!{row.localId} {row.title}</button>
            <small>{row.repository || '仓库 ' + row.repositoryId}</small></td>
            <td><Branches source={row.source} target={row.target} /></td><td>{row.author || '—'}</td>
            <td><Status label={states[row.status] || '未知'} /></td></tr>)}
          {!result.value?.rows.length && <tr><td colSpan={4} role="status">{result.value ? '本页没有符合条件的合并请求' :
            result.error ? '暂时无法读取合并请求' : '正在读取合并请求…'}</td></tr>}
        </Table>
        <div className="dy-delivery-filters dy-yx-actions">
          <button disabled={page === 1} onClick={() => setPage(value => value - 1)}>上一页</button>
          <small>第 {page} 页</small><button disabled={!result.value?.more} onClick={() => setPage(value => value + 1)}>下一页</button>
        </div>
      </section>
    </main>
  }

  function RequestDetail({ reference, origin, back, openPlan }: {
    reference: MrRef; origin: Queue | 'plan'; back(): void; openPlan(plan: PlanKey): void
  }) {
    const result = useRead<{ mr: Mr; plans: PlanRow[]; planError: string; reviewSupported?: boolean }>('workbenchMr', reference)
    const mr = result.value?.mr
    return <main className="dy-yx dy-delivery dy-delivery-stack">
      <header><div><button className="dy-delivery-link" onClick={back}>返回{origin === 'plan' ? '计划' : queues[origin]}</button>
        <h2>!{reference.localId} {mr?.title || '合并请求详情'}</h2>
        {mr && <small>{mr.repository || result.value?.plans[0]?.plan.delivery?.path || '仓库 ' + mr.repositoryId}</small>}</div>
        <div className="dy-yx-actions"><button onClick={result.retry}>刷新</button>
          {mr?.url && <a href={mr.url} target="_blank" rel="noreferrer">在 Codeup 打开</a>}</div></header>
      {result.error && <Problem error={result.error} retry={result.retry} />}
      {!result.error && !mr && <p role="status">正在读取合并请求详情…</p>}
      {mr && <><dl className="dy-delivery-facts dy-delivery-card">
        <div><dt>分支</dt><dd><Branches source={mr.source} target={mr.target} /></dd></div>
        <div><dt>发起人</dt><dd>{mr.author || '—'}</dd></div>
        <div><dt>审核人</dt><dd>{mr.reviewers.map(row => row.name).filter(Boolean).join('、') || '—'}</dd></div>
        <div><dt>状态</dt><dd><Status label={states[mr.status] || '未知'} />{mr.conflict && ' · 有冲突'}</dd></div>
        {mr.ahead !== undefined && <div><dt>源分支领先</dt><dd>{mr.ahead} 个提交</dd></div>}
        {mr.mergedRevision && <div><dt>合并提交</dt><dd><code>{mr.mergedRevision}</code></dd></div>}
      </dl><section className="dy-delivery-card dy-delivery-section">
        <h3>变更说明</h3><p className="dy-yx-description">{mr.description || '暂无变更说明'}</p>
        <h3>关联计划</h3>
        {result.value?.planError ? <Problem error={result.value.planError} retry={result.retry} /> :
          result.value?.plans.length ? <ul>{result.value.plans.map(row =>
            <li key={JSON.stringify(planKey(row))}><button className="dy-delivery-link" onClick={() => openPlan(planKey(row))}>{row.plan.name}</button>
              <small> · {row.projectName} · {row.workspaceName}</small></li>)}</ul> : <p>尚未关联交付计划</p>}
      </section>{result.value?.reviewSupported ? <ReviewPanel reference={reference} /> :
        <section className="dy-delivery-card dy-delivery-section" aria-label="AI 合并审查">
          <h3>AI 合并审查</h3>
          <p role="status">当前 DSH 宿主尚未加载审查接口。请重启此 DSH 实例后刷新页面。</p>
        </section>}</>}
    </main>
  }

  function ReviewPanel({ reference }: { reference: MrRef }) {
    const { repositoryId, localId } = reference
    const [value, setValue] = useState<MrReviewView>()
    const [readError, setReadError] = useState('')
    const [actionError, setActionError] = useState('')
    const [source, setSource] = useState('')
    const [busy, setBusy] = useState<'pull' | 'review'>()
    const [revision, refresh] = useState(0)
    const snapshot = value?.snapshot
    const review = value?.review
    const selected = value?.sources.find(row => row.id === source) ?? value?.sources[0]
    const report = useMemo(() => review?.markdown && DOMPurify.sanitize(marked.parse(review.markdown, { async: false }), {
      ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'h4', 'strong', 'em', 'ul', 'ol', 'li', 'code', 'pre', 'blockquote',
        'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'br'],
      ALLOWED_ATTR: [],
    }), [review?.markdown])

    useEffect(() => {
      const abort = new AbortController()
      let timer: ReturnType<typeof setTimeout>
      async function load() {
        try {
          const result = await rpc<MrReviewView>('mrReview', { repositoryId, localId }, abort.signal)
          if (abort.signal.aborted) return
          setReadError('')
          setValue(result)
          if (result.review?.status === 'running') timer = setTimeout(load, 1200)
        } catch (error) {
          if (!abort.signal.aborted) setReadError(errorText(error))
        }
      }
      void load()
      return () => { abort.abort(); clearTimeout(timer) }
    }, [repositoryId, localId, revision])

    async function run(action: 'pull' | 'review') {
      setBusy(action)
      setActionError('')
      try {
        if (action === 'pull') await rpc('pullMrSnapshot', { repositoryId, localId })
        if (action === 'review' && snapshot && selected) {
          await rpc('startMrReview', { repositoryId, localId, snapshotId: snapshot.id, sourceId: selected.id })
        }
      } catch (error) {
        setActionError(errorText(error))
      } finally {
        setBusy(undefined)
        refresh(n => n + 1)
      }
    }

    const blocked = !!busy || review?.status === 'running'
    return <section className="dy-delivery-card dy-delivery-section" aria-label="AI 合并审查">
      <h3>AI 合并审查</h3>
      <div className="dy-yx-actions">
        <button disabled={blocked} onClick={() => void run('pull')}>
          {busy === 'pull' ? '正在拉取…' : snapshot ? '刷新本地快照' : '拉取 MR 到本地'}
        </button>
        {value && value.sources.length > 1 && <label>审查技能源 <select value={selected?.id} disabled={blocked}
          onChange={event => setSource(event.target.value)}>
          {value.sources.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select></label>}
        <button className="dy-yx-primary" disabled={blocked || !snapshot || !selected} onClick={() => void run('review')}>
          {busy === 'review' ? '正在启动…' : review?.status === 'complete' ? '重新审查' : '运行只读审查'}
        </button>
      </div>
      {readError && <Problem error={readError} retry={() => refresh(n => n + 1)} />}
      {actionError && <p role="alert" className="dy-yx-error">{actionError}</p>}
      {value?.sources.length === 0 && <p>请在技能管理绑定包含 merge-code-review 和公司开发手册的技能源。</p>}
      {snapshot && <div className="dy-yx-meta">
        <p>补丁版本 {snapshot.version} · <code>{snapshot.source.slice(0, 12)}</code> → <code>{snapshot.target.slice(0, 12)}</code></p>
        <p>本地快照 <code className="dy-mr-snapshot-path">{snapshot.directory}</code></p>
      </div>}
      {review?.status === 'running' && <p role="status">正在生成审查报告…</p>}
      {review?.error && <p role="alert" className="dy-yx-error">{review.error}</p>}
      {report && <article className="dy-sk-markdown" aria-label="审查报告" dangerouslySetInnerHTML={{ __html: report }} />}
    </section>
  }

  return { Plans, Requests, RequestDetail }
}
