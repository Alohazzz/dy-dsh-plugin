import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { YunxiaoHttpError } from '../src/yunxiao-client.mjs'
import { createHandler, digest } from '../src/yunxiao.mjs'
import { createWorkflow, executionSkill } from '../src/workflow.ts'

test('同一工作区并发开工只派发一次，宿主重启后复用会话', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'dy-yunxiao-workflow-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  let sessions = 0
  let prompts = 0
  const options = {
    home: join(cwd, 'state'),
    client: () => ({
      organization: 'org',
      get: async () => ({ id: 'issue', serialNumber: 'TASK-1', spaceId: 'project', description: '正文' }),
      attachments: async () => [],
    }),
    host: {
      create: async () => { sessions += 1 },
      prompt: async () => { prompts += 1 },
    },
  }
  const input = { cwd, project: 'project', id: 'issue' }
  const workflow = createWorkflow(options)
  const [one, two] = await Promise.all([workflow.start(input), workflow.start(input)])
  const afterRestart = await createWorkflow(options).start(input)
  assert.equal(one.sessionId, two.sessionId)
  assert.equal(one.sessionId, afterRestart.sessionId)
  assert.equal(sessions, 1)
  assert.equal(prompts, 1)
})

for (const available of [true, false]) {
  test(`首轮应答丢失后用原材料和原请求从命令重试，执行技能可用=${available}`, async t => {
    const cwd = await mkdtemp(join(tmpdir(), 'dy-launch-'))
    t.after(() => rm(cwd, { recursive: true, force: true }))
    const home = join(cwd, 'state')
    const key = { project: 'project', id: 'issue' }
    const notes = '只处理门诊 /other-skill'
    let reads = 0
    let creates = 0
    let discoveries = 0
    const accepted = new Map()
    let issue = { ...key, serialNumber: 'REQ-12', categoryId: available ? 'Req' : 'Bug', description: '确认时的原文' }
    const api = { organization: 'org', get: async () => { reads++; return issue }, attachments: async () => [] }
    const options = { home, client: () => api, host: {
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
    await assert.rejects(createWorkflow(options).start({ ...key, cwd, notes, clarify: true }), /应答丢失/)
    issue = { ...issue, description: '云效已修改', categoryId: 'Task' }
    const workflow = createWorkflow(options)
    const { sessionId, text } = [...accepted.values()][0]
    const run = createHandler({ home, clientFactory: () => api, startBound: workflow.start })
    const result = await run({ rawInput: 'start REQ-12', agent: { status: 'idle', session: { id: sessionId, header: { cwd } } } })
    assert.equal(result.kind, 'success', result.text)
    assert.equal((await workflow.bindingFor(cwd, key)).dispatched, true)
    assert.equal(reads, 1)
    assert.equal(creates, 1)
    assert.equal(discoveries, 1)
    assert.equal(accepted.size, 1)
    const manifest = join(cwd, '.dsh', 'yunxiao', digest(sessionId), 'task.json')
    assert.ok(text.includes(manifest))
    assert.equal(text.startsWith('/' + executionSkill.name + '\n'), available)
    assert.doesNotMatch(text, /other-skill/)
    assert.match(available ? executionSkill.content : text, /用户要求提交.*议题编号/)
    const task = JSON.parse(await readFile(manifest, 'utf8'))
    assert.equal(task.notes, notes)
    assert.equal(task.reference, 'REQ-12')
    assert.equal(task.mode, available ? '先澄清' : '缺陷诊断')
    const source = await readFile(task.source, 'utf8')
    assert.match(source, /确认时的原文/)
    assert.doesNotMatch(source, /云效已修改/)
    await writeFile(task.discussion, '## 修改方案汇总\n实现说明\n## 影响范围与测试\n验证结果')
    assert.equal((await workflow.preview(cwd, key)).sections.length, 2)
  })
}

test('旧命令绑定可返回原会话并预览已有交付稿', async t => {
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
  const workflow = createWorkflow({ home, host: {}, client: () => api })
  const run = createHandler({ home, startBound: workflow.start, clientFactory: () => api })
  const result = await run({ rawInput: 'start REQ-2', agent: { session: { id: sessionId, header: { cwd } } } })
  assert.equal(result.kind, 'success', result.text)
  assert.match(result.text, /old-session/)
  assert.match((await workflow.preview(cwd, { id: 'issue', project: 'project' })).sections[0], /已有改动/)
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

test('评论预览编辑后第二条失败，重启后只补发未完成评论', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'dy-yunxiao-workflow-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const comments = []
  let attempts = 0
  const options = {
    home: join(cwd, 'state'),
    host: { create: async () => {}, prompt: async () => {} },
    client: () => ({
      organization: 'org',
      get: async id => ({ id, description: '正文' }),
      attachments: async () => [],
      comments: async () => comments,
      comment: async (_, content) => {
        if (++attempts === 2) throw new YunxiaoHttpError(422, '模拟发布失败')
        const id = 'comment-' + attempts
        comments.push({ id, content })
        return id
      },
    }),
  }
  const key = { project: 'project', id: 'issue' }
  let workflow = createWorkflow(options)
  const { sessionId } = await workflow.start({ cwd, ...key })
  await writeFile(join(cwd, '.dsh', 'yunxiao', digest(sessionId), 'discussion.md'),
    '## 修改方案汇总\n\n原开发文案\n\n## 影响范围与测试\n\n测试文案')
  const draft = await workflow.preview(cwd, key)
  const edits = ['确认后的开发文案', draft.sections[1]]
  const first = await workflow.publish(cwd, key, draft.code, edits)
  assert.equal(first.receipts[0].id, 'comment-1')
  assert.equal(first.receipts[1], null)
  assert.equal(first.error, '模拟发布失败')
  workflow = createWorkflow(options)
  const saved = await workflow.preview(cwd, key)
  assert.deepEqual(saved.sections, edits)
  const retry = await workflow.publish(cwd, key, saved.code, saved.sections)
  assert.deepEqual(retry.receipts.map(receipt => receipt.id), ['comment-1', 'comment-3'])
  assert.equal(comments.length, 2)
  assert.match(comments[0].content, /确认后的开发文案/)
})
