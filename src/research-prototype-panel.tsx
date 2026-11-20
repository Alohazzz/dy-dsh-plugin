import { researchProgress } from './research-questions.ts'
import type * as ReactType from 'react'
import type { PlanKey } from './contracts.ts'
import type { ResearchRow } from './research-prototype.ts'
import type { Rpc } from './mr-panel.tsx'
import { createQuestionReview } from './research-question-panel.tsx'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

export function createResearchPrototype(React: typeof ReactType, rpc: Rpc) {
  const QuestionReview = createQuestionReview(React, rpc)
  const Markdown = React.memo(function Markdown({ text }: { text: string }) {
    const html = DOMPurify.sanitize(marked.parse(text, { async: false }), {
      ALLOWED_TAGS: ['p','br','h1','h2','h3','h4','ul','ol','li','strong','em','code','pre','blockquote','table','thead','tbody','tr','th','td'],
      ALLOWED_ATTR: [],
    })
    return <article className="dy-sk-markdown" dangerouslySetInnerHTML={{ __html: html }} />
  })
  return function ResearchPrototype({ workspaceId, close, openSession, plan, initialReview = false, initialIssue }: {
    initialReview?: boolean; initialIssue?: string; plan: PlanKey & { name: string; members: string[] }; workspaceId: string; close(): void; openSession(id: string): void
  }) {
    const [batchId, setBatchId] = React.useState('')
    const [rows, setRows] = React.useState<ResearchRow[]>([])
    const reviewing = initialReview
    const [selected, select] = React.useState(0)
    const [previewSession, setPreviewSession] = React.useState<string>()
    const [notes, setNotes] = React.useState<Record<string, string | undefined>>({})
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState('')
    const [syncError, setSyncError] = React.useState('')
    const [sending, setSending] = React.useState('')
    const [submitted, setSubmitted] = React.useState<Record<string, string>>({})
    React.useEffect(() => {
      const abort = new AbortController()
      rpc<{ batchId: string; rows: ResearchRow[] }>('planResearch', { project: plan.project, workspaceId, planId: plan.planId }, abort.signal)
        .then(value => {
          if (!abort.signal.aborted) { setRows(value.rows); select(Math.max(0, value.rows.findIndex(r => r.issueId === initialIssue))); setBatchId(value.batchId); setSyncError('') }
        }, e => { if (!abort.signal.aborted) setSyncError(String(e)) })
      return () => abort.abort()
    }, [plan.project, plan.planId, workspaceId])
    React.useEffect(() => {
      if (!batchId) return
      const abort = new AbortController()
      let timer: ReturnType<typeof setTimeout>
      async function poll() {
        try {
          const next = await rpc<ResearchRow[]>('researchStatus', { batchId }, abort.signal)
          if (!abort.signal.aborted) { setRows(next.filter(row => plan.members.includes(row.issueId || ''))); setSyncError('') }
        } catch (e) {
          if (!abort.signal.aborted) {
            setSyncError(String(e))
          }
        }
        if (!abort.signal.aborted) timer = setTimeout(poll, 1200)
      }
      void poll()
      return () => { abort.abort(); clearTimeout(timer) }
    }, [batchId, plan])
    const row = reviewing ? rows.find(item => item.sessionId === previewSession) : rows[selected]
    const draft = row?.drafts.at(-1)
    const feedbackText = row ? notes[row.sessionId] ?? row.failedFeedback ?? '' : ''
    async function send() {
      if (!row) return
      const feedback = feedbackText.trim()
      if (!feedback || busy) return
      setSending(row.sessionId); setBusy(true); setError('')
      try {
        const updated = await rpc<ResearchRow>('researchRevise', { batchId, sessionId: row.sessionId, version: row.drafts.length, feedback })
        setRows(old => old.map(item => item.sessionId === updated.sessionId ? updated : item))
        setSubmitted(old => ({ ...old, [row.sessionId]: feedback }))
        setNotes(old => ({ ...old, [row.sessionId]: undefined }))
      } catch (e) { setError(String(e)) } finally { setSending(''); setBusy(false) }
    }
    return <div className="dy-yx">{!initialIssue && <header><h2>{plan.name} · 批量答疑</h2><button onClick={close}>返回计划</button></header>}
      {(syncError || (!draft && error)) && <p role="alert">{syncError || error}</p>}
      {!batchId && !syncError && <p role="status">正在读取方案…</p>}
      <div className={reviewing && row ? 'dy-research-split' : undefined}>
        {batchId && <div hidden={!reviewing} className="dy-research-questions"><QuestionReview rows={rows} batchId={batchId}
          preview={i => setPreviewSession(rows[i].sessionId)} /></div>}
      {row && <section className={reviewing ? 'dy-research-preview' : undefined} aria-label="方案预览">
        {reviewing && <button onClick={() => setPreviewSession(undefined)}>收起预览</button>}
        <h3>{row.title}</h3>
        <div className="dy-yx-actions"><button onClick={() => openSession(row.sessionId)}>查看会话</button>
          <span role="status">{sending === row.sessionId ? '正在提交意见…' : researchProgress(row) || (draft && '草稿 v' + row.drafts.length + ' 已就绪')}</span></div>
        {row.error && <p role="alert">{draft ? (researchProgress(row) === '未送达' ? '修订意见未送达。' : '修订失败。') : ''}{row.error.includes('already owned by an active write handle') ? '原会话正被另一个 DSH 工作台占用，请释放该会话后重试。' : row.error}</p>}
        {draft && <><h3>{draft.report && !draft.proposal ? '调研报告' : '方案预览'} v{row.drafts.length}</h3>
          {draft.feedback && <p>本轮意见 · {draft.feedback}</p>}
          <Markdown text={draft.markdown} />
          {draft.report && draft.proposal && <details><summary>查看对应调研报告</summary><Markdown text={draft.report} /></details>}
          {row.reviews?.length ? <details><summary>审核记录</summary><ul>{row.reviews.map((review, index) =>
            <li key={index}>v{review.version} · {{ submitted: '送审', returned: '退回', approved: '批准' }[review.result]} · {review.actor} · {new Date(review.time).toLocaleString()}{review.note && ' · ' + review.note}</li>)}</ul></details> : null}
          {row.drafts.length > 1 && <details key={row.sessionId}><summary>查看上一版 · v{row.drafts.length - 1}</summary><Markdown text={row.drafts[row.drafts.length - 2].markdown} /></details>}
          <div className="dy-research-feedback">
            <label>给原 Agent 的修改意见<textarea rows={4} maxLength={8000} value={feedbackText} disabled={sending === row.sessionId}
              onChange={e => setNotes({ ...notes, [row.sessionId]: e.target.value })}/></label>
            <div role="status" aria-live="polite">{sending === row.sessionId ? '正在发送意见…' :
              row.status === 'running' ? researchProgress(row) :
              row.status === 'failed' ? '可检查意见后重新发送。' : draft.feedback ? '修订完成，已更新至 v' + row.drafts.length : ''}</div>
            {row.status === 'running' && submitted[row.sessionId] && <small>{submitted[row.sessionId]}</small>}
            {error && <p role="alert">{error}</p>}
            <button className="dy-yx-primary" disabled={busy || row.status === 'running' || !feedbackText.trim()} onClick={send}>发送并修订</button>
          </div></>}
      </section>}</div></div>
  }
}
