import { researchSummary } from './research-questions.ts'
import type { ResearchSummary, ResearchRow } from './research-prototype.ts'
import type * as ReactType from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { mrReviewCommentLimit, type Meta, type MrRef, type MrReviewComment, type MrReviewView, type Plan,
  type MrAction, type MrActionPreview, type MrActionResult, type MrMergeType,
  type IssueDocument, type IssueDocumentBody, type IssueDocuments as IssueDocumentList, type IssueKey,
  type PlanDetails, type PlanIssue, type PlanKey, type PlanRow } from './contracts.ts'
import type { codeupApi } from './codeup.mjs'
import type { deliveryOptions, mrRepos } from './merge-request.ts'
import type { CompletionAction, workbenchCompletion } from './workbench-completion.ts'
import { createResearchPrototype } from './research-prototype-panel.tsx'
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
const mrActionLabels: Record<MrAction, string> = { approve: '批准', merge: '合并', close: '关闭 MR' }
const mrActionReceipts: Record<MrAction, string> = { approve: '评审已通过', merge: 'MR 已合并', close: 'MR 已关闭' }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const renderReport = (markdown: string) => DOMPurify.sanitize(marked.parse(markdown, { async: false }), {
  ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'h4', 'strong', 'em', 'ul', 'ol', 'li', 'code', 'pre', 'blockquote',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'br'],
  ALLOWED_ATTR: [],
})
const keyOf = (ref: MrRef) => ref.repositoryId + ':' + ref.localId
const planKey = ({ project, workspaceId, planId }: PlanKey) => ({ project, workspaceId, planId })
const planStatus = (plan: Plan, status?: string) => !plan.delivery ? '分支待配置' : !plan.delivery.mr ? '未提 MR' :
  status === 'MERGED' ? '代码已合并' : states[status || 'UNAVAILABLE'] || 'MR 状态未知'

export function createDeliveryPanels(React: typeof ReactType, rpc: Rpc) {
  const { useEffect, useMemo, useRef, useState } = React
  const PlanResearch = createResearchPrototype(React, rpc)
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
  function Modal({ label, drawer, busy, close, children, dismissOnBackdrop, className }: {
    label: string; drawer?: boolean; dismissOnBackdrop?: boolean; busy: boolean; close(): void; children: ReactType.ReactNode; className?: string
  }) {
    const element = useRef<HTMLDialogElement>(null)
    const outside = useRef(false)
    function isOnBackdrop(event: ReactType.MouseEvent<HTMLDialogElement> | ReactType.PointerEvent<HTMLDialogElement>) {
      if (event.target !== event.currentTarget) return false
      const box = event.currentTarget.getBoundingClientRect()
      return event.clientX < box.left || event.clientX >= box.right || event.clientY < box.top || event.clientY >= box.bottom
    }
    useEffect(() => {
      const dialog = element.current!
      dialog.showModal()
      return () => dialog.close()
    }, [])
    return <dialog ref={element} className={['dy-yx', 'dy-yx-dialog', drawer && 'dy-delivery-drawer', className].filter(Boolean).join(' ')} aria-label={label}
      onPointerDown={event => { outside.current = isOnBackdrop(event) }}
      onClick={event => { if (dismissOnBackdrop && !busy && outside.current && isOnBackdrop(event)) close() }}
      onCancel={event => { event.preventDefault(); if (!busy) close() }}>{children}</dialog>
  }

  function IssueDocuments({ project, id, reference, title, close }: IssueKey & { reference: string; title: string; close(): void }) {
    const list = useRead<IssueDocumentList>('issueDocuments', { project, id })
    const [selectedKey, select] = useState<string>()
    const [collapsed, setCollapsed] = useState<string[]>([])
    const keyOfDocument = (row: IssueDocument) => JSON.stringify([row.workspaceId, row.planId, row.type, row.version])
    const rows = list.value?.documents ?? []
    const selected = rows.find(row => keyOfDocument(row) === selectedKey) ?? rows[0]
    const categories = ['research', 'proposal', 'execution', 'change', 'publication', 'completion'] as const
    const directory = categories.map(type => rows.filter(row => row.type === type)).filter(group => group.length)
    const multiplePlans = new Set(rows.map(row => JSON.stringify([row.workspaceId, row.planId]))).size > 1
    const readingPane = useRef<HTMLElement>(null)
    useEffect(() => { if (readingPane.current) readingPane.current.scrollTop = 0 }, [selected])
    const document = useRead<IssueDocumentBody>('issueDocument', selected && {
      project, id, workspaceId: selected.workspaceId, planId: selected.planId, type: selected.type, version: selected.version,
    })
    const snapshot = document.value
    const preview = useMemo(() => {
      if (!snapshot) return
      if (snapshot.format === 'markdown') return { html: renderReport(snapshot.body) }
      try {
        const data = JSON.parse(snapshot.body)
        const raw = JSON.stringify(data, null, 2)
        if (selected?.type === 'publication' && typeof data.test?.body === 'string') {
          return { html: renderReport(data.test.body), raw }
        }
        return { raw }
      } catch { return { raw: snapshot.body } }
    }, [snapshot, selected?.type])
    return <Modal label="议题过程文档" className="dy-plan-report-dialog dy-issue-documents-dialog" busy={false} dismissOnBackdrop close={close}>
      <header className="dy-plan-report-header"><h2>过程文档</h2>
        <button type="button" onClick={close}>关闭</button></header>
      <p className="dy-issue-documents-subject">{reference} · {title}</p>
      <div className="dy-issue-documents-layout">
        <nav className="dy-issue-documents-directory" aria-label="文档目录">
          {list.error && <Problem error={list.error} retry={list.retry} />}
          {!list.value && !list.error && <p role="status">正在读取过程文档…</p>}
          {list.value?.errors.map(error => <Problem key={error} error={error} retry={list.retry} />)}
          {list.value && !rows.length && !list.value.errors.length && <p>该议题暂无归档的过程文档。</p>}
          {directory.map(group => {
            const { type, title: groupTitle } = group[0]
            const expanded = !collapsed.includes(type)
            return <section key={type} className="dy-issue-documents-group">
              <h3><button type="button" aria-expanded={expanded} onClick={() => setCollapsed(previous =>
                expanded ? [...previous, type] : previous.filter(key => key !== type))}>
                <svg className="dy-doc-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5V4h4l2 2h6v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5Z" /></svg>
                <span>{groupTitle}</span>
              </button></h3>
              {expanded && <ul>{group.map(row => <li key={keyOfDocument(row)}>
                <button type="button" aria-label={row.title + ' · v' + row.version + (multiplePlans ? ` · ${row.planName} · ${row.workspaceName}` : '')}
                  aria-current={row === selected ? 'true' : undefined} onClick={() => select(keyOfDocument(row))}>
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h5L12 5.5v8H4zM9 2.5v3h3" /></svg>
                  <span>v{row.version}{multiplePlans && <small>{row.planName} · {row.workspaceName}</small>}</span>
                </button>
              </li>)}</ul>}
            </section>
          })}
        </nav>
        <section ref={readingPane} className="dy-issue-documents-reader" aria-label="正文预览" tabIndex={0}>
          {selected && <>
            <h3>{selected.title} · v{selected.version}</h3>
            <p className="dy-issue-documents-meta"><small>{selected.planName} · {selected.workspaceName} · {new Date(selected.time).toLocaleString('zh-CN')}</small></p>
            {document.error && <Problem error={document.error} retry={document.retry} />}
            {!snapshot && !document.error && <p role="status">正在读取正文…</p>}
            {preview?.html && <article className="dy-sk-markdown" dangerouslySetInnerHTML={{ __html: preview.html }} />}
            {preview?.raw && (preview.html ? <details><summary>查看回执和原始记录</summary><pre className="dy-issue-document-data">{preview.raw}</pre></details>
              : <pre className="dy-issue-document-data">{preview.raw}</pre>)}
          </>}
        </section>
      </div>
    </Modal>
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

  function IssueTable({ issues, remove, archive, documents, summaries, open, finalize, execute, executing, executionSupported, busy, unavailable, legacy, closed, openSession }: {
    issues: PlanIssue[]; remove(issue: PlanIssue): void; summaries?: ResearchSummary[]; open(id: string): void
    archive(issue: PlanIssue): void; documents(issue: PlanIssue): void
    finalize(row: ResearchSummary): void; execute(id: string, version: number): void; executing?: string; executionSupported?: boolean
    busy: boolean; unavailable: boolean; legacy: boolean; closed: boolean; openSession(id: string): void
  }) {
    return <Table headers={['议题编号', '标题', '负责人', '云效状态', '方案状态', '操作']}>
      {issues.map(issue => {
        const row = summaries?.find(s => s.issueId === issue.id)
        const executionVersion = issue.executionVersion ?? (row?.label === '已定稿' ? row.version : undefined)
        return <tr key={issue.id}><td>{issue.url ? <a href={issue.url} target="_blank" rel="noreferrer">{issue.reference}</a> : issue.reference}</td>
        <td>{issue.error || issue.title || '—'}</td><td>{issue.owner || '—'}</td><td>{issue.state.name || '—'}</td>
        <td>{summaries ? <div className="dy-plan-issue-actions"><Status label={row?.label || '未调研'} />{row?.progress && row.progress !== row.label && <Status label={row.progress} />}
          {issue.executionStage && <Status label={{ dispatched: '已派发', ready: '小结待确认', confirmed: '小结已确认', submitted: '已登记提交' }[issue.executionStage]} />}
        </div> : unavailable ? '状态不可用' : '读取中…'}</td>
        <td><div className="dy-plan-issue-actions">
          <button type="button" className="dy-delivery-link" onClick={() => documents(issue)}>过程文档</button>
          {row && (row.version > 0 || row.label === '调研失败') && <button className="dy-delivery-link" onClick={() => open(issue.id)}>
            {row.version ? '查看 v' + row.version : '查看失败原因'}</button>}
          {row && <button className="dy-delivery-link" onClick={() => openSession(row.sessionId)}>查看调研会话</button>}
          {!closed && row?.canSubmit && <button disabled={busy} onClick={() => finalize(row)}>提交审核</button>}
          {!closed && row?.canFinalize && <button title={legacy ? '请在新版 DSH 工作台定稿' : undefined} disabled={busy || legacy} onClick={() => finalize(row)}>标记定稿</button>}
          {issue.sessionId && <button className="dy-delivery-link" onClick={() => openSession(issue.sessionId!)}>查看执行会话</button>}
          {issue.sessionId && <button className="dy-delivery-link" onClick={() => archive(issue)}>归档执行成果</button>}
          {!closed && executionVersion !== undefined && (!issue.sessionId || issue.dispatchedVersion !== executionVersion) && <button className="dy-yx-primary" disabled={busy || !executionSupported || Boolean(executing)}
              onClick={() => execute(issue.id, executionVersion)}>
              {executing === issue.id ? '正在派发…' : issue.executionVersion ? '重试执行 v' + issue.executionVersion : '开始执行'}
            </button>}
          {!closed && <button type="button" className="dy-delivery-link" aria-label={'移出计划 ' + issue.reference}
            onClick={() => remove(issue)}>移出计划</button>}</div></td></tr>})}
      {!issues.length && <tr><td colSpan={6} className="dy-delivery-issue-empty">暂无计划议题</td></tr>}
    </Table>
  }

  function RemoveIssue({ scope, issue, close, removed }: {
    scope: PlanKey; issue: PlanIssue; close(): void; removed(deferred: boolean): void
  }) {
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [reason, setReason] = useState('')
    const [defer, setDefer] = useState(false)
    async function submit(event: ReactType.FormEvent) {
      event.preventDefault()
      if (busy) return
      setBusy(true)
      setError('')
      try {
        await rpc('removeFromPlan', { ...scope, id: issue.id, reason, defer })
        removed(defer)
      } catch (failure) {
        setError(errorText(failure))
        setBusy(false)
      }
    }
    return <Modal label="调整议题范围" busy={busy} close={close}>
      <h2>调整议题范围</h2>
      <p>{issue.reference} {issue.title}</p>
      <form onSubmit={submit}>
        <label>处理方式<select value={defer ? 'defer' : 'remove'} onChange={event => setDefer(event.target.value === 'defer')}>
          <option value="remove">移出计划</option><option value="defer">记录延期</option>
        </select></label>
        <p>{defer ? '议题仍在计划中，延期原因将写入范围历史。' : '云效状态将回退至「已确认」，计划开始时间将清空。负责人和计划完成时间保留。'}</p>
        <label>原因<textarea rows={2} value={reason} maxLength={1000} required onChange={event => setReason(event.target.value)} /></label>
        {error && <Problem error={error} />}
        <div className="dy-yx-actions dy-delivery-footer">
          <button type="button" disabled={busy} onClick={close}>取消</button>
          <button className="dy-yx-primary" disabled={busy || !reason.trim()}>{busy ? '保存中…' : defer ? '记录延期' : '确认移出'}</button>
        </div>
      </form>
    </Modal>
  }

  function ArchiveExecution({ scope, issue, close, saved }: { scope: PlanKey; issue: PlanIssue; close(): void; saved(): void }) {
    const [commit, setCommit] = useState('')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    async function submit(event: ReactType.FormEvent) {
      event.preventDefault()
      setBusy(true); setError('')
      try {
        await rpc('archivePlanExecution', { ...scope, id: issue.id, ...(commit.trim() && { commit: commit.trim() }) })
        saved()
      } catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
    }
    return <Modal label="归档执行成果" busy={busy} close={close}>
      <h2>归档执行成果</h2><p>{issue.reference} · {issue.title}</p>
      <form onSubmit={submit}>
        <p>确认执行会话中的小结后保存。已提交时，可同时关联带本议题编号的 Git 提交。</p>
        <label>提交 SHA（可选）<input value={commit} spellCheck={false} onChange={event => setCommit(event.target.value)} /></label>
        {error && <Problem error={error} />}
        <div className="dy-yx-actions dy-delivery-footer"><button type="button" disabled={busy} onClick={close}>取消</button>
          <button className="dy-yx-primary" disabled={busy}>{busy ? '保存中…' : '确认并归档'}</button></div>
      </form>
    </Modal>
  }

  function PlanDetail({ scope, meta, revision, back, openMr, changed, openSession }: {
    scope: PlanKey; meta?: Meta; revision: number; back(): void; openSession(id: string): void; openMr(ref: MrRef): void; changed(): void
  }) {
    const result = useRead<PlanDetails>('workbenchPlan', scope, revision)
    const [modal, setModal] = useState<'configure' | 'link' | 'create'>()
    const [busy, setBusy] = useState(false)
    const [notice, setNotice] = useState('')
    const [executing, setExecuting] = useState<string>()
    const [executionError, setExecutionError] = useState('')
    const [executionSessions, setExecutionSessions] = useState<Record<string, string>>({})
    const [removing, setRemoving] = useState<PlanIssue>()
    const [archiving, setArchiving] = useState<PlanIssue>()
    const detail = result.value
    const completion = useRead<Awaited<ReturnType<typeof workbenchCompletion>>>('planCompletion', detail?.plan.delivery?.mr ? scope : undefined, revision)
    const report = completion.value?.latest
    const [showReport, setShowReport] = useState(false)
    const reportMarkdown = completion.value?.markdown
    const reportHtml = useMemo(() => reportMarkdown && renderReport(reportMarkdown), [reportMarkdown])
    const closed = report?.reportStatus === 'final'
    const [reportAction, setReportAction] = useState<CompletionAction>()
    const [reportNote, setReportNote] = useState('')
    const [reportBusy, setReportBusy] = useState(false)
    const [reportError, setReportError] = useState('')
    async function saveReport(action: CompletionAction) {
      setReportBusy(true); setReportError('')
      try {
        await rpc('updatePlanCompletion', { ...scope, action, note: reportNote })
        setReportAction(undefined)
        setReportNote('')
        completion.retry()
      } catch (failure) { setReportError(errorText(failure)) }
      finally { setReportBusy(false) }
    }
    const [answering, setAnswering] = useState(false)
    const [previewIssue, setPreviewIssue] = useState<string>()
    const [documentIssue, setDocumentIssue] = useState<PlanIssue>()
    const [startingResearch, setStartingResearch] = useState(false)
    const [startError, setStartError] = useState('')
    const batch = useRead<{ batchId: string; rows: ResearchRow[] }>('planResearch', detail?.plan.members.length ? scope : undefined, revision)
    const batchId = batch.value?.batchId
    const [summaries, setSummaries] = useState<ResearchSummary[]>()
    const [legacy, setLegacy] = useState(false)
    const [summaryError, setSummaryError] = useState('')
    useEffect(() => {
      if (!batchId || answering) return
      const abort = new AbortController()
      let timer: ReturnType<typeof setTimeout>
      let useLegacy = false
      async function poll() {
        try {
          let next: ResearchSummary[] | undefined
          if (!useLegacy) {
            try { next = await rpc<ResearchSummary[]>('researchSummaries', { batchId }, abort.signal) }
            catch (e) {
              if (errorText(e) !== '未知云效操作') throw e
              useLegacy = true
            }
          }
          if (!next) next = (await rpc<ResearchRow[]>('researchStatus', { batchId }, abort.signal)).map(researchSummary)
          if (!abort.signal.aborted) { setSummaries(next); setLegacy(useLegacy); setSummaryError('') }
        } catch (e) { if (!abort.signal.aborted) setSummaryError(errorText(e)) }
        if (!abort.signal.aborted) timer = setTimeout(poll, 1800)
      }
      void poll()
      return () => { abort.abort(); clearTimeout(timer) }
    }, [batchId, answering])
    const needsResearch = summaries && detail?.plan.members.some(id => {
      const row = summaries.find(item => item.issueId === id)
      return !row || (row.version === 0 && row.label === '调研失败')
    })
    async function startResearch() {
      if (!needsResearch || startingResearch) return
      setStartingResearch(true)
      setStartError('')
      try {
        const started = await rpc<{ rows: ResearchRow[] }>('planResearch', { ...scope, start: true })
        setSummaries(started.rows.map(researchSummary))
      } catch (error) {
        setStartError(errorText(error))
      } finally {
        setStartingResearch(false)
      }
    }
    async function finalize(row: ResearchSummary) {
      setBusy(true)
      try {
        const next = await rpc<ResearchSummary>(row.canSubmit ? 'researchSubmit' : 'researchFinalize', { batchId, sessionId: row.sessionId, version: row.version })
        setSummaries(old => old?.map(r => r.sessionId === next.sessionId ? next : r))
        setNotice((row.canSubmit ? '已送审' : '已定稿') + ' · v' + row.version)
      } catch (e) { setNotice(errorText(e)) } finally { setBusy(false) }
    }
    async function execute(id: string, version: number) {
      if (executing) return
      setExecuting(id)
      setExecutionError('')
      try {
        const { sessionId } = await rpc<{ sessionId: string }>('executePlanIssue', { ...scope, id, version })
        setExecutionSessions(previous => ({ ...previous, [id]: sessionId }))
        changed()
        openSession(sessionId)
      } catch (error) {
        setExecutionError(errorText(error))
        result.retry()
      } finally {
        setExecuting(undefined)
      }
    }
    const questionCount = summaries?.filter(r => detail?.plan.members.includes(r.issueId || '')).reduce((n, r) => n + (r.count || 0), 0) || 0
    const executionUnavailable = detail && !detail.executionSupported && detail.issues.some(issue =>
      !issue.sessionId && (issue.executionVersion !== undefined || summaries?.some(row => row.issueId === issue.id && row.label === '已定稿')))
    const target = detail?.plan.delivery?.target || detail?.plan.targetBranch
    function done(ref?: MrRef) {
      setNotice(ref ? (modal === 'link' ? '已关联 MR !' : '已关联计划与 MR !') + ref.localId : '已保存交付分支')
      setModal(undefined)
      changed()
    }
    const refreshOnClose = () => { setModal(undefined); result.retry() }
    const researchPlan = detail && { ...scope, name: detail.plan.name, members: detail.plan.members }
    if (answering && researchPlan) return <PlanResearch initialReview workspaceId={scope.workspaceId} openSession={openSession}
      plan={researchPlan} close={() => setAnswering(false)} />
    return <div className="dy-delivery-stack dy-plan-detail">
      <header className="dy-plan-header">
        <div className="dy-yx-actions dy-plan-toolbar">
          <button type="button" className="dy-delivery-link" onClick={back}><span aria-hidden="true">← </span>返回交付计划</button>
          <button type="button" onClick={result.retry}>刷新</button>
        </div>
        {detail?.plan.goal && <p>{detail.plan.goal}</p>}
        <div className="dy-plan-title"><h2>{detail?.plan.name || '交付计划详情'}</h2>
          {report?.reportStatus === 'final' && <Status label="计划已关闭" />}
          {detail && <Status label={planStatus(detail.plan, detail.mrStatus)} />}
        </div>
        {detail && <dl className="dy-plan-meta">
          <div><dt>计划完成日</dt><dd>{detail.plan.end}</dd></div>
          <div><dt>云效项目</dt><dd>{meta?.projects.find(row => row.id === scope.project)?.name || scope.project}</dd></div>
          <div><dt>目标工作区</dt><dd>{meta?.workspaces.find(row => row.id === scope.workspaceId)?.name || scope.workspaceId}</dd></div>
        </dl>}
      </header>
      {result.error && <Problem error={result.error} retry={result.retry} />}
      {detail?.archiveError && <Problem error={detail.archiveError} retry={() => {
        void rpc('refreshPlanArchive', scope).then(result.retry, failure => setNotice(errorText(failure)))
      }} />}
      {!detail && !result.error && <p role="status">正在读取交付计划…</p>}
      {notice && <p role="status" className="dy-yx-notice">{notice}</p>}
      {detail && <><section className="dy-delivery-card dy-delivery-section dy-plan-delivery" aria-label="交付分支">
        <div className="dy-yx-actions dy-plan-toolbar"><h3>交付分支</h3>
          <div className="dy-yx-actions">{!detail.plan.delivery?.mr && <button
            className={!detail.plan.delivery ? 'dy-yx-primary' : undefined} onClick={() => setModal('configure')}>配置交付分支</button>}
            {detail.plan.delivery?.mr ? <button className="dy-yx-primary" onClick={() => openMr(detail.plan.delivery!.mr!)}>
              查看 MR !{detail.plan.delivery.mr.localId}</button>
            : detail.plan.delivery && !detail.mrError && <button className="dy-yx-primary"
              onClick={() => setModal(detail.candidates.length ? 'link' : 'create')}>
              {detail.candidates.length ? '关联已有 MR' : '发起合并请求'}</button>}</div>
        </div>
        <dl className="dy-plan-branches">
          <div><dt>源分支</dt><dd><code>{detail.plan.branch || '—'}</code></dd></div>
          <div className="dy-plan-target"><dt>目标分支</dt><dd><span aria-hidden="true">→</span>
            {target ? <code>{target}</code> : <small>待配置</small>}</dd></div>
        </dl>
        <dl className="dy-plan-meta">
          <div><dt>仓库</dt><dd>{detail.plan.delivery?.path || (detail.plan.repositoryKey === '.' ? '工作区根仓库' : detail.plan.repositoryKey) || '待配置'}</dd></div>
          {detail.plan.baseBranch && <div><dt>基础分支</dt><dd>{detail.plan.baseBranch}</dd></div>}
          {detail.plan.kind && <div><dt>代码目录</dt><dd>{detail.plan.worktree || '主工作区'}</dd></div>}
        </dl>{detail.mrError && <Problem error={detail.mrError} retry={result.retry} />}
      </section>
      {detail.plan.delivery?.mr && <section className="dy-delivery-card dy-delivery-section" aria-label="计划完成报告">
        <div className="dy-yx-actions dy-plan-toolbar"><h3>计划完成报告</h3>
          {report && <small>v{report.version} · {report.reportStatus === 'final' ? '终稿' : report.reportStatus === 'reviewed' ? '已审核' :
            report.reportStatus === 'returned' ? '待返工' : '草稿'}</small>}</div>
        {completion.error && <Problem error={completion.error} retry={completion.retry} />}
        {reportHtml && <div className="dy-yx-actions"><button type="button" onClick={() => setShowReport(true)}>查看当前报告</button></div>}
        {completion.value?.reports.length ? <details><summary>报告版本</summary><ul>
          {completion.value.reports.map(version => <li key={version.version}>{version.file} · {new Date(version.time).toLocaleString()}</li>)}
        </ul></details> : null}
        {reportError && !reportAction && <Problem error={reportError} />}
        {report?.reportStatus !== 'final' && <div className="dy-yx-actions">
          <button disabled={reportBusy} onClick={() => void saveReport('draft')}>{report ? '按当前证据更新草稿' : '生成报告草稿'}</button>
          {report?.reportStatus === 'draft' && <button disabled={reportBusy} onClick={() => setReportAction('reviewed')}>确认审核</button>}
          {report && report.reportStatus !== 'returned' && <button disabled={reportBusy} onClick={() => setReportAction('returned')}>退回返工</button>}
          {report?.reportStatus === 'reviewed' && detail.mrStatus === 'MERGED' && <button className="dy-yx-primary" disabled={reportBusy}
            onClick={() => setReportAction('final')}>关闭计划并归档</button>}
        </div>}
      </section>}
      {showReport && reportHtml && <Modal label="计划完成报告" className="dy-plan-report-dialog" busy={false} dismissOnBackdrop close={() => setShowReport(false)}>
        <header className="dy-plan-report-header"><h2>计划完成报告</h2>
          <button type="button" onClick={() => setShowReport(false)}>关闭</button></header>
        <article className="dy-sk-markdown" dangerouslySetInnerHTML={{ __html: reportHtml }} />
      </Modal>}
      {reportAction && <Modal label="确认计划报告" busy={reportBusy} close={() => { setReportAction(undefined); setReportError(''); setReportNote('') }}>
        <h2>{reportAction === 'final' ? '关闭计划并归档' : reportAction === 'reviewed' ? '确认报告审核' : '退回计划报告'}</h2>
        <form onSubmit={event => { event.preventDefault(); void saveReport(reportAction) }}>
          <label>{reportAction === 'final' ? '遗留事项及后续去向' : '审核意见'}<textarea value={reportNote} maxLength={5000} rows={3}
            required={reportAction === 'returned'} onChange={event => setReportNote(event.target.value)} /></label>
          {reportError && <Problem error={reportError} />}
          <div className="dy-yx-actions dy-delivery-footer"><button className="dy-yx-primary" disabled={reportBusy}>{reportBusy ? '保存中…' : '确认'}</button></div>
        </form>
      </Modal>}
      <section className="dy-delivery-card" aria-label="计划议题">
        <div className="dy-delivery-section dy-plan-title"><h3>计划议题</h3><small>{detail.plan.members.length} 条</small><button disabled={closed || !needsResearch || startingResearch} onClick={startResearch}>{startingResearch ? '正在派发…' : '方案调研'}</button>
          <button disabled={closed || !questionCount} onClick={() => setAnswering(true)}>批量答疑{questionCount > 0 && '（' + questionCount + '）'}</button></div>
        {(batch.error || summaryError) && <Problem error={batch.error || summaryError!} retry={batch.retry} />}
        {startError && <Problem error={startError} retry={startResearch} />}
        {executionError && <Problem error={executionError} />}
        {executionUnavailable && <p role="status" className="dy-yx-notice">请更新研发工作台插件并重启 DSH，再开始执行。</p>}
        <IssueTable openSession={openSession} issues={detail.issues.map(issue => ({ ...issue, sessionId: executionSessions[issue.id] ?? issue.sessionId }))}
          execute={execute} executing={executing} executionSupported={detail.executionSupported} remove={setRemoving} archive={setArchiving} documents={setDocumentIssue} summaries={summaries}
          busy={busy} unavailable={!!(summaryError || batch.error)} legacy={legacy} closed={closed} open={setPreviewIssue} finalize={finalize} /></section>
      {previewIssue && researchPlan && <Modal label="方案预览" drawer dismissOnBackdrop busy={false} close={() => setPreviewIssue(undefined)}>
        <header><h2>方案预览</h2><button onClick={() => setPreviewIssue(undefined)}>关闭</button></header>
        <PlanResearch initialIssue={previewIssue} workspaceId={scope.workspaceId} openSession={openSession}
          plan={researchPlan} close={() => setPreviewIssue(undefined)} />
      </Modal>}
      {documentIssue && <IssueDocuments project={scope.project} id={documentIssue.id} reference={documentIssue.reference}
        title={documentIssue.title} close={() => setDocumentIssue(undefined)} />}
      {removing && <RemoveIssue scope={scope} issue={removing} close={() => setRemoving(undefined)} removed={deferred => {
        setNotice((deferred ? '已记录延期 · ' : '已移出计划 · ') + removing.reference)
        setRemoving(undefined)
        changed()
      }} />}
      {archiving && <ArchiveExecution scope={scope} issue={archiving} close={() => setArchiving(undefined)} saved={() => {
        setNotice('已归档 · ' + archiving.reference)
        setArchiving(undefined)
        changed()
      }} />}
      {modal === 'configure' && <Configure scope={scope} plan={detail.plan} close={() => setModal(undefined)} saved={done} />}
      {modal === 'link' && <LinkRequest scope={scope} detail={detail} close={refreshOnClose} saved={done} />}
      {modal === 'create' && detail.plan.delivery && <Modal label="发起合并请求" drawer busy={busy} close={refreshOnClose}>
        <MrPanel workspaceId={scope.workspaceId} plan={{ ...scope, name: detail.plan.name, branch: detail.plan.branch, delivery: detail.plan.delivery }}
          close={refreshOnClose} onLinked={done} onBusy={setBusy} /></Modal>}
      </>}
    </div>
  }

  function Plans({ selected, revision, openPlan, openMr, changed, renderCreate, openSession }: {
    selected?: PlanKey; revision: number; openSession(id: string): void; openPlan(plan?: PlanKey): void; openMr(ref: MrRef): void; changed(): void
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
        back={() => openPlan()} openMr={openMr} changed={changed} openSession={openSession} /> : <>
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

  function RequestDetail({ reference, origin, back, openPlan, changed }: {
    reference: MrRef; origin: Queue | 'plan'; back(): void; openPlan(plan: PlanKey): void; changed(): void
  }) {
    const result = useRead<{ mr: Mr; plans: PlanRow[]; planError: string; reviewSupported?: boolean; actions?: MrAction[] }>('workbenchMr', reference)
    const mr = result.value?.mr
    const [action, setAction] = useState<MrAction>()
    const [notice, setNotice] = useState('')
    return <main className="dy-yx dy-delivery dy-delivery-stack">
      <header><div><button className="dy-delivery-link" onClick={back}>返回{origin === 'plan' ? '计划' : queues[origin]}</button>
        <h2>!{reference.localId} {mr?.title || '合并请求详情'}</h2>
        {mr && <small>{mr.repository || result.value?.plans[0]?.plan.delivery?.path || '仓库 ' + mr.repositoryId}</small>}</div>
        <div className="dy-yx-actions"><button onClick={result.retry}>刷新</button>
          {result.value?.actions?.map(value => <button key={value} type="button"
            className={value === 'close' ? 'dy-mr-danger' : value === 'merge' ? 'dy-yx-primary' : undefined}
            onClick={() => { setNotice(''); setAction(value) }}>{mrActionLabels[value]}</button>)}
          {mr?.url && <a href={mr.url} target="_blank" rel="noreferrer">在 Codeup 打开</a>}</div></header>
      {result.error && <Problem error={result.error} retry={result.retry} />}
      {!result.error && !mr && <p role="status">正在读取合并请求详情…</p>}
      {notice && <p className="dy-yx-notice" role="status">{notice}</p>}
      {mr && <><dl className="dy-delivery-facts dy-delivery-card">
        <div><dt>分支</dt><dd><Branches source={mr.source} target={mr.target} /></dd></div>
        <div><dt>发起人</dt><dd>{mr.author || '—'}</dd></div>
        <div><dt>审核人</dt><dd>{mr.reviewers.filter(row => row.name).map(row =>
          row.name + (row.opinion === 'PASS' ? '（已批准）' : '')).join('、') || '—'}</dd></div>
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
      </section>{result.value?.reviewSupported ? <ReviewPanel key={keyOf(reference)} reference={reference} title={mr.title} /> :
        <section className="dy-delivery-card dy-delivery-section" aria-label="AI 合并审查">
          <h3>AI 合并审查</h3>
          <p role="status">当前 DSH 宿主尚未加载审查接口。请重启此 DSH 实例后刷新页面。</p>
        </section>}</>}
      {action && <MrActionDialog reference={reference} action={action} close={() => {
        setAction(undefined)
        result.retry()
        changed()
      }} done={() => {
        setNotice(mrActionReceipts[action] + ' · 已核对 Codeup')
        setAction(undefined)
        result.retry()
        changed()
      }} />}
    </main>
  }

  function MrActionDialog({ reference, action, close, done }: {
    reference: MrRef; action: MrAction; close(): void; done(): void
  }) {
    const intent = { ...reference, action }
    const result = useRead<MrActionPreview>('previewMrAction', intent)
    const preview = result.value
    const [mergeType, setMergeType] = useState<MrMergeType | ''>('')
    const [busy, setBusy] = useState(false)
    const [pending, setPending] = useState(false)
    const [error, setError] = useState('')
    const label = mrActionLabels[action]
    async function submit(event: ReactType.FormEvent) {
      event.preventDefault()
      if (busy || !preview || (!pending && action === 'merge' && !mergeType)) return
      setError('')
      setBusy(true)
      try {
        const check = { ...intent, scope: preview.scope }
        const receipt = await (pending ? rpc<MrActionResult>('checkMrAction', check) :
          rpc<MrActionResult>('submitMrAction', { ...check, token: preview.token, mergeType: mergeType || undefined }))
        if (receipt.confirmed) done()
        else setPending(true)
      } catch (failure) { setError(errorText(failure)) }
      finally { setBusy(false) }
    }
    return <Modal label={label} busy={busy} close={close}>
      <form onSubmit={submit}>
        <header><h2>{label}</h2></header>
        {result.error && <Problem error={result.error} retry={result.retry} />}
        {!preview && !result.error && <p role="status">正在核对 Codeup 合并请求…</p>}
        {preview && <>
          <p><strong>!{reference.localId} {preview.title}</strong></p>
          <p><Branches source={preview.source} target={preview.target} /></p>
          <p>操作账号 {preview.actor}</p>
          {preview.patch && <p>源补丁集 v{preview.patch.version} · <code>{preview.patch.sha.slice(0, 12)}</code></p>}
          {action === 'merge' && <>
            <label>合并方式 <select value={mergeType} disabled={busy || pending}
              onChange={event => setMergeType(event.target.value as MrMergeType | '')}>
              <option value="">请选择合并方式</option>
              <option value="no-fast-forward">普通合并</option>
              <option value="squash">压缩合并</option>
              <option value="rebase">变基合并</option>
              {preview.fastForward && <option value="ff-only">仅快进合并</option>}
            </select></label>
            <p>合并将更新目标分支，并保留源分支。</p>
          </>}
          {action === 'close' && <p>关闭后，Codeup 将结束此合并请求。</p>}
        </>}
        {pending && <p role="status" className="dy-yx-notice">Codeup 结果尚未确认。请核对结果后再继续。</p>}
        {error && <Problem error={error} />}
        <div className="dy-yx-actions">
          <button type="button" disabled={busy} onClick={close}>{pending ? '返回详情' : '取消'}</button>
          <button type="submit" className={action === 'close' && !pending ? 'dy-mr-danger' : 'dy-yx-primary'}
            disabled={busy || !preview || (!pending && action === 'merge' && !mergeType)}>
            {busy ? '正在处理…' : pending ? '核对结果' : '确认' + label}
          </button>
        </div>
      </form>
    </Modal>
  }

  function ReviewPanel({ reference, title }: { reference: MrRef; title: string }) {
    const { repositoryId, localId } = reference
    const [value, setValue] = useState<MrReviewView>()
    const [readError, setReadError] = useState('')
    const [actionError, setActionError] = useState('')
    const [source, setSource] = useState('')
    const [busy, setBusy] = useState<'pull' | 'cancel' | 'review'>()
    const [preview, setPreview] = useState(false)
    const [revision, refresh] = useState(0)
    const snapshot = value?.snapshot
    const pull = value?.pull
    const review = value?.review
    const comment = value?.comment
    const selected = value?.sources.find(row => row.id === source) ?? value?.sources[0]
    const report = useMemo(() => review?.markdown && renderReport(review.markdown), [review?.markdown])

    useEffect(() => {
      const abort = new AbortController()
      let timer: ReturnType<typeof setTimeout>
      let polling = false
      async function load() {
        try {
          const result = await rpc<MrReviewView>('mrReview', { repositoryId, localId }, abort.signal)
          if (abort.signal.aborted) return
          setReadError('')
          setValue(result)
          const status = result.pull?.status
          polling = status === 'running' || status === 'cancelling' || status === 'saving' || result.review?.status === 'running'
        } catch (error) {
          if (!abort.signal.aborted) setReadError(errorText(error))
        }
        if (polling && !abort.signal.aborted) timer = setTimeout(load, 1200)
      }
      void load()
      return () => { abort.abort(); clearTimeout(timer) }
    }, [repositoryId, localId, revision])

    async function run(action: 'pull' | 'cancel' | 'review') {
      setBusy(action)
      setActionError('')
      try {
        if (action === 'pull') await rpc('pullMrSnapshot', { repositoryId, localId })
        if (action === 'cancel' && pull) await rpc('cancelMrSnapshotPull', { repositoryId, localId, id: pull.id })
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

    const pulling = busy === 'pull' || pull?.status === 'running'
    const cancelling = busy === 'cancel' || pull?.status === 'cancelling'
    const saving = pull?.status === 'saving'
    const blocked = !value || !!busy || pulling || cancelling || saving || review?.status === 'running'
    return <section className="dy-delivery-card dy-delivery-section" aria-label="AI 合并审查">
      <h3>AI 合并审查</h3>
      <div className="dy-yx-actions">
        <button disabled={blocked} onClick={() => void run('pull')}>
          {cancelling ? '正在取消…' : saving ? '正在保存快照…' : pulling ? '正在拉取…' : snapshot ? '刷新本地快照' : '拉取 MR 到本地'}
        </button>
        {pull?.status === 'running' && <button type="button" disabled={!!busy} onClick={() => void run('cancel')}>
          取消拉取
        </button>}
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
      {pull?.status === 'running' && !cancelling && <p role="status">拉取会在后台继续，可以离开此页面。</p>}
      {pull?.status === 'cancelled' && !busy && <p role="status">已取消拉取。</p>}
      {pull?.status === 'failed' && <p role="alert" className="dy-yx-error">{pull.error}</p>}
      {value?.sources.length === 0 && <p>请在技能管理绑定包含 merge-code-review 和公司开发手册的技能源。</p>}
      {snapshot && <div className="dy-yx-meta">
        <p>补丁版本 {snapshot.version} · <code>{snapshot.source.slice(0, 12)}</code> → <code>{snapshot.target.slice(0, 12)}</code></p>
        <p>本地快照 <code className="dy-mr-snapshot-path">{snapshot.directory}</code></p>
      </div>}
      {review?.status === 'running' && <p role="status">正在生成审查报告…</p>}
      {review?.error && <p role="alert" className="dy-yx-error">{review.error}</p>}
      {report && <article className="dy-sk-markdown" aria-label="审查报告" dangerouslySetInnerHTML={{ __html: report }} />}
      {comment?.id ? <p role="status">已发布到 Codeup 评论 · <code>{comment.id}</code></p> : comment && review?.markdown &&
        <div className="dy-yx-actions">
          <button type="button" disabled={blocked} onClick={() => setPreview(true)}>
            {comment.pending ? '回查 Codeup 评论' : '预览回写评论'}
          </button>
        </div>}
      {preview && comment && !comment.id && review?.markdown && snapshot &&
        <ReviewCommentDialog key={comment.token} reference={reference} title={title} version={snapshot.version}
          report={review.markdown} comment={comment} close={() => setPreview(false)} refresh={() => refresh(n => n + 1)} />}
    </section>
  }

  function ReviewCommentDialog({ reference, title, version, report, comment, close, refresh }: {
    reference: MrRef; title: string; version: number; report: string; comment: MrReviewComment; close(): void; refresh(): void
  }) {
    const [markdown, setMarkdown] = useState(report)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const length = markdown.trim().length + 2 + comment.footer.length
    const valid = Boolean(markdown.trim()) && length <= mrReviewCommentLimit
    async function submit(event: ReactType.FormEvent) {
      event.preventDefault()
      if (busy || (!comment.pending && !valid)) return
      setBusy(true)
      setError('')
      try {
        await rpc('publishMrReviewComment', { ...reference, token: comment.token, markdown })
        close()
      } catch (failure) {
        setError(errorText(failure))
      } finally {
        setBusy(false)
        refresh()
      }
    }
    return <Modal label="审查报告回写预览" busy={busy} close={close}>
      <h2>审查报告回写预览</h2>
      <p>Codeup MR !{reference.localId} · {title} · 补丁版本 {version}</p>
      <form onSubmit={submit}>
        {comment.pending ? <p role="status">发布结果待核对。回查将读取 Codeup 评论列表。</p> :
          <fieldset disabled={busy}>
            <label>评论正文（Markdown）
              <textarea rows={12} value={markdown} aria-invalid={!valid} onChange={event => setMarkdown(event.target.value)} />
            </label>
            <p className="dy-yx-meta">{comment.footer}</p>
            {length > mrReviewCommentLimit && <p className="dy-yx-error">评论最多 {mrReviewCommentLimit} 字符。</p>}
          </fieldset>}
        {error && <Problem error={error} />}
        <div className="dy-yx-actions dy-delivery-footer">
          <button type="button" disabled={busy} onClick={close}>取消</button>
          <button className="dy-yx-primary" disabled={busy || (!comment.pending && !valid)}>
            {busy ? '正在核对…' : comment.pending ? '回查发布结果' : '确认发布到 Codeup'}
          </button>
        </div>
      </form>
    </Modal>
  }

  return { Plans, Requests, RequestDetail, IssueDocuments }
}
