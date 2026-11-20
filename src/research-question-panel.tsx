import type * as ReactType from 'react'
import type { ResearchRow } from './research-prototype.ts'
import { legacyQuestions, researchProgress } from './research-questions.ts'
import { reviewVersion } from './plan-review.ts'
import type { Rpc } from './mr-panel.tsx'

type Answer = { choice: string; custom: string }

export function createQuestionReview(React: typeof ReactType, rpc: Rpc) {
  return function QuestionReview({ rows, batchId, preview }: {
    rows: ResearchRow[]; batchId: string; preview(index: number): void
  }) {
    const [answers, setAnswers] = React.useState<Record<string, Answer>>({})
    const [receipts, setReceipts] = React.useState<Record<string, number>>({})
    const [errors, setErrors] = React.useState<Record<string, string>>({})
    const [sending, setSending] = React.useState(false)
    const groups = rows.map(row => {
      const version = row.drafts.length
      const draft = row.drafts.at(-1)
      const questions = draft?.questions ?? (draft && legacyQuestions(draft.markdown))
      const pending = row.status === 'running' || (receipts[row.sessionId] === version && row.status !== 'failed')
      const items = questions?.map((q, index) => {
        const key = JSON.stringify([row.sessionId, version, index])
        const answer = answers[key] ?? { choice: '', custom: '' }
        const options = [q.recommended, ...q.alternatives]
        const text = answer.choice === 'custom' ? answer.custom.trim() : options[Number.parseInt(answer.choice, 10)]
        return { ...q, options, key, answer, text }
      })
      return { row, version, items, pending }
    })
    const selected = groups.flatMap(g => g.pending ? [] : g.items?.filter(q => q.answer.choice !== '') ?? [])
    function change(key: string, patch: Partial<Answer>) {
      setAnswers(old => ({ ...old, [key]: { ...{ choice: '', custom: '' }, ...old[key], ...patch } }))
    }
    async function confirm() {
      setSending(true)
      try {
        await Promise.all(groups.map(async ({ row, version, items, pending }) => {
          const chosen = items?.filter(q => q.text)
          if (pending || !chosen?.length) return
          const feedback = ['以下是已确认的决定，请逐条落实到方案和验收条件，并保留仍未回答的问题。',
            ...chosen.map(q => q.question + '\n确认答案：' + q.text)].join('\n\n')
          try {
            await rpc('researchRevise', { batchId, sessionId: row.sessionId, version, feedback })
            setReceipts(old => ({ ...old, [row.sessionId]: version }))
            setErrors(old => ({ ...old, [row.sessionId]: '' }))
          } catch (e) { setErrors(old => ({ ...old, [row.sessionId]: String(e) })) }
        }))
      } finally { setSending(false) }
    }
    return <section className="dy-question-review" aria-label="集中答疑">
      <h3>待确认事项</h3>
      {groups.map(({ row, version, items, pending }, index) => <section key={row.sessionId} aria-label={row.title}>
        <header><strong>{row.title}</strong><button onClick={() => preview(index)}>{version ? reviewVersion(version, row.drafts.at(-1)?.proposalVersion) : '查看调研'}</button></header>
        <p role="status">{row.status === 'failed' ? [researchProgress(row), row.error].filter(Boolean).join(' · ') : pending ? (researchProgress(row) || '正在提交…') :
          receipts[row.sessionId] && version > receipts[row.sessionId] ? '答复已落实到第 ' + version + ' 轮调研' : ''}</p>
        {errors[row.sessionId] && <p role="alert">{errors[row.sessionId]}</p>}
        {version > 0 && !items && <p>旧版草稿未提供可识别的选项，可在方案预览中请原 Agent 整理待确认项。</p>}
        {items?.length === 0 && <p>当前方案没有待确认事项。</p>}
        {items?.map(q => <fieldset key={q.key} disabled={pending || sending}><legend>{q.question}</legend>
          {q.options.map((option, i) => <label key={i}><input type="radio" name={q.key} checked={q.answer.choice === String(i)}
            onChange={() => change(q.key, { choice: String(i) })} /><span><strong>{i ? '备选' : '推荐'}</strong> · {option}</span></label>)}
          <label><input type="radio" name={q.key} checked={q.answer.choice === 'custom'} onChange={() => change(q.key, { choice: 'custom' })}/> 自己补充</label>
          {q.answer.choice === 'custom' && <textarea aria-label={'补充回答：' + q.question} rows={3} value={q.answer.custom}
            onChange={e => change(q.key, { custom: e.target.value })}/>}
        </fieldset>)}
      </section>)}
      <button className="dy-yx-primary" disabled={sending || !selected.length || selected.some(q => !q.text)}
        onClick={confirm}>{sending ? '正在发送…' : '确认并发送答案'}{selected.length > 0 && '（' + selected.length + '）'}</button>
    </section>
  }
}
