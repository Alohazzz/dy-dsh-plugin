import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { createClient, YunxiaoHttpError } from '../src/yunxiao-client.mjs'
import { createHandler, digest } from '../src/yunxiao.mjs'
import { apply } from '../src/host.ts'
import { createResearch } from '../src/research-prototype.ts'
import { researchSkill } from '../src/research-skill.ts'
import { planWritingInstructions, writingSkill } from '../src/writing-skill.mjs'
import { createWorkflow, executionSkill } from '../src/workflow.ts'
import { archiveIndex, archiveScope } from '../src/workbench-archive.ts'
import { legacyExecutionDocumentInstructions, templateFor } from '../src/workbench-documents.mjs'

async function addPlannedIssue(workflow, cwd, { project, id }) {
  const plan = await workflow.createPlan(cwd, project, { name: '交付计划', branch: 'feature/test', end: '2026-11-20' })
  const [result] = await workflow.addToPlan(cwd, project, plan.id, [id])
  assert.equal(result.result, '成功', result.error)
  return { project, id, planId: plan.id }
}

test('作废保留历史并释放议题，重试和过期写入不会改变作废结果', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'dy-void-plan-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const api = { organization: 'org', get: async id => ({ id, spaceId: 'project' }), schedule: async () => {} }
  const options = { home: join(cwd, 'state'), host: {}, branchExists: async () => {}, client: () => api }
  const workflow = createWorkflow(options)
  const { planId } = await addPlannedIssue(workflow, cwd, { project: 'project', id: 'issue' })
  const [receipt, retry] = await Promise.all([1, 2].map(() => workflow.voidPlan(cwd, 'project', 'org', planId)))
  assert.deepEqual(receipt, retry)
  assert.deepEqual(await createWorkflow(options).plans(cwd, 'project'), [])
  const [archived] = (await archiveIndex(archiveScope(cwd, 'org', 'project', planId))).plans
  assert.equal(archived.voidedAt, receipt.voidedAt)
  assert.deepEqual(archived.members, ['issue'])
  await assert.rejects(workflow.addToPlan(cwd, 'project', planId, ['other']), /已作废/)
  await assert.rejects(workflow.removeFromPlan(cwd, 'project', planId, 'issue'), /已作废/)
  const next = await addPlannedIssue(workflow, cwd, { project: 'project', id: 'issue' })
  assert.notEqual(next.planId, planId)
})

test('执行 RPC 核对计划归属、最新定稿和检出分支，并移除旧入口', async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'dy-plan-rpc-')))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = cwd
  t.after(() => {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  })
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' })
  git('init', '--initial-branch=main')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial')

  const workspaceId = 'workspace'
  const input = { workspaceId, project: 'project', planId: 'plan', id: 'issue', version: 2 }
  const home = join(cwd, 'dy-yunxiao')
  const batchId = digest(JSON.stringify(['org', workspaceId, input.project, input.planId]))
  await mkdir(join(home, 'research'), { recursive: true })
  await writeFile(join(home, 'plans-' + digest('org', input.project, cwd) + '.json'), JSON.stringify([
    { id: input.planId, name: '交付计划', branch: 'feature/test', end: '2026-11-20', members: [input.id] },
  ]))
  await writeFile(join(home, 'research', batchId + '.json'), JSON.stringify([{
    issueId: input.id, title: 'TEST-1', sessionId: 'research-1', status: 'ready', finalizedVersion: 1,
    drafts: [{ markdown: '# 原定稿', questions: [], feedback: '' }, { markdown: '# 当前方案', questions: [], feedback: '' }],
  }]))
  t.mock.method(globalThis, 'fetch', async url => {
    const path = new URL(url).pathname
    if (path.endsWith('/attachments')) return Response.json([])
    assert.ok(path.endsWith('/workitems/issue'))
    return Response.json({ id: 'issue', spaceId: 'project', serialNumber: 'TEST-1', categoryId: 'Req', description: '原文' })
  })

  let endpoint
  const registeredSkills = []
  const permissions = []
  const created = []
  const prompts = []
  const sessionState = { cursor: 20, running: true, queue: [], pendingInput: [] }
  const end = { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
  const reply = { type: 'assistant/message', data: { turn: 1, message: { content: [] } } }
  apply({
    get() {}, on() {}, tools: { guard() {} }, commands: { register() {} },
    inject(_names, install) {
      install({ skills: { register: skill => registeredSkills.push(skill), registerProvider() {} } })
    },
    credentials: { readRecord: async () => ({ kind: 'api-key', key: 'test-token', env: { YUNXIAO_ORG_ID: 'org' } }) },
    workspaceRegistry: { get: id => id === workspaceId ? { id, path: cwd } : undefined },
    connection: { fetch: { register(route) { if (route.path === '/api/dy-yunxiao') endpoint = route.fetch } } },
    permissionPresets: { set: (session, preset) => permissions.push([session, preset]) },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { session: sessionId } }),
      create: async input => { created.push(input) },
      prompt: async input => { prompts.push(input) },
      state: async ({ sessionId }) => {
        assert.equal(sessionId, created[0].sessionId)
        return sessionState
      },
      events: async ({ throughSeq }) => {
        assert.equal(throughSeq, sessionState.cursor)
        return { records: [{ event: reply }, { event: end }] }
      },
    },
  })
  assert.ok(registeredSkills.includes(writingSkill))
  assert.match(writingSkill.content, /## 参考资料路由/)
  for (const skill of [executionSkill, researchSkill]) {
    assert.ok(registeredSkills.includes(skill))
    assert.ok(skill.content.includes(planWritingInstructions))
  }
  const rpc = async (method, input) => (await endpoint(new Request('http://localhost/api/dy-yunxiao', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, input }),
  }))).json()
  for (const method of ['start', 'researchStart']) {
    assert.match((await rpc(method, input)).error, /未知云效操作/)
  }
  assert.match((await rpc('executePlanIssue', { ...input, id: 'other' })).error, /不在当前交付计划/)
  assert.match((await rpc('executePlanIssue', input)).error, /检出源分支/)
  git('switch', '-c', 'feature/test')
  assert.match((await rpc('executePlanIssue', input)).error, /最新方案已定稿/)
  assert.match((await rpc('executePlanIssue', { ...input, version: 1 })).error, /最新方案已定稿/)
  assert.equal(created.length, 0)
  assert.equal(prompts.length, 0)
  const finalized = await rpc('researchFinalize', { batchId, sessionId: 'research-1', version: 2 })
  assert.equal(finalized.value.label, '已定稿')
  const plan = (await rpc('workbenchPlan', input)).value
  assert.equal(plan.executionSupported, true)
  assert.equal(plan.issues[0].category, 'Req')
  const execution = await rpc('executePlanIssue', input)
  assert.ok(execution.value?.sessionId, execution.error)
  const { sessionId } = execution.value
  assert.deepEqual(created, [{ sessionId, cwd, agentPreset: 'standard' }])
  assert.deepEqual(permissions, [[sessionId, 'danger-full-access']])
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].mode, 'queue')
  const folder = join(cwd, '.dsh', 'yunxiao', digest(sessionId))
  assert.equal(prompts[0].content[0].text,
    '按定稿执行云效议题 TEST-1。任务清单：' + join(folder, 'task.json') + '\n读取清单中的 instructions 字段并执行。')
  const task = JSON.parse(await readFile(join(folder, 'task.json'), 'utf8'))
  assert.equal(task.instructions, executionSkill.content)
  assert.match(task.instructions, /src\/module\.ts:42/)
  assert.match(task.instructions, /保存执行小结/)
  assert.ok(registeredSkills.some(item => item.name === 'dy-workbench-docs'))
  assert.match(task.instructions, /^## 影响范围与测试\r?\n面向测试人员.*区分已验证、验证失败和待验证项/m)
  assert.doesNotMatch(task.instructions, /研发工作台文档|规则优先级|调研与执行方案/)
  for (const section of templateFor('execution').sections) assert.ok(task.instructions.includes(section))
  assert.equal((await rpc('workbenchPlan', input)).value.issues[0].sessionId, sessionId)
  assert.equal(await readFile(join(cwd, '.dsh', 'yunxiao', digest(sessionId), 'plan.md'), 'utf8'), '# 当前方案')
  const states = () => rpc('planExecutionStatuses', { ...input, ids: ['other', input.id] }).then(result => {
    assert.equal(result.value?.length, 1, result.error)
    assert.equal(result.value[0].sessionId, sessionId)
    return result.value[0]
  })
  sessionState.queue = [{ rpcId: prompts[0].requestId }]
  assert.equal((await states()).stage, 'queued')
  sessionState.queue = []
  await writeFile(task.execution, '')
  assert.equal((await states()).stage, 'running')
  sessionState.pendingInput = ['approval']
  assert.equal((await states()).detail, '等待操作授权')
  sessionState.pendingInput = []
  sessionState.running = false
  assert.equal((await states()).stage, 'failed')
  await rm(task.execution)
  assert.match((await states()).detail, /未收到执行小结/)
  reply.data.message.content = [{ type: 'text', text: '待确认：是否保留历史记录？' }]
  assert.equal((await states()).stage, 'input')
  assert.equal((await states()).detail, '是否保留历史记录？')
  reply.data.message.content = []
  await writeFile(task.execution, templateFor('execution').sections.map(title => '## ' + title + '\n正文').join('\n\n'))
  end.data.reason = { kind: 'error', error: { message: '模型连接中断' } }
  assert.equal((await states()).detail, '模型连接中断')
  end.data.reason = { kind: 'completed' }
  assert.equal((await states()).stage, 'ready')
  const delta = 'A1 · 参数关闭且已有关系值，预期留空，当前显示原值，待验证。'
  const note = (await readFile(task.execution, 'utf8')).replace('## 与定稿的偏差\n正文',
    '## 与定稿的偏差\n内部重构\n\n### **（一）可观察行为差异：**\n' + delta)
  await writeFile(task.execution, note)
  await writeFile(task.discussion, '## ２．**影响范围与测试**：\n保留首诊用例\n\n### 1) 可观察行为差异\n过期场景\n\n### 其他测试\n保留边界用例')
  const handoff = await rpc('executionHandoff', { ...input, sessionId })
  assert.equal(handoff.value?.differences, delta, handoff.error)
  assert.ok(handoff.value.test.includes(delta))
  assert.match(handoff.value.test, /保留首诊用例[\s\S]*保留边界用例/)
  assert.doesNotMatch(handoff.value.test, /内部重构|过期场景/)
  assert.match((await rpc('executionHandoff', { ...input, sessionId: 'unrelated' })).error, /绑定/)
  assert.ok((await rpc('archivePlanExecution', input)).value?.execution)
  assert.equal((await states()).stage, 'confirmed')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.invalid')
  await writeFile(join(cwd, '代码.txt'), '实现')
  await writeFile(join(cwd, '说明.md'), '说明')
  await writeFile(join(cwd, 'other.txt'), '其他议题')
  git('add', 'other.txt')
  const changedFiles = (await rpc('closeoutFiles', input)).value
  assert.ok(changedFiles.includes('说明.md'))
  assert.ok(!changedFiles.some(file => file.startsWith('.dsh/')))
  const submitted = await rpc('submitCloseout', { ...input, files: ['代码.txt', '说明.md'] })
  assert.match(submitted.value || submitted.error, /^[a-f0-9]{40}$/)
  assert.equal(git('diff', '--cached', '--name-only').toString().trim(), 'other.txt')
  assert.equal((await states()).stage, 'submitted')
  assert.ok((await rpc('voidPlan', input)).value?.voidedAt)
  assert.match((await rpc('executePlanIssue', input)).error, /已作废/)
  assert.deepEqual((await rpc('plans', input)).value, [])
})

test('调研只在首次创建任务会话，修订复用会话并保留只读调研指令', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'dy-research-writing-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const prompts = []
  const events = []
  let researchSkillAvailable = false
  let needsInput = true
  const research = createResearch({
    prompt: async input => {
      prompts.push(input)
      events.push([input.sessionId, 'prompt'])
    },
    wait: async () => {
      if (needsInput) return { reason: 'input-required' }
      const { requestId } = prompts.at(-1)
      const text = ['DRAFT-' + requestId, '# 方案', '~~~JSON', '[]', '~~~'].join('\n')
      return { reason: 'idle', output: { records: [{ event: { data: { message: { content: [{ type: 'text', text }] } } } }] } }
    },
  }, cwd, async ({ sessionId }) => {
    events.push([sessionId, 'create'])
    return { sessionId }
  }, async () => researchSkillAvailable)
  const batchId = digest('writing-test')
  const { rows: [{ sessionId }] } = research.start(cwd, [{ id: 'issue', title: '测试议题', text: '议题原文' }], batchId)
  await setImmediate()
  assert.equal(research.summaries({ batchId })[0].label, '调研待确认')
  needsInput = false
  await t.waitFor(() => assert.equal(research.status({ batchId })[0].status, 'ready'), { timeout: 5000 })
  assert.equal(research.status({ batchId })[0].drafts.length, 1)
  researchSkillAvailable = true
  research.revise({ batchId, sessionId, version: 1, feedback: '补充回归条件' })
  await setImmediate()
  assert.equal(research.status({ batchId })[0].drafts.length, 2)
  const [draft, revision] = prompts.map(prompt => prompt.content[0].text)
  assert.ok(draft.startsWith(researchSkill.content))
  assert.ok(draft.includes(planWritingInstructions))
  assert.ok(revision.startsWith('/' + researchSkill.name + '\n'))
  assert.ok(!revision.includes(planWritingInstructions))
  assert.match(revision, /补充回归条件/)
  assert.deepEqual(events, [[sessionId, 'create'], [sessionId, 'prompt'], [sessionId, 'prompt']])
  for (const prompt of prompts) {
    assert.equal(prompt.sessionId, sessionId)
    const text = prompt.content[0].text
    assert.match(text, /不要调用任何写文件或修改仓库的工具/)
    assert.doesNotMatch(text, /规则优先级|编辑流程/)
  }
})

test('同一计划并发执行只派发一次，宿主重启后复用会话', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'dy-yunxiao-workflow-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  let sessions = 0
  let prompts = 0
  const options = {
    home: join(cwd, 'state'), branchExists: async () => {},
    client: () => ({
      organization: 'org',
      get: async () => ({ id: 'issue', serialNumber: 'TASK-1', spaceId: 'project', description: '正文' }),
      attachments: async () => [], schedule: async () => {},
    }),
    host: {
      create: async () => { sessions += 1 },
      prompt: async () => { prompts += 1 },
    },
  }
  const workflow = createWorkflow(options)
  const input = await addPlannedIssue(workflow, cwd, { project: 'project', id: 'issue' })
  const prepare = async () => ({ cwd, version: 1, readDraft: () => '# 定稿' })
  await assert.rejects(workflow.executePlan(cwd, { ...input, id: 'unplanned' }, prepare), /不在当前交付计划/)
  await assert.rejects(workflow.executePlan(cwd, input, async () => ({
    cwd, version: 1, readDraft() { throw new Error('方案尚未定稿') },
  })), /尚未定稿/)
  assert.equal(sessions, 0)
  assert.equal(prompts, 0)
  const [one, two] = await Promise.all([workflow.executePlan(cwd, input, prepare), workflow.executePlan(cwd, input, prepare)])
  const afterRestart = await createWorkflow(options).executePlan(cwd, input, prepare)
  assert.equal(one.sessionId, two.sessionId)
  assert.equal(one.sessionId, afterRestart.sessionId)
  assert.equal(sessions, 1)
  assert.equal(prompts, 1)
})

for (const mode of ['技能可用', '技能不可用', '旧版待派发']) {
  test('首轮应答丢失后从计划按原定稿和原请求重试 · ' + mode, async t => {
    const available = mode !== '技能不可用'
    const cwd = await mkdtemp(join(tmpdir(), 'dy-launch-'))
    t.after(() => rm(cwd, { recursive: true, force: true }))
    const home = join(cwd, 'state')
    const key = { project: 'project', id: 'issue' }
    const worktree = join(cwd, 'worktree')
    await mkdir(worktree)
    const approved = '# 只处理门诊 /other-skill'
    let markdown = approved
    const prepare = async () => ({ cwd: worktree, version: 2, readDraft: () => markdown })
    let reads = 0
    let creates = 0
    let discoveries = 0
    const accepted = new Map()
    let issue = { ...key, serialNumber: 'REQ-12', categoryId: available ? 'Req' : 'Bug', description: '确认时的原文' }
    const api = { organization: 'org', get: async () => { reads++; return issue }, attachments: async () => [], schedule: async () => {} }
    const options = { home, branchExists: async () => {}, client: () => api, host: {
      create: async () => { creates++ },
      hasExecutionSkill: async () => { discoveries++; return available },
      prompt: async request => {
        if (accepted.has(request.requestId)) {
          assert.deepEqual(request, accepted.get(request.requestId))
          return
        }
        accepted.set(request.requestId, request)
        throw new Error('接收后应答丢失')
      },
    } }
    const input = await addPlannedIssue(createWorkflow(options), cwd, key)
    await assert.rejects(createWorkflow(options).executePlan(cwd, input, prepare), /应答丢失/)
    markdown = '# 未定稿的修订'
    issue = { ...issue, description: '云效已修改', categoryId: 'Task' }
    const workflow = createWorkflow(options)
    const attempt = [...accepted.values()][0]
    const { sessionId } = attempt
    const manifest = join(worktree, '.dsh', 'yunxiao', digest(sessionId), 'task.json')
    const taskPrompt = '按定稿执行云效议题 REQ-12。任务清单：' + manifest
    const expected = available ? '/' + executionSkill.name + '\n' + taskPrompt : taskPrompt + '\n读取清单中的 instructions 字段并执行。'
    assert.equal(attempt.text, expected)
    if (mode === '旧版待派发') {
      const path = join(home, 'work-' + digest('org', key.project, key.id, await realpath(cwd)) + '.json')
      const { requestText, ...binding } = JSON.parse(await readFile(path, 'utf8'))
      assert.equal(requestText, attempt.text)
      await writeFile(path, JSON.stringify({ ...binding, firstPrompt: expected }))
      attempt.text += '\n\n' + legacyExecutionDocumentInstructions()
      assert.match(attempt.text, /研发工作台文档[\s\S]*规则优先级/)
    }
    await assert.rejects(workflow.executePlan(cwd, input, async () => ({ ...await prepare(), version: 3 })), /原定稿版本/)
    assert.equal((await workflow.executePlan(cwd, input, prepare)).sessionId, sessionId)
    assert.equal((await workflow.bindingFor(cwd, key)).dispatched, true)
    assert.equal(reads, 2)
    assert.equal(creates, 1)
    assert.equal(discoveries, 1)
    assert.equal(accepted.size, 1)
    assert.doesNotMatch(attempt.text, /other-skill/)
    const task = JSON.parse(await readFile(manifest, 'utf8'))
    assert.equal(task.instructions, available ? undefined : executionSkill.content)
    assert.match(task.instructions ?? executionSkill.content, /用户要求提交.*议题编号/)
    assert.equal(task.reference, 'REQ-12')
    assert.equal(task.planVersion, 2)
    assert.equal(await readFile(task.plan, 'utf8'), approved)
    const source = await readFile(task.source, 'utf8')
    assert.match(source, /确认时的原文/)
    assert.doesNotMatch(source, /云效已修改/)
    await writeFile(task.discussion, '## 修改方案汇总\n实现说明\n## 影响范围与测试\n验证结果')
    assert.equal((await workflow.preview(cwd, key)).sections.length, 1)
    const run = createHandler({ home, clientFactory: () => api, publication: workflow })
    const result = await run({ rawInput: 'preview', agent: { session: { id: sessionId, header: { cwd: worktree } } } })
    assert.match(result.text, /验证结果/)
    assert.doesNotMatch(result.text, /实现说明/)
  })
}

test('旧命令绑定仍可预览已有交付稿', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'dy-legacy-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const home = join(cwd, 'state')
  const sessionId = 'old-session'
  const folder = join(cwd, '.dsh', 'yunxiao', digest(sessionId))
  await mkdir(home)
  await mkdir(folder, { recursive: true })
  await writeFile(join(home, digest(sessionId) + '.json'), JSON.stringify({ id: 'issue', reference: 'REQ-2', organization: 'org' }))
  await writeFile(join(folder, 'discussion.md'), '## 修改方案汇总\n已有改动\n## 影响范围与测试\n已有结果')
  const api = { organization: 'org', find: async () => ({ id: 'issue', spaceId: 'project' }) }
  const run = createHandler({ home, clientFactory: () => api })
  const result = await run({ rawInput: 'preview', agent: { session: { id: sessionId, header: { cwd } } } })
  assert.equal(result.kind, 'success', result.text)
  assert.doesNotMatch(result.text, /已有改动/)
})

test('批量排期保留已成功项，重试只处理失败议题', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'dy-yunxiao-workflow-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const attempts = []
  const workflow = createWorkflow({
    home: join(cwd, 'state'), branchExists: async () => {},
    host: { create: async () => {}, prompt: async () => {} },
    client: () => ({
      organization: 'org',
      get: async id => ({
        id, space: { id: 'project' }, status: { id: 'confirmed', name: '已确认' },
      }),
      schedule: async ({ id }) => {
        if (id === 'one' && !attempts.includes(id)) {
          attempts.push(id)
          throw new Error('云效暂时不可用')
        }
        attempts.push(id)
      },
    }),
  })
  const plan = await workflow.createPlan(cwd, 'project', { name: '本周交付', branch: 'feature/one', end: '2026-11-20' })
  const first = await workflow.addToPlan(cwd, 'project', plan.id, ['one','two'])
  assert.deepEqual(first.map(row => row.result), ['失败', '成功'])
  assert.equal(first[0].retryable, true)
  const again = await workflow.addToPlan(cwd, 'project', plan.id, ['one','two'])
  assert.deepEqual(again.map(row => row.result), ['成功', '已加入'])
  assert.deepEqual(attempts, ['one','two','one'])
})

for (const scenario of ['无需完成时间', '完成时间必填且为空', '保留已有完成时间', '待开发补齐空值', '保留待开发已有排期及负责人']) {
  test('议题加入计划前写入排期字段并回查状态 · ' + scenario, async t => {
    const cwd = await mkdtemp(join(tmpdir(), 'dy-yunxiao-workflow-'))
    t.after(() => rm(cwd, { recursive: true, force: true }))
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-19T14:00:00+08:00') })
    const requiresEnd = scenario.startsWith('完成时间') || scenario === '保留已有完成时间'
    const keepReady = scenario === '保留待开发已有排期及负责人'
    const alreadyReady = keepReady || scenario === '待开发补齐空值'
    const existingEnd = scenario === '保留已有完成时间' || keepReady ? '2026-11-23 00:00:00' : ''
    const ready = { id: 'ready', name: '待开发' }
    const confirmed = { id: 'confirmed', name: '已确认' }
    const startValue = { value: keepReady ? '2026-11-18 00:00:00' : '' }
    const endValue = { value: existingEnd }
    const state = {
      id: 'issue', spaceId: 'project', workitemTypeId: 'bug',
      status: alreadyReady ? ready : confirmed, assignedTo: keepReady ? { id: 'existing-owner' } : null,
      customFieldValues: [
        { fieldId: 'planStart', fieldName: '计划开始时间', values: [startValue] },
        { fieldId: 'planEnd', fieldName: '计划完成时间', values: [endValue] },
      ],
    }
    const writes = []
    let verified = false
    let failClear = true
    const api = createClient({
      organization: 'org', token: 'mock-token',
      fetcher: async (url, { method, body }) => {
        const path = new URL(url).pathname
        if (path.endsWith('/platform/user')) return Response.json({ id: 'user' })
        if (path.endsWith('/projects/project/workitemTypes/bug/fields')) {
          return Response.json([
            { id: 'planStart', name: '计划开始时间' },
            { id: 'planEnd', name: '计划完成时间' },
          ])
        }
        if (path.endsWith('/workitems/issue/workflow')) {
          return Response.json({ statuses: [state.status === ready ? confirmed : ready] })
        }
        assert.ok(path.endsWith('/workitems/issue'))
        if (method === 'GET') {
          verified ||= state.status === ready
          return Response.json(state)
        }
        assert.equal(method, 'PUT')
        const update = JSON.parse(body)
        if (update.status === ready.id && (startValue.value !== '2026-11-19 00:00:00' || state.assignedTo?.id !== 'user')) {
          return new Response(null, { status: 400 })
        }
        writes.push(update)
        if (update.status === ready.id && requiresEnd && !endValue.value) {
          return Response.json({ errorMessage: '计划完成时间必填' }, { status: 400 })
        }
        if (update.planStart === '' && failClear) {
          failClear = false
          return new Response(null, { status: 503 })
        }
        if ('planStart' in update) startValue.value = update.planStart
        if (update.planEnd) endValue.value = update.planEnd
        if (update.assignedTo) state.assignedTo = { id: update.assignedTo }
        if (update.status === ready.id) state.status = ready
        if (update.status === confirmed.id) state.status = confirmed
        return new Response(null, { status: 204 })
      },
    })
    const workflow = createWorkflow({ home: join(cwd, 'state'), branchExists: async () => {}, host: {}, client: () => api })
    const plan = await workflow.createPlan(cwd, 'project', { name: '测试', branch: 'feature/test', end: '2026-11-20' })
    const [result] = await workflow.addToPlan(cwd, 'project', plan.id, ['issue'])
    assert.equal(result.result, '成功', result.error)
    assert.deepEqual(writes, keepReady ? [] : [
      { planStart: '2026-11-19 00:00:00' }, { assignedTo: 'user' }, ...(alreadyReady ? [] : [{ status: 'ready' }]),
      ...(requiresEnd && !existingEnd ? [{ planEnd: '2026-11-20 00:00:00' }, { status: 'ready' }] : []),
    ])
    assert.equal(verified, true)
    assert.deepEqual((await workflow.plans(cwd, 'project'))[0].members, ['issue'])
    const savedEnd = endValue.value
    writes.length = 0
    await assert.rejects(workflow.removeFromPlan(cwd, 'project', plan.id, 'issue'), /清空计划开始时间失败/)
    assert.deepEqual((await workflow.plans(cwd, 'project'))[0].members, ['issue'])
    await workflow.removeFromPlan(cwd, 'project', plan.id, 'issue')
    await workflow.removeFromPlan(cwd, 'project', plan.id, 'issue')
    assert.deepEqual(writes, [{ status: 'confirmed' }, { planStart: '' }, { planStart: '' }])
    assert.deepEqual((await workflow.plans(cwd, 'project'))[0].members, [])
    assert.equal(startValue.value, '')
    assert.equal(endValue.value, savedEnd)
    assert.equal(state.assignedTo.id, keepReady ? 'existing-owner' : 'user')
  })
}

test('状态回查超时，重启后回查成功且不重复写入', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'dy-yunxiao-workflow-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  let writes = 0
  let reads = 0
  const status = { id: 'doing', name: '开发中' }
  const options = {
    home: join(cwd, 'state'),
    host: { create: async () => {}, prompt: async () => {} },
    client: () => ({
      organization: 'org',
      get: async id => {
        reads++
        if (reads === 2) throw new Error('回查超时')
        return { id, status: writes ? status : { id: 'todo', name: '待开发' } }
      },
      statuses: async () => [status],
      setStatus: async () => { writes++ },
    }),
  }
  const key = { project: 'project', id: 'issue' }
  assert.equal((await createWorkflow(options).transition(key, 'todo', 'doing')).pending, true)
  assert.equal((await createWorkflow(options).checkTransition(key)).status.name, '开发中')
  assert.equal(writes, 1)
})

test('旧稿只预览测试，发布失败重启后保留已确认测试正文', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'dy-yunxiao-workflow-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const comments = []
  let attempts = 0
  const options = {
    home: join(cwd, 'state'), branchExists: async () => {},
    host: { create: async () => {}, prompt: async () => {} },
    client: () => ({
      organization: 'org',
      get: async id => ({ id, description: '正文' }),
      attachments: async () => [], schedule: async () => {},
      comments: async () => comments,
      comment: async (_, content) => {
        if (++attempts === 1) throw new YunxiaoHttpError(422, '模拟发布失败')
        const id = 'comment-' + attempts
        comments.push({ id, content })
        return id
      },
    }),
  }
  const key = { project: 'project', id: 'issue' }
  let workflow = createWorkflow(options)
  const input = await addPlannedIssue(workflow, cwd, key)
  const { sessionId } = await workflow.executePlan(cwd, input, async () => ({ cwd, version: 1, readDraft: () => '# 定稿' }))
  await writeFile(join(cwd, '.dsh', 'yunxiao', digest(sessionId), 'discussion.md'),
    '## 修改方案汇总\n\n原开发文案\n\n## 影响范围与测试\n\n测试文案')
  const draft = await workflow.preview(cwd, key)
  assert.deepEqual(draft.sections, ['## 影响范围与测试\n\n测试文案'])
  const edits = ['确认后的测试文案']
  const first = await workflow.publish(cwd, key, draft.code, edits)
  assert.equal(first.receipts[0], null)
  assert.equal(first.error, '模拟发布失败')
  workflow = createWorkflow(options)
  const saved = await workflow.preview(cwd, key)
  assert.deepEqual(saved.sections, edits)
  const retry = await workflow.publish(cwd, key, saved.code, saved.sections)
  assert.deepEqual(retry.receipts.map(receipt => receipt.id), ['comment-2'])
  assert.equal(comments.length, 1)
  assert.match(comments[0].content, /确认后的测试文案/)
})

test('同计划按议题关联实际提交，回执存盘失败后重试只补归档，重新加入另建执行会话', async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'dy-execution-archive-')))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  git('init', '--initial-branch=feature/test')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.invalid')
  git('commit', '--allow-empty', '-m', 'initial')
  const commits = {}
  for (const id of ['APP-1', 'APP-2']) {
    await writeFile(join(cwd, id + '.txt'), id)
    git('add', id + '.txt')
    git('commit', '-m', id + ' 交付')
    commits[id] = git('rev-parse', 'HEAD')
  }
  let posts = 0
  const options = { home: join(cwd, 'state'), host: { create: async () => {}, prompt: async () => {} },
    client: () => ({ organization: 'org', get: async id => ({ id, serialNumber: id, description: '正文' }),
      attachments: async () => [], schedule: async () => {}, unschedule: async () => {}, comments: async () => [],
      comment: async () => { posts++; return 'comment-1' } }) }
  const workflow = createWorkflow(options)
  const plan = await workflow.createPlan(cwd, 'project', { name: '计划', branch: 'feature/test', end: '2026-11-25' })
  const inputs = ['APP-1', 'APP-2'].map(id => ({ project: 'project', planId: plan.id, id }))
  await workflow.addToPlan(cwd, 'project', plan.id, inputs.map(input => input.id), '首次排期', true)
  const prepare = async () => ({ cwd, version: 1, readDraft: () => '# 已批准' })
  const bindings = await Promise.all(inputs.map(input => workflow.executePlan(cwd, input, prepare)))
  for (const binding of bindings) {
    const folder = join(cwd, '.dsh', 'yunxiao', digest(binding.sessionId))
    await writeFile(join(folder, 'execution.md'), templateFor('execution').sections.map(title => `## ${title}\n\n已核对`).join('\n\n'))
    await writeFile(join(folder, 'discussion.md'), '## 影响范围与测试\n\n模拟通过')
  }
  await assert.rejects(workflow.archiveExecution(cwd, { ...inputs[0], commit: commits['APP-2'] }), /缺少当前议题编号/)
  for (const input of inputs) {
    const results = await Promise.all([workflow.archiveExecution(cwd, { ...input, commit: commits[input.id] }),
      workflow.archiveExecution(cwd, { ...input, commit: commits[input.id] })])
    assert.equal(results[0].change.file, results[1].change.file)
  }
  const scope = archiveScope(cwd, 'org', 'project', plan.id)
  const index = await archiveIndex(scope)
  const rows = index.plans[0].issues
  for (const row of rows) {
    assert.equal(row.documents.find(document => document.type === 'change').commitSha, commits[row.id])
    assert.equal(row.documents.filter(document => document.type === 'change').length, 1)
  }
  const manifest = join(cwd, index.folder, ...rows.find(row => row.id === 'APP-1').folder.split('/'), 'issue.json')
  await rename(manifest, manifest + '.original')
  await mkdir(manifest)
  const draft = await workflow.preview(cwd, inputs[0])
  const published = await workflow.publish(cwd, inputs[0], draft.code, draft.sections)
  assert.equal(published.archivePending, true)
  assert.match(published.error, /档案文件冲突/)
  assert.equal(posts, 1)
  await rmdir(manifest)
  await rename(manifest + '.original', manifest)
  const restarted = createWorkflow(options)
  assert.equal((await restarted.publish(cwd, inputs[0], draft.code, draft.sections)).archivePending, false)
  assert.equal(posts, 1)
  const publication = (await archiveIndex(scope)).plans[0].issues.find(row => row.id === 'APP-1')
    .documents.find(document => document.type === 'publication')
  assert.ok(publication)
  await workflow.removeFromPlan(cwd, 'project', plan.id, 'APP-1', '重新排期')
  await workflow.addToPlan(cwd, 'project', plan.id, ['APP-1'], '二次加入')
  const again = await workflow.executePlan(cwd, inputs[0], prepare)
  assert.notEqual(again.sessionId, bindings[0].sessionId)
  const history = (await archiveIndex(scope)).plans[0].history
  assert.deepEqual(history.initialMembers, ['APP-1', 'APP-2'])
  assert.deepEqual(history.changes.filter(change => change.issueId === 'APP-1').map(change => change.kind), ['initial', 'removed', 'added'])
})
