import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { YunxiaoHttpError } from '../src/yunxiao-client.mjs'
import { digest } from '../src/yunxiao.mjs'
import { createWorkflow } from '../src/workflow.ts'

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
