import type { Plan } from './contracts.ts'
import type { createClient } from './yunxiao-client.mjs'
import { archiveIndex, readPlanArchiveDocument, saveArchiveDocument, savePlanArchive, type ArchiveScope } from './workbench-archive.ts'
import { templateFor } from './workbench-documents.mjs'
import { digest } from './yunxiao.mjs'

type Client = ReturnType<typeof createClient>
export type CompletionAction = 'draft' | 'reviewed' | 'returned' | 'final'
const labels = { draft: '提交合并', reviewed: '审核', returned: '退回返工', final: '关闭' }
const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim()
const running = new Set<string>()

export async function workbenchCompletion(scope: ArchiveScope) {
  const plan = (await archiveIndex(scope)).plans.find(plan => plan.id === scope.planId)
  const reports = plan?.documents.filter(document => document.type === 'completion') ?? []
  const latest = reports.at(-1)
  const markdown = latest && (await readPlanArchiveDocument(scope, latest.file))?.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
  return { reports, latest, markdown }
}

export async function saveCompletion(scope: ArchiveScope, plan: Plan, api: Client, action: CompletionAction, note = '') {
  const key = digest(scope.root, scope.organization, scope.project, scope.planId)
  if (running.has(key)) throw new Error('计划报告正在保存，请稍后刷新')
  running.add(key)
  try { return await saveReport(scope, plan, api, action, note) }
  finally { running.delete(key) }
}

async function saveReport(scope: ArchiveScope, plan: Plan, api: Client, action: CompletionAction, note: string) {
  if (!Object.hasOwn(labels, action)) throw new Error('无效的计划报告操作')
  const ref = plan.delivery?.mr
  if (!ref) throw new Error('请先发起或关联计划的合并请求')
  await savePlanArchive(scope, plan)
  const archived = (await archiveIndex(scope)).plans.find(entry => entry.id === scope.planId)!
  const reports = archived.documents.filter(document => document.type === 'completion')
  const previous = reports.at(-1)
  if (previous?.reportStatus === 'final') {
    if (action === 'final') return previous
    throw new Error('交付计划已关闭')
  }
  const [mr, patches, actor] = await Promise.all([
    api.codeup.detail(ref).catch(() => undefined), api.codeup.patches(ref).catch(() => undefined),
    action === 'draft' ? undefined : api.currentUser(),
  ])
  const patch = patches ? `${patches.source.version}:${patches.source.sha}/${patches.target.version}:${patches.target.sha}` : undefined
  if (action !== 'draft' && !patch) throw new Error('无法核实当前 MR 补丁集，请稍后回查')
  if (action === 'reviewed' && (previous?.reportStatus !== 'draft' || previous.patch !== patch)) {
    throw new Error('请先按当前 MR 补丁生成并查看报告草稿')
  }
  if (action === 'returned' && (!previous || !note.trim())) throw new Error('请填写退回原因')
  if (action === 'final' && (previous?.reportStatus !== 'reviewed' || previous.patch !== patch ||
    mr?.status !== 'MERGED' || !mr.mergedRevision)) throw new Error('请先完成当前补丁的计划审核，并核实 MR 已合并')

  const ids = new Set([...plan.members, ...(plan.history?.initialMembers ?? []),
    ...(plan.history?.changes ?? []).map(change => change.issueId)])
  const unresolved = []
  const rows = []
  const verification = []
  let delivered = 0
  for (const id of ids) {
    const issue = archived.issues.find(item => item.id === id)
    const change = plan.history?.changes.findLast(item => item.issueId === id)
    const participation = plan.history?.changes.findLast(item => item.issueId === id && ['added', 'initial'].includes(item.kind))?.id
    const documents = (issue?.documents ?? []).filter(document => !document.participation || document.participation === participation)
    const approved = (issue?.reviews as { result: string; proposalVersion?: number }[] | undefined)
      ?.findLast(review => review.result === 'approved' && documents.some(document => document.type === 'proposal' && document.version === review.proposalVersion))
    const proposal = documents.find(document => document.type === 'proposal' && document.version === approved?.proposalVersion)
    const changes = documents.filter(document => document.type === 'change')
    const execution = documents.findLast(document => document.type === 'execution')
    const receipt = documents.findLast(document => document.type === 'publication')
    let outcome = '待核实'
    if (!plan.members.includes(id)) outcome = '移出'
    else if (change?.kind === 'deferred') outcome = '延期'
    else if (changes.length) { outcome = '已登记提交'; delivered++ }
    const label = issue?.reference ?? id
    if (outcome !== '已登记提交' || !receipt) unresolved.push(`${label}（${outcome}，${receipt ? '已存回执' : '测试回写待核实'}）`)
    const evidenceFolder = issue && (/\/[^/]+--[a-f0-9]{12}$/.test(archived.folder)
      ? issue.folder.slice(archived.folder.length + 1) : '../../' + issue.folder)
    const paths = [...(proposal ? [proposal] : []), ...(execution ? [execution] : []), ...changes, ...(receipt ? [receipt] : [])]
      .map(document => `[${document.file}](${evidenceFolder}/${document.file})`)
    rows.push(`| ${cell(label)} | ${outcome} | ${paths.join(' · ') || '待核实'} | ${changes.map(document => document.commitSha).join('、') || '待核实'} | ${receipt ? '已存回执' : '待核实'} |`)
    if (execution?.verification) verification.push(`### ${cell(label)}\n\n${execution.verification}\n\n待验证项 · ${cell(execution.pendingVerification || '待核实')}`)
  }
  if (action === 'final' && unresolved.length && !note.trim()) throw new Error('仍有延期、移出、待核实或待回写项，请填写各项后续去向')
  const description = plan.goal || '计划目标待核实'
  const history = plan.history?.changes.map(item =>
    `- ${item.at} · ${item.issueId} · ${{ initial: '初始加入', added: '追加', removed: '移出', deferred: '延期' }[item.kind]} · ${cell(item.reason)}`).join('\n')
  const parts = [
    `原定目标为「${cell(description)}」。已登记提交 ${delivered} 项，待对账或需跟进 ${unresolved.length} 项。`,
    `初始议题：${plan.history?.initialMembers?.join('、') || (plan.history?.initialMembers ? '无' : '待核实')}。\n\n${history || '无已记录的范围变动。'}`,
    [['| 议题 | 交付 | 依据 | 提交 SHA | 云效回写 |', '| --- | --- | --- | --- | --- |', ...rows].join('\n'), ...verification].join('\n\n'),
    `MR !${ref.localId} · ${mr?.status || '状态待核实'} · ${patch || '补丁待核实'}。\n\n${mr?.mergedRevision ? `合并提交 \`${mr.mergedRevision}\`。\n\n` : ''}${labels[action]}${actor ? ' · ' + cell(actor.name || String(actor.id)) : ''}${previous ? ` · 前版 v${previous.version}` : ''}。`,
    [unresolved.length ? '待跟进：' + unresolved.map(cell).join('、') + '。' : '无。', ...(note.trim() ? [note.trim().replace(/^#/gm, '\\#')] : [])].join('\n\n'),
  ]
  const evidence = digest(parts[0], parts[1], parts[2])
  if (action === 'reviewed' && previous?.evidence && previous.evidence !== evidence) {
    throw new Error('范围或交付记录已变化，请更新报告草稿后审核')
  }
  const markdown = '# 计划完成报告\n\n' + templateFor('completion').sections!.map((title, index) => `## ${title}\n\n${parts[index]}`).join('\n\n')
  const event = digest(action, patch, mr?.status, JSON.stringify(parts.filter((_, index) => index !== 3)),
    action === 'draft' ? reports.findLast(report => report.reportStatus === 'returned')?.version : previous?.version)
  return saveArchiveDocument(scope, undefined, 'completion', event, {
    reportStatus: action, patch, evidence, mr: ref, mrStatus: mr?.status ?? '待核实', mergedRevision: mr?.mergedRevision,
    previousReportVersion: previous?.version, actor: actor?.name || actor?.id,
  }, markdown)
}
