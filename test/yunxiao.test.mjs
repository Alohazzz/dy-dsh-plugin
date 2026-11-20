import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createClient } from '../src/yunxiao-client.mjs'
import { createHandler, sessionPaths } from '../src/yunxiao.mjs'

test('云效编号查询、会话恢复、评论补发与状态确认', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'dy-yunxiao-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const home = join(cwd, 'state')
  const item = {
    id: 'id-abc', serialNumber: 'PROJ-42', subject: '任务', description: '正文',
    status: { id: 'todo', displayName: '待处理' },
  }
  const done = { id: 'done', displayName: '已完成' }
  const comments = []
  let posts = 0
  let puts = 0
  const clientFactory = () => createClient({
    token: 'mock-token', organization: 'org', project: 'project',
    fetcher: async (url, options) => {
      assert.equal(options.headers['x-yunxiao-token'], 'mock-token')
      assert.equal(new URL(url).hostname, 'openapi-rdc.aliyuncs.com')
      const body = options.body && JSON.parse(options.body)
      if (url.endsWith('workitems:search')) {
        assert.equal(body.spaceId, 'project')
        assert.deepEqual(JSON.parse(body.conditions).conditionGroups[0][0].value, ['PROJ-42'])
        return Response.json([{ id: 'wrong', serialNumber: 'PROJ-420' }, item])
      }
      if (url.endsWith('/attachments')) {
        return Response.json([{ fileId: 'file', fileName: 'a.png', url: 'https://example.com/file' }])
      }
      if (url.endsWith('/comments')) {
        if (options.method === 'GET') return Response.json(comments)
        assert.equal(body.formatType, 'MARKDOWN')
        posts += 1
        const comment = { id: String(posts), content: body.content }
        comments.push(comment)
        if (posts === 1) throw new Error('响应在远端写入后丢失')
        return Response.json({ id: comment.id })
      }
      if (url.endsWith('/workflow')) return Response.json({ statuses: [item.status, done] })
      assert.ok(url.endsWith('/workitems/id-abc'))
      if (options.method === 'PUT') {
        assert.deepEqual(body, { status: 'done' })
        puts += 1
        item.status = done
        return new Response(null, { status: 204 })
      }
      return Response.json(item)
    },
  })
  const prompts = []
  const agent = {
    status: 'idle', session: { id: 'session-1', header: { cwd } },
    followup: message => prompts.push(message),
  }
  let handler = createHandler({ clientFactory, home })
  const run = rawInput => handler({ agent, rawInput })

  const read = await run('read PROJ-42')
  assert.equal(read.kind, 'success', read.text)
  assert.match(read.text, /正文[\s\S]*a\.png/)
  assert.equal((await run('start PROJ-42')).kind, 'error')
  assert.equal(prompts.length, 0)
  const { folder, binding, discussion } = sessionPaths(agent, home)
  await mkdir(home)
  await mkdir(folder, { recursive: true })
  await writeFile(binding, JSON.stringify({ organization: 'org', id: item.id, reference: item.serialNumber }))
  const work = '## 修改方案汇总\n\n修改说明\n\n## 影响范围与测试（测试向）\n\n测试说明\n\n## 价值评分\n\n暂不回写'
  await writeFile(discussion, work)
  const preview = await run('preview')
  assert.equal(preview.kind, 'success', preview.text)
  assert.doesNotMatch(preview.text, /价值评分|修改方案汇总/)
  const code = preview.text.split('/yunxiao publish ')[1]
  await writeFile(discussion, work.replace('测试说明', '修改了预览内容'))
  assert.equal((await run(`publish ${code}`)).kind, 'error')
  assert.equal(posts, 0)
  await writeFile(discussion, work)
  assert.equal((await run(`publish ${code}`)).kind, 'error')
  assert.equal(posts, 1)
  handler = createHandler({ clientFactory, home })
  assert.equal((await run(`publish ${code}`)).kind, 'success')
  assert.equal((await run(`publish ${code}`)).kind, 'success')
  assert.equal(posts, 1)

  await writeFile(discussion, work.replace('测试说明', '追加测试说明'))
  const newCode = (await run('preview')).text.split('/yunxiao publish ')[1]
  const concurrentRun = createHandler({ clientFactory, home })
  await Promise.all([
    run(`publish ${newCode}`),
    concurrentRun({ agent, rawInput: `publish ${newCode}` }),
  ])
  assert.equal((await run(`publish ${newCode}`)).kind, 'success')
  assert.equal(posts, 2)

  assert.match((await run('statuses')).text, /待处理/)
  const transition = await run('transition done')
  const statusConfirmation = transition.text.split('/yunxiao transition done ')[1]
  assert.ok(statusConfirmation)
  assert.equal(puts, 0)
  assert.equal((await run('transition done wrong')).kind, 'error')
  assert.equal((await run(`transition done ${statusConfirmation}`)).kind, 'success')
  assert.equal((await run(`transition done ${statusConfirmation}`)).kind, 'success')
  assert.equal(puts, 1)
})
