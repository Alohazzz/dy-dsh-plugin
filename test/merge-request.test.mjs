import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deliveryOptions, git, mrRepos, mrPreview, submitMr } from '../src/merge-request.ts'
import { codeupApi } from '../src/codeup.mjs'
import { apply } from '../src/host.ts'
import { createMrReviews, fetchReviewHistory } from '../src/mr-review.ts'
import { availableMrActions, createMrActions } from '../src/mr-actions.ts'
import { createClient } from '../src/yunxiao-client.mjs'
import { digest } from '../src/yunxiao.mjs'
import { createWorkflow } from '../src/workflow.ts'

test('snapshot pull returns before network work ends and can be cancelled from a later request', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pull-task-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const reference = { repositoryId: 2, localId: 5 }
  const root = join(home, 'mr-reviews', digest('org', 2, 5))
  const source = 'a'.repeat(40)
  const target = 'b'.repeat(40)
  const snapshot = { id: digest(source, target, 1), source, target, version: 1, directory: join(root, 'patch-existing', 'checkout') }
  await mkdir(snapshot.directory, { recursive: true })
  await writeFile(join(root, 'snapshot.json'), JSON.stringify(snapshot))
  let calls = 0
  let release
  function reviewTarget(_reference, signal) {
    calls++
    return new Promise((resolve, reject) => {
      release = () => resolve({ source: { sha: source, version: 1 }, target: { sha: target } })
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }
  const reviews = createMrReviews(home, async () => ({ organization: 'org', codeup: { reviewTarget } }), () => [], {}, {})
  const first = await reviews.pull(reference)
  assert.deepEqual(await reviews.pull(reference), first)
  assert.deepEqual((await reviews.status(reference)).pull, { ...first, status: 'running' })
  await waitFor(() => calls === 1)
  await reviews.cancelPull({ ...reference, ...first })
  await waitFor(async () => (await reviews.status(reference)).pull?.status === 'cancelled')
  assert.deepEqual((await reviews.status(reference)).snapshot, snapshot)

  const second = await reviews.pull(reference)
  assert.notEqual(second.id, first.id)
  await reviews.cancelPull({ ...reference, ...first })
  assert.deepEqual((await reviews.status(reference)).pull, { ...second, status: 'running' })
  await waitFor(() => calls === 2)
  release()
  await waitFor(async () => !(await reviews.status(reference)).pull)
  assert.deepEqual((await reviews.status(reference)).snapshot, snapshot)
  assert.equal(calls, 2)
})

test('cancelling a Git fetch closes the remote helper connection', { timeout: 15000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cancel-git-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await git(home, ['init', '--quiet'], false, true)
  const received = Promise.withResolvers()
  const closed = Promise.withResolvers()
  const server = createServer(request => {
    request.socket.once('close', closed.resolve)
    received.resolve()
  })
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const controller = new AbortController()
  const pull = git(home, ['-c', 'http.proxy=', 'fetch', '--', 'http://127.0.0.1:' + server.address().port + '/repo', 'HEAD'],
    false, true, controller.signal)
  await Promise.race([received.promise, pull])
  controller.abort()
  await assert.rejects(pull, { name: 'AbortError' })
  await closed.promise
})

test('MR pull reuses matching local objects and checks out long paths into an independent snapshot', { timeout: 30000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-local-pull-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const reference = { repositoryId: 2, localId: 5 }
  const root = join(home, 'mr-reviews', digest('org', 2, 5))
  const previous = join(root, 'patch-previous', 'checkout')
  const relativeDirectory = join('long'.repeat(20), 'name'.repeat(20))
  const relativeFile = join(relativeDirectory, 'source.txt')
  await mkdir(join(previous, relativeDirectory), { recursive: true })
  const run = (...args) => git(previous, ['-c', 'core.longpaths=true', '-c', 'user.name=Test',
    '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], false, true)
  await run('init', '--template=', '--quiet')
  await run('commit', '--allow-empty', '-qm', 'target')
  const target = await run('rev-parse', 'HEAD')
  await writeFile(join(previous, relativeFile), 'long path')
  await run('add', '--', relativeFile)
  await run('commit', '-qm', 'source')
  const source = await run('rev-parse', 'HEAD')
  await run('update-ref', 'refs/dy-review/target', target)
  await run('update-ref', 'refs/dy-review/source', source)

  const reviewTarget = async () => ({ remote: 'file:///unavailable-mr-test',
    source: { sha: source, ref: source, version: 1 }, target: { sha: target, ref: target } })
  const reviews = createMrReviews(home, async () => ({ organization: 'org', codeup: { reviewTarget } }), () => [], {}, {})
  await reviews.pull(reference)
  await waitFor(async () => (await reviews.status(reference)).pull?.status !== 'running' &&
    (await reviews.status(reference)).pull?.status !== 'saving', 15000)
  const { pull, snapshot } = await reviews.status(reference)
  assert.equal(pull, undefined, pull?.error)
  assert.equal(snapshot.source, source)
  assert.equal(snapshot.target, target)
  assert.notEqual(snapshot.directory, previous)
  assert.equal(await readFile(join(snapshot.directory, relativeFile), 'utf8'), 'long path')
  await assert.rejects(readFile(join(snapshot.directory, '.git', 'objects', 'info', 'alternates')), { code: 'ENOENT' })
})

async function waitFor(check, timeout = 2000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('Snapshot task did not reach the expected state')
}

test('a cold MR pull deepens past a misleading merge base and leaves older history behind', { timeout: 30000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-shallow-review-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const remote = join(home, 'remote')
  const checkout = join(home, 'checkout')
  await mkdir(remote)
  await mkdir(checkout)
  const run = (dir, ...args) => git(dir, args, false, true)
  await run(remote, 'init', '--quiet')
  await run(checkout, 'init', '--quiet')

  const commits = []
  function commit(ref, mark, parent, path, merged) {
    commits.push('commit refs/heads/' + ref, 'mark :' + mark,
      'committer Test <test@example.invalid> ' + (1700000000 + mark) + ' +0000', 'data 1', 'x')
    if (parent) commits.push('from :' + parent)
    if (merged) commits.push('merge :' + merged)
    commits.push('M 100644 inline ' + path, 'data 1', 'x', '')
  }
  for (let mark = 1; mark <= 16; mark++) commit('main', mark, mark - 1, 'old-' + mark)
  commit('main', 17, 16, 'shared')
  commit('source', 18, 17, 'source-a')
  commit('source', 19, 18, 'source-b')
  commit('source', 20, 19, 'source-c', 16)
  commit('target', 21, 17, 'target-a')
  commit('target', 22, 21, 'target-b')
  commit('target', 23, 22, 'target-c', 16)
  execFileSync('git', ['fast-import', '--quiet'], { cwd: remote, input: commits.join('\n') + '\n', windowsHide: true })

  const source = await run(remote, 'rev-parse', 'refs/heads/source')
  const target = await run(remote, 'rev-parse', 'refs/heads/target')
  const base = await run(remote, 'merge-base', target, source)
  const oldest = await run(remote, 'rev-list', '--max-parents=0', 'refs/heads/main')
  const depths = []
  const signal = new AbortController().signal
  await fetchReviewHistory(checkout, target, source, async depth => {
    depths.push(depth)
    await run(checkout, '-c', 'protocol.file.allow=always', 'fetch', '--depth=' + depth, '--no-tags', '--', remote,
      source + ':refs/dy-review/source', target + ':refs/dy-review/target')
    if (depth === 2) {
      const shallowBase = await run(checkout, 'merge-base', target, source)
      assert.notEqual(shallowBase, base)
    }
  }, signal)
  assert.deepEqual(depths, [2, 8])
  assert.equal(await run(checkout, 'rev-parse', '--is-shallow-repository'), 'true')
  await assert.rejects(run(checkout, 'cat-file', '-e', oldest))
  assert.equal(await run(checkout, 'merge-base', target, source), base)
  for (const args of [
    ['diff', '--name-status', target + '...' + source],
    ['log', '--format=%H', target + '..' + source],
    ['merge-tree', '--write-tree', target, source],
  ]) {
    assert.equal(await run(checkout, ...args), await run(remote, ...args))
  }
})

test('Codeup review keeps pinned supplement refs and does not fetch refs from another MR', async () => {
  const id = 2
  const source = 'a'.repeat(40)
  const target = 'b'.repeat(40)
  const remote = 'https://codeup.aliyun.com/org/review.git'
  const calls = []
  const api = codeupApi(async (path, _signal, method) => {
    calls.push([path, method])
    if (path.endsWith('/repositories/2')) {
      return { id, pathWithNamespace: 'org/review', httpUrlToRepo: remote }
    }
    return [
      { relatedMergeItemType: 'MERGE_SOURCE', versionNo: 1, commitId: target, ref: 'refs/changes/5/1' },
      { relatedMergeItemType: 'MERGE_SOURCE', versionNo: 2, commitId: source, ref: 'refs/changes/9/2', patchSetBizId: 'source-patch' },
      { relatedMergeItemType: 'MERGE_TARGET', versionNo: 1, commitId: target, ref: 'refs/changes/5/target/1' },
    ]
  }, 'org')
  assert.deepEqual(await api.reviewTarget({ repositoryId: id, localId: 5 }), {
    remote, source: { sha: source, ref: source, version: 2, patchSetId: 'source-patch' },
    target: { sha: target, ref: 'refs/changes/5/target/1', version: 1, patchSetId: '' },
  })
  assert.deepEqual(calls, [
    ['/oapi/v1/codeup/organizations/org/repositories/2', undefined],
    ['/oapi/v1/codeup/organizations/org/repositories/2/changeRequests/5/diffs/patches', undefined],
  ])
})

test('review comment checks the report and patch, then recovers a lost reply without another post', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-review-comment-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const reference = { repositoryId: 2, localId: 5 }
  const root = join(home, 'mr-reviews', digest('org', 2, 5))
  const checkout = join(root, 'patch', 'checkout')
  await mkdir(checkout, { recursive: true })
  const source = 'a'.repeat(40)
  const target = 'b'.repeat(40)
  await writeFile(join(root, 'snapshot.json'), JSON.stringify({
    id: digest(source, target, 1), source, target, version: 1, directory: checkout,
  }))
  await writeFile(join(root, 'patch', 'review.json'), JSON.stringify({
    sessionId: 'review-1', startedAt: 1, markdown: '已保存的报告', status: 'complete',
  }))
  let version = 2
  let posts = 0
  let posted
  let visible = false
  const api = codeupApi(async (url, _signal, method, body) => {
    if (url.endsWith('/repositories/2')) return {
      id: 2, pathWithNamespace: 'org/review', httpUrlToRepo: 'https://codeup.aliyun.com/org/review.git',
    }
    if (url.endsWith('/diffs/patches')) return [
      { relatedMergeItemType: 'MERGE_SOURCE', versionNo: version, commitId: source, patchSetBizId: 'source-patch' },
      { relatedMergeItemType: 'MERGE_TARGET', versionNo: 1, commitId: target },
    ]
    assert.equal(method, 'POST')
    if (url.endsWith('/comments/list')) {
      assert.deepEqual(body, { comment_type: 'GLOBAL_COMMENT' })
      return visible ? [{ state: 'OPENED', comment_biz_id: 'comment-1', content: posted.content }] : []
    }
    assert.match(url, /repositories\/2\/changeRequests\/5\/comments$/)
    posts++
    posted = body
    throw new Error('response lost')
  }, 'org')
  const load = () => createMrReviews(home, async () => ({ organization: 'org', codeup: api }), () => [], {}, {})
  const review = load()
  const { token, footer } = (await review.status(reference)).comment
  const input = { ...reference, token, markdown: '  用户确认的改动  ' }
  await assert.rejects(review.publish({ ...input, token: 'expired' }), /报告已变化/)
  await assert.rejects(review.publish(input), /补丁集已变化/)
  assert.equal(posts, 0)
  version = 1
  await assert.rejects(review.publish(input), /尚未返回/)
  assert.deepEqual(posted, {
    comment_type: 'GLOBAL_COMMENT', content: '用户确认的改动\n\n' + footer,
    draft: false, patchset_biz_id: 'source-patch', resolved: false,
  })
  const restarted = load()
  assert.equal((await restarted.status(reference)).comment.pending, true)
  visible = true
  assert.deepEqual(await restarted.publish({ ...reference, token }), { id: 'comment-1' })
  assert.deepEqual(await restarted.publish(input), { id: 'comment-1' })
  assert.equal(posts, 1)
})

test('Codeup resolves full paths, matches same-repository open MRs and creates with numeric IDs', async () => {
  const calls = []
  const api = codeupApi(async (url, signal, method, body) => {
    calls.push({ url, method, body })
    if (method === 'POST') return { localId: 2, detailUrl: 'https://codeup.aliyun.com/r/2' }
    if (url.includes('?')) return [
      { sourceProjectId: 9, targetProjectId: 1, sourceBranch: 'fix', targetBranch: 'main', localId: 5 },
      { sourceProjectId: 1, targetProjectId: 1, sourceBranch: 'fix', targetBranch: 'main', localId: 2 },
    ]
    return { id: 1, defaultBranch: 'main' }
  }, 'org')
  const ssh = 'git@codeup.aliyun.com:org/group/HIS.git'
  assert.equal((await api.repository(ssh, 'https://codeup.aliyun.com/org/group/HIS.git')).id, 1)
  assert.match(calls[0].url, /repositories\/org%2Fgroup%2FHIS$/)
  await assert.rejects(api.repository(ssh, ssh.replace('HIS', 'Other')))
  assert.deepEqual((await api.openForSource(1, 'fix')).map(m => m.localId), [2])
  assert.equal((await api.create(1, 'fix', 'main', 'title', '')).localId, 2)
  assert.equal(calls.at(-1).body.targetProjectId, 1)
})

test('Codeup pending review uses the current reviewer and repository-local MR identity', async () => {
  const sample = { localId: 5, projectId: 2, state: 'UNDER_REVIEW', title: '修复缓存',
    reviewers: [{ userId: 'me', name: '当前用户', hasReviewed: false }] }
  const api = codeupApi(async url => {
    if (url.includes('?')) {
      const query = new URL(url, 'https://test.invalid').searchParams
      assert.equal(query.get('reviewerIds'), 'me')
      assert.equal(query.get('state'), 'opened')
      assert.equal(query.get('projectIds'), 'org/repo')
      return [
        sample, { ...sample, projectId: 3 },
        { ...sample, localId: 6, reviewers: [{ userId: 'me', hasReviewed: true }] },
        { ...sample, localId: 7, reviewers: [{ userId: 'other', hasReviewed: false }] },
        { ...sample, localId: 8, state: 'TO_BE_MERGED' },
      ]
    }
    assert.match(url, /repositories\/2\/changeRequests\/5$/)
    return { ...sample, state: undefined, status: 'MERGED' }
  }, 'org')
  const result = await api.list({ page: 1, reviewerId: 'me', repository: 'org/repo' })
  assert.deepEqual(result.rows.map(row => [row.repositoryId, row.localId]), [[2, 5], [3, 5], [2, 8]])
  assert.equal(result.more, false)
  assert.equal((await api.detail({ repositoryId: 2, localId: 5 })).status, 'MERGED')
  await assert.rejects(api.detail({ repositoryId: 2, localId: '../5' }), /无效/)
})

test('MR actions reject stale patches and reconcile writes by reading Codeup', async () => {
  const ref = { repositoryId: 2, localId: 5 }
  const mr = { projectId: 2, localId: 5, title: '术语缓存', sourceBranch: 'fix', targetBranch: 'release',
    status: 'UNDER_REVIEW', reviewers: [{ userId: 'me', hasReviewed: false }], supportMergeFastForwardOnly: true }
  let actor = 'me'
  let version = 1
  let failRead = false
  let rejectClose = false
  const written = []
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  const api = createClient({ token: 'fixture', organization: 'org', fetcher: async (url, init) => {
    const path = new URL(url).pathname
    if (path.endsWith('/platform/user')) return Response.json({ id: actor, name: actor })
    assert.match(path, /\/repositories\/2\/changeRequests\/5(?:\/|$)/)
    if (path.endsWith('/5')) {
      if (failRead) return new Response(null, { status: 503 })
      return Response.json(mr)
    }
    if (path.endsWith('/diffs/patches')) return Response.json([
      { relatedMergeItemType: 'MERGE_SOURCE', versionNo: version, commitId: String(version).repeat(40) },
      { relatedMergeItemType: 'MERGE_TARGET', versionNo: 1, commitId: 'a'.repeat(40) },
    ])
    assert.equal(init.method, 'POST')
    const action = path.split('/').at(-1)
    written.push([action, init.body && JSON.parse(init.body)])
    if (action === 'review') {
      started.resolve()
      await release.promise
      mr.reviewers[0].reviewOpinionStatus = 'PASS'
      mr.reviewers[0].hasReviewed = true
      mr.status = 'TO_BE_MERGED'
      throw new Error('lost reply')
    }
    if (action === 'merge') {
      mr.status = 'MERGED'
      mr.mergedRevision = 'b'.repeat(40)
      failRead = true
      return Response.json(mr)
    }
    assert.equal(action, 'close')
    if (rejectClose) return Response.json({ result: false })
    mr.status = 'CLOSED'
    return Response.json({ result: true })
  } })
  const actions = createMrActions(async () => api)
  const prepare = async action => ({ ...ref, action, ...await actions.preview({ ...ref, action }) })
  assert.deepEqual(availableMrActions(await api.codeup.detail(ref), 'outsider'), ['close'])
  const stale = await prepare('approve')
  version++
  await assert.rejects(actions.submit(stale), /补丁集已变化/)
  mr.status = 'TO_BE_MERGED'
  const approval = await prepare('approve')
  actor = 'other'
  await assert.rejects(actions.submit(approval), /账号或组织已变化/)
  actor = 'me'
  assert.deepEqual(written, [])
  const applying = actions.submit(approval)
  await started.promise
  await assert.rejects(actions.submit(approval), /正在处理/)
  release.resolve()
  assert.deepEqual(await applying, { confirmed: true })
  assert.deepEqual(await actions.submit(approval), { confirmed: true })
  assert.deepEqual(written, [['review', { reviewOpinion: 'PASS' }]])

  const merge = await prepare('merge')
  await assert.rejects(actions.submit(merge), /可用的合并方式/)
  assert.deepEqual(await actions.submit({ ...merge, mergeType: 'ff-only' }), { confirmed: false })
  assert.deepEqual(await actions.check(merge), { confirmed: false })
  failRead = false
  assert.deepEqual(await actions.check(merge), { confirmed: true })
  assert.deepEqual(written.at(-1), ['merge', { mergeType: 'ff-only', removeSourceBranch: false }])
  assert.equal(written.length, 2)
  await assert.rejects(prepare('close'), /状态或审核人已变化/)

  mr.status = 'UNDER_DEV'
  const close = await prepare('close')
  rejectClose = true
  await assert.rejects(actions.submit(close), /Codeup 拒绝/)
  rejectClose = false
  assert.deepEqual(await actions.submit(close), { confirmed: true })
  assert.deepEqual(written.at(-1), ['close', undefined])
  await assert.rejects(actions.check(merge), /MR 已关闭/)
})

test('plan association is verified by the host and survives a restart', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-plan-mr-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  })
  const workflow = createWorkflow({ home: join(home, 'dy-yunxiao'), branchExists: async () => {},
    client: () => ({ organization: 'org' }), host: {} })
  const plan = await workflow.createPlan(home, 'project', { name: '术语计划', branch: 'fix', end: '2026-11-24' })
  const scope = { project: 'project', workspaceId: 'w', planId: plan.id }
  await workflow.updateDelivery(home, 'project', 'org', plan.id, async () =>
    ({ key: '.', repositoryId: 2, path: 'org/term', target: 'release' }))
  const auth = { kind: 'api-key', key: 'fixture', env: { YUNXIAO_ORG_ID: 'org' } }
  const workspace = { id: 'w', path: home, title: '工作区' }
  const open = { projectId: 2, sourceProjectId: 2, targetProjectId: 2, sourceBranch: 'fix', targetBranch: 'release', localId: 5 }
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input)
    if (url.pathname.endsWith('/projects:search')) return Response.json([{ id: 'project', name: '术语' }])
    if (url.pathname.endsWith('/changeRequests')) return Response.json([
      open, { ...open, localId: 6, targetBranch: 'main' }, { ...open, localId: 7, sourceProjectId: 3 },
    ])
    if (url.pathname.endsWith('/changeRequests/5')) {
      const repositoryId = Number(url.pathname.split('/').at(-3))
      return Response.json({ ...open, projectId: repositoryId, title: '修改术语', status: 'MERGED' })
    }
    throw new Error('Unexpected test API ' + url.pathname)
  })
  function host() {
    let endpoint
    let toolGuard
    apply({
      inject() {}, on() {}, commands: { register() {} }, credentials: { readRecord: async () => auth },
      tools: { guard(check) { toolGuard = check } },
      workspaceRegistry: { get: id => id === 'w' ? workspace : undefined, list: () => [workspace] },
      connection: { fetch: { register(route) { if (route.path === '/api/dy-yunxiao') endpoint = route.fetch } } },
    })
    assert.match(toolGuard({ agent: { id: 'dy-mr-review-test' } }), /只读审查/)
    assert.equal(toolGuard({ agent: { id: 'session-normal' } }), undefined)
    return async (method, input) => (await endpoint(new Request('http://localhost/api/dy-yunxiao', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, input }),
    }))).json()
  }
  const rpc = host()
  assert.deepEqual((await rpc('workbenchPlan', scope)).value.candidates.map(mr => mr.localId), [5])
  for (const localId of [6, 7]) {
    assert.match((await rpc('linkPlanMr', { ...scope, repositoryId: 2, localId })).error, /不匹配/)
  }
  const mr = { repositoryId: 2, localId: 5 }
  assert.deepEqual((await rpc('linkPlanMr', { ...scope, ...mr })).value.mr, mr)
  const restarted = host()
  assert.equal((await restarted('workbenchPlan', scope)).value.mrStatus, 'MERGED')
  assert.equal((await restarted('workbenchPlans', {})).value[0].mrStatus, 'MERGED')
  assert.equal((await restarted('workbenchMr', mr)).value.plans[0].planId, plan.id)
  assert.deepEqual((await restarted('workbenchMr', { ...mr, repositoryId: 3 })).value.plans, [])
})

test('real Git: selected nested repo only, first push, retry, synchronized and ahead branches', async t => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-mr-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'HIS'), sub = join(root, 'Nto.His', 'Term')
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim()
  for (const [dir, name] of [[root, 'his'], [sub, 'term']]) {
    await mkdir(dir, { recursive: true })
    g(base, 'init', '--bare', '--initial-branch=main', name + '.git')
    g(dir, 'init', '--initial-branch=main')
    g(dir, 'config', 'user.name', 'Test'); g(dir, 'config', 'user.email', 'test@example.invalid')
    await writeFile(join(dir, 'data'), 'base')
    g(dir, 'add', 'data'); g(dir, 'commit', '-m', 'base')
    g(dir, 'remote', 'add', 'origin', join(base, name + '.git')); g(dir, 'push', '-u', 'origin', 'main')
    g(dir, 'switch', '-c', 'feature/export')
    await writeFile(join(dir, 'data'), 'new')
    g(dir, 'commit', '-am', 'update')
  }
  await writeFile(join(root, '.gitmodules'), '[submodule "Term"]\n path = Nto.His/Term\n')
  const log = join(sub,'.git','push-count')
  await writeFile(join(sub,'.git','hooks','pre-push'), '#!/bin/sh\necho push >> "$(git rev-parse --git-dir)/push-count"\n', { mode: 0o755 })
  const rows = await mrRepos(root)
  assert.deepEqual(rows.map(r => r.key), ['.', 'Nto.His/Term'])
  const created = []
  let fail = true
  const api = {
    repository: async remote => ({ id: remote.endsWith('term.git') ? 2 : 1, path: remote, defaultBranch: 'main' }),
    openForSource: async () => [],
    create: async (id, branch, target) => {
      if (fail) { fail = false; throw new Error('simulated failure') }
      created.push([id, branch, target])
      return { localId: 2, url: '' }
    },
  }
  const key = rows[1].key
  g(sub, 'switch', 'main')
  assert.deepEqual((await deliveryOptions(root, key, 'feature/export', api)).targets, ['main'])
  await assert.rejects(deliveryOptions(root, key, 'missing', api), /没有计划源分支/)
  g(sub, 'switch', 'feature/export')
  const preview = await mrPreview(root, key, api)
  assert.equal(preview.branch, 'feature/export')
  assert.equal(preview.needPush, true)
  const input = { key, ...preview, repositoryId: 2, target: 'main', title: 'MR', description: '' }
  await assert.rejects(submitMr(root, { ...input, key: '.' }, api), /仓库、分支或提交已变化/)
  await assert.rejects(submitMr(root, input, api), /源分支已推送/)
  assert.equal(g(base, '--git-dir=term.git','rev-parse','refs/heads/feature/export'), preview.sha)
  assert.equal(g(base, '--git-dir=his.git','for-each-ref','refs/heads/feature/export'), '')
  assert.equal((await submitMr(root, input, api)).pushed, false)
  assert.deepEqual(created, [[2,'feature/export','main']])
  assert.equal((await readFile(log,'utf8')).trim(),'push')
  g(sub,'commit','--allow-empty','-m','next')
  const ahead = await mrPreview(root,key,api)
  assert.equal(ahead.ahead,1)
  await assert.rejects(submitMr(root,input,api), /提交已变化/)
  assert.equal((await submitMr(root,{ ...input,...ahead },api)).pushed,true)
  assert.equal((await readFile(log,'utf8')).trim().split('\n').length,2)
  await assert.rejects(mrPreview(root,'../term.git',api),/移出工作区/)
})
