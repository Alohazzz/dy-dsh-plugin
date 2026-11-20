import type { ResearchRow } from './research-prototype.ts'
export type DraftQuestion = { question: string; recommended: string; alternatives: string[] }

export function checkedQuestions(items: unknown): DraftQuestion[] {
  if (!Array.isArray(items) || !items.every(q => q && typeof q.question === 'string' && q.question.trim()
    && typeof q.recommended === 'string' && q.recommended.trim() && Array.isArray(q.alternatives)
    && q.alternatives.every((a: unknown) => typeof a === 'string' && a.trim()))) {
    throw new Error('调研结果的待确认项缺少问题、推荐答案或备选答案清单')
  }
  return items
}

export function extractResearchDraft(reply: string, marker: string): string | undefined {
  const lines = reply.split(/\r?\n/)
  const start = lines.findIndex(line => line.trim() === marker)
  if (start < 0) return undefined
  return lines.slice(start + 1).join('\n').trim() || undefined
}

export function decodeQuestions(body: string): { markdown: string; questions: DraftQuestion[] } {
  const block = /(?:^|\n)`{3}(?:json)?\s*\n(\[[\s\S]*?\])\s*\n`{3}\s*$/.exec(body)
  if (!block) throw new Error('草稿缺少待确认项清单')
  const items = checkedQuestions(JSON.parse(block[1]))
  const markdown = body.slice(0, block.index).trim()
  if (!markdown) throw new Error('草稿正文为空')
  return { markdown, questions: items }
}

// Older prototype sessions stored the questions as prose under a Markdown heading.
export function legacyQuestions(markdown: string): DraftQuestion[] | undefined {
  const section = markdown.match(/^#{1,6}[^\n]*待确认[^\n]*\n([\s\S]*?)(?=^#{1,6} |(?![\s\S]))/m)?.[1]?.trim()
  if (!section) return undefined
  if (/^(?:\*\*)?无[。\s*]*$/.test(section)) return []
  const parts = section.replace(/\*\*/g, '').split(/^\s*(?:\d+[.、)]|[-*])\s+/m).map(s => s.trim()).filter(Boolean)
  const questions: DraftQuestion[] = []
  for (const part of parts) {
    const m = /^([\s\S]*?[？?])\s*推荐(?:答案|方案)?[：:是\s]*([\s\S]+?)[。；;\s]+备选(?:答案|方案)?[：:是\s]*([\s\S]+)$/.exec(part)
    if (!m) return undefined
    questions.push({ question: m[1], recommended: m[2], alternatives: [m[3]] })
  }
  return questions.length ? questions : undefined
}

export function researchProgress(row: ResearchRow) {
  if (row.status === 'failed') {
    if (row.phase === 'dispatching' || row.error?.includes('active write handle')) return '未送达'
    return row.drafts.length ? '修订失败' : '调研失败'
  }
  if (row.status !== 'running') return undefined
  return {
    dispatching: '正在派发',
    queued: '已送达 · 等待执行',
    running: row.drafts.length ? 'Agent 修订中' : 'Agent 调研中',
    collecting: '正在收取草稿',
  }[row.phase || 'dispatching']
}

export function researchSummary(row: ResearchRow) {
  const version = row.drafts.length
  const draft = row.drafts.at(-1)
  const questions = draft && (draft.questions ?? legacyQuestions(draft.markdown))
  const finalized = version > 0 && row.finalizedVersion === version
  const count = questions?.length
  const ready = row.status !== 'running' && version > 0 && count === 0 && !finalized
  const canSubmit = Boolean(ready && draft?.report && row.submittedVersion !== version)
  const canFinalize = ready && !canSubmit
  let label = '待核实问题清单'
  if (row.status === 'running') label = version ? '修订中' : '调研中'
  else if (row.status === 'failed' && !version) label = '调研失败'
  else if (finalized) label = '已定稿'
  else if (canSubmit) label = '待送审'
  else if (canFinalize && row.submittedVersion === version) label = '待审核'
  else if (canFinalize) label = '无待确认事项'
  else if (count) label = '待答疑 ' + count + ' 项'
  return { issueId: row.issueId, sessionId: row.sessionId, version, label, canFinalize, canSubmit,
    progress: researchProgress(row), count: row.status !== 'running' ? count : undefined }
}
