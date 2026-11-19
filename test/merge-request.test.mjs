import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deliveryOptions, mrRepos, mrPreview, submitMr } from '../src/merge-request.ts'
import { codeupApi } from '../src/codeup.mjs'
import { apply } from '../src/host.ts'
import { createMrReviews } from '../src/mr-review.ts'
import { digest } from '../src/yunxiao.mjs'
import { createWorkflow } from '../src/workflow.ts'

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
  assert.deepEqual(result.rows.map(row => [row.repositoryId, row.localId]), [[2, 5], [3, 5]])
  assert.equal(result.more, false)
  assert.equal((await api.detail({ repositoryId: 2, localId: 5 })).status, 'MERGED')
  await assert.rejects(api.detail({ repositoryId: 2, localId: '../5' }), /无效/)
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
