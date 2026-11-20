import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { test } from 'node:test'
import { archiveIndex, archiveScope, listIssueArchiveDocuments, readIssueArchiveDocument, saveArchiveDocument, savePlanArchive, searchedArchive } from '../src/workbench-archive.ts'
import { saveCompletion, workbenchCompletion } from '../src/workbench-completion.ts'
import { templateFor, validatedDocument } from '../src/workbench-documents.mjs'
import { createResearch } from '../src/research-prototype.ts'
import { digest } from '../src/yunxiao.mjs'

const plan = (id, name) => ({ id, name, branch: 'feature/test', end: '2026-11-25', members: ['issue'] })
const issue = { id: 'issue', reference: 'DEMO-32', title: '测试回写', module: '工作台' }
const markdown = (type, body = '使用模拟数据验证') =>
  templateFor(type).sections.map(heading => `## ${heading}\n\n${body}`).join('\n\n')

async function workspace(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dy-workbench-test-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('目录名可读且展示名修改后路径稳定，旧档案可直接读取和续写', async t => {
  const root = await workspace(t)
  const scope = archiveScope(root, 'org', 'project', 'plan', '诊疗 / 工作台')
  await savePlanArchive(scope, plan(scope.planId, '第一批交付'))
  const first = await saveArchiveDocument(scope, issue, 'research', 'event-1', {}, markdown('research'))
  const index = await archiveIndex(scope)
  assert.match(index.folder, /^docs\/workbench\/诊疗-工作台--[a-f0-9]{12}$/)
  assert.match(index.plans[0].folder, /^plans\/第一批交付--[a-f0-9]{12}$/)
  assert.match(index.plans[0].issues[0].folder, /issues\/DEMO-32-测试回写--[a-f0-9]{12}$/)
  assert.equal(first.file, '调研报告-v1.md')
  const renamed = { ...scope, projectName: '新项目名' }
  await savePlanArchive(renamed, plan(scope.planId, '新计划名'))
  await saveArchiveDocument(renamed, { ...issue, title: '新议题名' }, 'research', 'event-2', {}, markdown('research'))
  const after = await archiveIndex(renamed)
  assert.equal(after.folder, index.folder)
  assert.equal(after.plans[0].folder, index.plans[0].folder)
  assert.equal(after.plans[0].issues[0].folder, index.plans[0].issues[0].folder)

  const legacy = { ...scope, project: 'legacy', planId: 'legacy-plan' }
  const path = join(root, 'docs', 'workbench', digest('org'), digest('legacy'), 'plans', digest('legacy-plan'))
  const issuePath = join(path, 'issues', digest(issue.id))
  await mkdir(issuePath, { recursive: true })
  await writeFile(join(path, 'plan.json'), JSON.stringify({ ...plan(legacy.planId, '旧计划'), documents: [] }))
  await writeFile(join(issuePath, 'issue.json'), JSON.stringify({ ...issue, documents: [
    { event: 'old', type: 'research', file: 'research-v1.md', version: 1, templateVersion: 1, time: '2026-11-19T03:00:00Z' },
  ] }))
  await writeFile(join(issuePath, 'research-v1.md'), '旧档案仍从原路径读取')
  assert.equal((await readIssueArchiveDocument(legacy, issue.id, { type: 'research', version: 1 })).body, '旧档案仍从原路径读取')
  assert.equal((await saveArchiveDocument(legacy, issue, 'research', 'new', {}, markdown('research'))).file, '调研报告-v2.md')
  const documents = await listIssueArchiveDocuments(legacy, issue.id)
  assert.deepEqual(documents.map(document => document.version), [1, 2])
  assert.equal((await searchedArchive(legacy, ['旧档案'])).length, 1)
})

test('模板校验拒绝缺字段、空正文、重复和错序，代码围栏内标题保留', () => {
  const fields = { projectId: 'p', planId: 'a', issueId: issue.id, documentVersion: 1 }
  const body = markdown('research')
  assert.throws(() => validatedDocument('research', 'report.md', {}, body), /report\.md.*projectId/)
  assert.throws(() => validatedDocument('research', 'report.md', fields, body.replace('\n\n使用模拟数据验证', '')), /正文为空/)
  assert.throws(() => validatedDocument('research', 'report.md', fields, body + '\n\n## 业务背景与范围\n\n重复'), /重复/)
  assert.throws(() => validatedDocument('research', 'report.md', fields, body.replace('业务背景与范围', '暂存标题')
    .replace('业务规则与例外', '业务背景与范围').replace('暂存标题', '业务规则与例外')), /按模板排列/)
  assert.equal(validatedDocument('research', 'report.md', fields, body + '\n\n\x60\x60\x60md\n## 示例\n\x60\x60\x60').templateVersion, 1)
})

test('A 的延迟调研写回原项目，重启可兼容旧材料并重建索引', async t => {
  const root = await workspace(t)
  const a = archiveScope(root, 'org', 'A', 'plan-old')
  const b = archiveScope(root, 'org', 'B', 'plan-new')
  const a2 = archiveScope(root, 'org', 'A', 'plan-current')
  assert.deepEqual((await archiveIndex(a)).plans, [])
  await assert.rejects(readFile(join(root, 'docs', 'workbench', 'README.md')), { code: 'ENOENT' })
  await savePlanArchive(a, plan(a.planId, '历史计划'))
  const path = join(root, 'docs', 'workbench')
  await writeFile(join(path, 'README.md'), '# 项目自己的入口')
  let prompt
  let answer
  const controller = {
    create: async input => input,
    resolveAgent: async () => ({ agent: { session: { append() {} } } }),
    prompt: async input => { prompt = input },
    wait: async () => {
      if (!answer) return { reason: 'running' }
      const text = 'DRAFT-' + prompt.requestId + '\n' + JSON.stringify(answer)
      return { reason: 'idle', output: { records: [{ event: { data: { message: { content: [{ type: 'text', text }] } } } }] } }
    },
  }
  const state = join(root, 'research')
  const research = createResearch(controller, state)
  const batchId = digest('batch-a')
  const rows = () => research.status({ batchId })
  const settle = async () => {
    for (let i = 0; i < 50; i++) {
      const row = rows()[0]
      if (row?.status === 'ready') return row
      if (row?.status === 'failed') assert.fail(row.error)
      await setTimeout(35)
    }
    assert.fail('调研未返回')
  }
  research.start(root, [{ id: issue.id, title: issue.title, text: '原文', archive: { scope: a, issue } }], batchId)
  await savePlanArchive(b, plan(b.planId, '另一项目'))
  answer = { report: markdown('research', '旧回执复用需要确认迁移方式'), proposal: null, decisions: [],
    questions: [{ question: '采用哪种旧回执兼容方式？', recommended: '兼容读取', alternatives: ['迁移后读取'] }] }
  const first = await settle()
  assert.equal(first.drafts[0].proposalVersion, undefined)
  assert.equal(research.summaries({ batchId })[0].canSubmit, false)
  answer = { report: markdown('research', '已确认保留原回执'), proposal: markdown('proposal'), decisions: ['兼容读取'], questions: [] }
  research.revise({ batchId, sessionId: first.sessionId, version: 1, feedback: '选择兼容读取' })
  await settle()
  const key = { batchId, sessionId: first.sessionId, version: 2, actor: '审核员' }
  assert.throws(() => research.finalize(key), /确认事项|送审/)
  research.submit(key)
  research.revise({ ...key, feedback: '请补充异常验收' })
  await settle()
  research.submit({ ...key, version: 3 })
  research.finalize({ ...key, version: 3 })
  await research.archiveReviews(batchId, first.sessionId)
  assert.equal(createResearch(controller, state).summaries({ batchId })[0].label, '已定稿')
  assert.equal((await archiveIndex(b)).plans[0].issues.length, 0)
  await savePlanArchive(a2, plan(a2.planId, '新计划'))
  const indexPath = join(root, (await archiveIndex(a)).folder, 'index.json')
  await writeFile(indexPath, '{broken')
  const hits = await searchedArchive(a2, ['旧回执'])
  assert.equal(hits[0].plan, '历史计划')
  await saveArchiveDocument(a2, issue, 'research', 'replacement', { supersedes: [hits[0].path] },
    markdown('research', '旧回执处理规则已替代'))
  assert.ok((await searchedArchive(a2, ['旧回执'])).find(hit => hit.path === hits[0].path).supersededBy.length)
  assert.deepEqual(await searchedArchive(b, ['旧回执']), [])
  assert.equal(await readFile(join(path, 'README.md'), 'utf8'), '# 项目自己的入口')
  const index = JSON.parse(await readFile(indexPath, 'utf8'))
  const archivedIssue = index.plans.find(row => row.id === a.planId).issues[0]
  assert.equal(archivedIssue.documents.filter(entry => entry.type === 'proposal').length, 2)
  assert.deepEqual(archivedIssue.reviews.map(review => review.result), ['submitted', 'returned', 'submitted', 'approved'])
  await writeFile(join(path, 'manifest.json'), '{"archiveVersion":999}')
  await assert.rejects(archiveIndex(a), /安装支持该格式的插件/)
})

test('宿主 RPC 在 A 启动调研、切到 B 建计划、重启后返回 A 查档', async t => {
  const root = await workspace(t)
  const cwd = join(root, 'repo')
  const home = join(root, 'dsh')
  await mkdir(cwd)
  await mkdir(join(home, 'dy-yunxiao'), { recursive: true })
  t.mock.method(globalThis, 'fetch', async url => {
    const path = new URL(url).pathname
    if (path.endsWith('/attachments')) return Response.json([])
    if (path.endsWith('/workitems/issue')) {
      return Response.json({ id: 'issue', spaceId: 'A', serialNumber: 'DEMO-32', subject: '测试回写', description: '模拟议题正文' })
    }
    throw new Error('非预期远端请求 ' + path)
  })
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' })
  git('init', '--initial-branch=feature/test')
  git('-c', 'user.name=Demo', '-c', 'user.email=demo@example.invalid', 'commit', '--allow-empty', '-m', 'initial')
  const directory = await realpath(cwd)
  const a = { workspaceId: 'workspace', project: 'A', planId: 'plan-old' }
  const b = { workspaceId: 'workspace', project: 'B' }
  await writeFile(join(home, 'dy-yunxiao', 'plans-' + digest('org', 'A', directory) + '.json'),
    JSON.stringify([plan(a.planId, 'A 历史计划')]))
  const { apply } = await import(process.env.DY_TEST_WORKBENCH_HOST
    ? pathToFileURL(process.env.DY_TEST_WORKBENCH_HOST).href : '../src/host.ts')
  let endpoint
  let canFinish = false
  let requestId
  const registered = new Set()
  const registeredWorkspace = { id: a.workspaceId, path: directory, title: '测试工作区' }
  const context = {
    get() {}, on() {}, tools: { guard() {} }, commands: { register() {} },
    inject(_names, install) { install({ skills: { register: skill => registered.add(skill.name), registerProvider() {} } }) },
    credentials: { readRecord: async () => ({ kind: 'api-key', key: 'fixture-token', env: { YUNXIAO_ORG_ID: 'org' } }) },
    workspaceRegistry: { get: id => id === a.workspaceId ? registeredWorkspace : undefined, list: () => [registeredWorkspace] },
    connection: { fetch: { register(route) { if (route.path === '/api/dy-yunxiao') endpoint = route.fetch } } },
    sessionController: {
      create: async input => input,
      resolveAgent: async () => ({ agent: { session: { append() {} } } }),
      prompt: async input => { requestId = input.requestId },
      wait: async () => {
        if (!canFinish) return { reason: 'running' }
        const text = 'DRAFT-' + requestId + '\n' + JSON.stringify({ report: markdown('research', '旧回执查档样例'),
          proposal: markdown('proposal'), decisions: [], questions: [] })
        return { reason: 'idle', output: { records: [{ event: { data: { message: { content: [{ type: 'text', text }] } } } }] } }
      },
    },
  }
  apply(context)
  assert(registered.has('dy-workbench-docs'))
  async function rpc(method, input) {
    const body = await (await endpoint(new Request('http://localhost/api/dy-yunxiao', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, input }),
    }))).json()
    assert.equal(body.error, undefined, body.error)
    return body.value
  }
  await rpc('planResearch', a)
  await assert.rejects(readFile(join(directory, 'docs', 'workbench', 'manifest.json')), { code: 'ENOENT' })
  await rpc('planResearch', { ...a, start: true })
  await rpc('createPlan', { ...b, name: 'B 新建计划', branch: 'feature/test', end: '2026-11-25' })
  canFinish = true
  let row
  for (let i = 0; i < 50; i++) {
    row = (await rpc('planResearch', a)).rows[0]
    if (row?.status !== 'running') break
    await setTimeout(35)
  }
  assert.equal(row?.status, 'ready', row?.error)
  apply(context)
  const index = join(directory, (await archiveIndex(archiveScope(directory, 'org', 'A', a.planId))).folder, 'index.json')
  await rm(index)
  const sameProject = await rpc('searchWorkbenchArchive', { ...a, query: '旧回执' })
  assert.equal(sameProject[0].plan, 'A 历史计划')
  assert.deepEqual(await rpc('searchWorkbenchArchive', { ...b, query: '旧回执' }), [])
  assert.equal((await rpc('planResearch', a)).rows[0].sessionId, row.sessionId)
  assert.ok((await readFile(index, 'utf8')).includes(a.planId))
  const listing = await rpc('issueDocuments', { project: a.project, id: issue.id })
  assert.deepEqual(listing.errors, [])
  assert.deepEqual(listing.documents.map(document => document.type).sort(), ['proposal', 'research'])
  const research = listing.documents.find(document => document.type === 'research')
  const snapshot = await rpc('issueDocument', { ...research, project: a.project, id: issue.id })
  assert.equal(snapshot.format, 'markdown')
  assert.match(snapshot.body, /^## 业务背景与范围/)
  assert.match(snapshot.body, /旧回执查档样例/)
  assert.deepEqual((await rpc('issueDocuments', { project: b.project, id: issue.id })).documents, [])
})

test('计划审核绑定补丁，返工后形成新草稿，MR 合并与回写分开对账', async t => {
  const root = await workspace(t)
  const scope = archiveScope(root, 'org', 'project', 'plan')
  const current = { ...plan(scope.planId, '测试回写'), goal: '独立发布测试',
    delivery: { key: '.', path: 'demo/repo', repositoryId: 1, target: 'main', mr: { repositoryId: 1, localId: 2 } },
    members: ['issue', 'later'], history: { initialMembers: ['issue', 'later', 'removed'],
      changes: [{ id: 'd', issueId: 'later', kind: 'deferred', at: '2026-11-20', reason: '等待测试环境' },
        { id: 'r', issueId: 'removed', kind: 'removed', at: '2026-11-20', reason: '移入后续计划' }] } }
  await savePlanArchive(scope, current)
  const event = await saveArchiveDocument(scope, issue, 'change', 'commit-1', {
    repository: 'demo/repo', commitSha: 'b'.repeat(40), reason: '独立发布', scope: ['src/workflow.ts'], executionRef: '待核实',
  })
  assert.equal((await saveArchiveDocument(scope, issue, 'change', 'commit-1', {})).version, event.version)
  let status = 'UNDER_REVIEW'
  let version = 1
  const api = {
    currentUser: async () => ({ id: 'user', name: '审核员' }),
    codeup: {
      detail: async () => ({ status, mergedRevision: status === 'MERGED' ? 'c'.repeat(40) : '' }),
      patches: async () => ({ source: { version, sha: String(version).repeat(40) }, target: { version: 1, sha: 'a'.repeat(40) } }),
    },
  }
  await saveCompletion(scope, current, api, 'draft')
  await saveCompletion(scope, current, api, 'returned', '补充测试回写证据')
  version = 2
  await assert.rejects(saveCompletion(scope, current, api, 'reviewed'), /当前 MR 补丁/)
  await saveCompletion(scope, current, api, 'draft')
  await saveCompletion(scope, current, api, 'reviewed')
  status = 'MERGED'
  await assert.rejects(saveCompletion(scope, current, api, 'final'), /后续去向/)
  await saveCompletion(scope, current, api, 'final', 'DEMO-32 由测试负责人补回写，延期和移出转后续计划。')
  const report = await workbenchCompletion(scope)
  assert.equal(report.latest.reportStatus, 'final')
  assert.deepEqual(report.reports.map(entry => entry.reportStatus), ['draft', 'returned', 'draft', 'reviewed', 'final'])
  assert.match(report.markdown, /MERGED[\s\S]*测试回写待核实/)
  assert.match(report.markdown, /later.*延期/)
  assert.match(report.markdown, /removed.*移出/)
})
