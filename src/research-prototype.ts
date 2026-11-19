import { researchSkill } from './research-skill.ts'
import { decodeQuestions, extractResearchDraft, researchSummary, type DraftQuestion } from './research-questions.ts'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type ResearchIssue = { id?: string; title: string; text: string }
export const exampleIssues: ResearchIssue[] = [
  { title: '示例 A · 筛选后恢复议题列表', text: '用户重新打开云效议题时需要恢复此前的筛选条件。请检查插件已有行为，指出边界并给出验收场景。' },
  { title: '示例 B · 缺少附件时预览方案', text: '议题附件可能失效。请检查材料读取流程，提出保留正文、提示遗漏并验证结果的方案。' },
]
export type ResearchRow = {
  phase?: 'dispatching' | 'queued' | 'running' | 'collecting'; failedFeedback?: string; finalizedVersion?: number; issueId?: string; title: string; sessionId: string; status: 'running' | 'ready' | 'failed'; error?: string
  drafts: { markdown: string; feedback: string; questions?: DraftQuestion[] }[]
}
type Controller = {
  create(input: { sessionId: string; cwd: string; agentPreset: string }): Promise<{ sessionId?: string } | undefined>
  resolveAgent(id: string): Promise<{ agent?: { session: { append(event: string, value: object): unknown } }; error?: { message?: string } }>
  prompt(input: { sessionId: string; requestId: string; mode: 'queue'; content: { type: 'text'; text: string }[] }, signal: AbortSignal): Promise<unknown>
  wait(input: { sessionId: string; timeoutMs: number; maxMessages: number }, signal: AbortSignal): Promise<{
    reason: string; state?: { running: boolean; queue?: readonly { rpcId?: string }[] | null }; output: { records: { event: { data: { message?: { content?: { type: string; text?: string }[] } } } }[] }
  }>
}

type Work = { issue: ResearchIssue; cwd: string; first: boolean; feedback: string; requestId: string }
type SavedRow = ResearchRow & { work?: Work }

export function createResearch(controller: Controller, directory: string, hasSkill?: (sessionId: string, name: string) => Promise<boolean>) {
  const batches = new Map<string, SavedRow[]>()
  mkdirSync(directory, { recursive: true })
  function save(id: string) {
    const path = join(directory, id + '.json')
    const temp = path + '.' + randomUUID() + '.tmp'
    writeFileSync(temp, JSON.stringify(batches.get(id)), { mode: 0o600 })
    renameSync(temp, path)
  }
  function load(id: string) {
    if (!/^(?:[a-f0-9]{64}|[a-f0-9-]{36})$/.test(id)) throw new Error('无效的调研批次')
    if (!batches.has(id)) {
      const path = join(directory, id + '.json')
      const rows: SavedRow[] = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []
      batches.set(id, rows)
      for (const row of rows) if (row.status === 'running' && row.work) void run(id, row, row.work)
    }
    return batches.get(id)!
  }
  async function run(id: string, row: SavedRow, work: Work) {
    const { issue, cwd, first, feedback, requestId } = work
    row.work = work
    row.status = 'running'
    row.phase = 'dispatching'
    row.error = undefined
    try {
      save(id)
      if (first) {
        const created = await controller.create({ sessionId: row.sessionId, cwd, agentPreset: 'standard' })
        if (created?.sessionId && created.sessionId !== row.sessionId) {
          row.sessionId = created.sessionId
          save(id)
        }
        const { agent, error } = await controller.resolveAgent(row.sessionId)
        if (!agent) throw new Error(error?.message || '调研会话未就绪')
        agent.session.append('sandbox/mode', { mode: 'read-only' })
        agent.session.append('approval/policy', { policy: 'never' })
      }
      const marker = 'DRAFT-' + requestId
      const instructions = await hasSkill?.(row.sessionId, researchSkill.name) ? '/' + researchSkill.name : researchSkill.content
      const text = [instructions, first ? '调研本议题并生成草稿。' : '根据审核意见修订上一版草稿。', issue.title,
        first ? issue.text : '审核意见：' + feedback, '本轮草稿标识：' + marker].join('\n')
      await controller.prompt({ sessionId: row.sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }] }, AbortSignal.timeout(60000))
      row.phase = 'queued'
      const until = Date.now() + 15 * 60_000
      while (Date.now() < until) {
        const result = await controller.wait({ sessionId: row.sessionId, timeoutMs: 1500, maxMessages: 8 }, AbortSignal.timeout(15000))
        if (result.reason === 'input-required') throw new Error('会话需要额外输入，请查看 DSH 会话')
        if (result.state?.queue?.some(item => item.rpcId === requestId)) row.phase = 'queued'
        else if (result.state?.running) row.phase = 'running'
        else if (result.reason === 'idle') row.phase = 'collecting'
        if (result.reason === 'idle') {
          const reply = result.output.records.map(record => record.event.data.message?.content
            ?.filter(block => block.type === 'text').map(block => block.text).join('\n').trim())
            .map(value => value && extractResearchDraft(value, marker))
            .find(Boolean)
          if (reply) {
            row.drafts.push({ ...decodeQuestions(reply), feedback })
            row.status = 'ready'
            row.phase = undefined
            row.work = undefined
            save(id)
            return
          }
        }
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      throw new Error('未收到本轮完整草稿，请打开原会话检查模型连接和回复')
    } catch (error) {
      row.status = 'failed'
      row.error = error instanceof Error ? error.message : String(error)
      try { save(id) } catch (e) { row.error += ' · 无法保存状态：' + String(e) }
    }
  }
  function status({ batchId }: { batchId: string }): ResearchRow[] {
    return load(batchId).map(({ work, ...row }) => ({
      ...row, failedFeedback: row.status === 'failed' && work && !work.first ? work.feedback : undefined,
    }))
  }
  function start(cwd: string, issues: ResearchIssue[], batchId: string = randomUUID()) {
    const rows = load(batchId)
    for (const issue of issues) {
      const existing = issue.id && rows.find(r => r.issueId === issue.id)
      if (existing && (existing.status !== 'failed' || existing.drafts.length)) continue
      const row: SavedRow = existing || { issueId: issue.id, title: issue.title, sessionId: 'dy-research-' + randomUUID(), status: 'running', drafts: [] }
      if (!existing) rows.push(row)
      void run(batchId, row, { cwd, issue, first: true, feedback: '', requestId: randomUUID() })
    }
    return { batchId, rows: status({ batchId }) }
  }
  function revise(input: { batchId: string; sessionId: string; version: number; feedback: string }) {
    const row = load(input.batchId).find(item => item.sessionId === input.sessionId)
    if (!row || !row.drafts.length || row.status === 'running' || row.drafts.length !== input.version) throw new Error('请刷新后再发送修改意见')
    const feedback = input.feedback?.trim()
    if (!feedback || feedback.length > 8000) throw new Error('请输入 1 至 8000 字的修改意见')
    void run(input.batchId, row, { issue: { title: row.title, text: '' }, cwd: '', first: false, feedback, requestId: randomUUID() })
    const { work, ...view } = row
    return view
  }
  function summaries({ batchId }: { batchId: string }) {
    return load(batchId).map(researchSummary)
  }
  function finalize(input: { batchId: string; sessionId: string; version: number }) {
    const row = load(input.batchId).find(r => r.sessionId === input.sessionId)
    if (!row || row.drafts.length !== input.version || row.status === 'running') throw new Error('方案状态已变化，请查看最新版本')
    if (row.finalizedVersion === input.version) return researchSummary(row)
    if (!researchSummary(row).canFinalize) throw new Error('请先完成待确认事项')
    const previous = row.finalizedVersion
    row.finalizedVersion = input.version
    try { save(input.batchId) } catch (error) { row.finalizedVersion = previous; throw error }
    return researchSummary(row)
  }
  return { start, status, revise, summaries, finalize }
}

export type ResearchSummary = ReturnType<ReturnType<typeof createResearch>['summaries']>[number]
