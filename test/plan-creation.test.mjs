import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { planBranchName } from '../src/plan-branch-name.ts'
import { checkPlanBranch, planWorktree } from '../src/plan-git.ts'
import { mrPreview } from '../src/merge-request.ts'
import { createWorkflow } from '../src/workflow.ts'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

test('创建计划选择正确的仓库和基础提交，处理冲突并保留独立检出', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-create-plan-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'workspace')
  const directory = join(cwd, 'Term')
  const remote = join(root, 'remote.git')
  await mkdir(directory, { recursive: true })
  git(root, 'init', '--bare', '--initial-branch=main', remote)
  git(cwd, 'init', '--initial-branch=main')
  git(directory, 'init', '--initial-branch=main')
  await writeFile(join(directory, 'source.txt'), 'base')
  git(directory, 'add', 'source.txt')
  git(directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base')
  const base = git(directory, 'rev-parse', 'HEAD')
  git(directory, 'remote', 'add', 'origin', remote)
  git(directory, 'push', 'origin', 'main', 'main:refs/heads/fix/remote')
  git(directory, 'switch', '-c', 'develop')
  git(directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'other')
  const options = { home: join(root, 'state'), client: () => ({ organization: 'org' }), host: {} }
  const workflow = createWorkflow(options)
  const input = { name: '术语 缓存', kind: 'fix', version: 'v2.20260901', branch: '', end: '2026-11-24',
    baseBranch: 'main', targetBranch: 'develop', useExistingRemote: false }
  const repository = { key: 'Term', directory }
  const create = change => workflow.createPlan(cwd, 'project', { ...input, ...change }, repository)
  const branch = planBranchName(input.kind, input.version, input.targetBranch, input.name)
  assert.equal(branch, 'fix/v2.20260901/develop/术语-缓存')
  await assert.rejects(create({ end: '2026-02-30' }), /有效的完成日期/)
  await assert.rejects(create({ name: '无效分支', branch: '@{-1}' }), /无效的 Git 分支名/)
  assert.deepEqual(await checkPlanBranch(directory, 'fix/remote'), { localExists: false, remoteExists: true })
  await assert.rejects(create({ branch: 'fix/remote' }), /远端已存在/)
  assert.deepEqual(await workflow.plans(cwd, 'project'), [])
  const plan = await create({})
  assert.equal(plan.repositoryKey, 'Term')
  assert.equal(plan.targetBranch, 'develop')
  assert.equal(git(directory, 'branch', '--show-current'), branch)
  assert.equal(git(directory, 'rev-parse', 'HEAD'), base)
  assert.equal(git(cwd, 'branch', '--show-current'), 'main')
  assert.deepEqual(await checkPlanBranch(directory, branch), { localExists: true, remoteExists: false })
  await assert.rejects(create({ name: '另一个计划', branch }), /本地已存在/)

  await writeFile(join(directory, 'source.txt'), 'uncommitted')
  await assert.rejects(create({ name: '主检出受保护', branch: 'fix/dirty' }), /未提交改动/)
  const isolated = await create({ name: '远端计划', branch: 'fix/remote',
    useExistingRemote: true, worktreeDir: join(root, '独立代码') })
  assert.equal(git(directory, 'branch', '--show-current'), branch)
  assert.equal(git(directory, 'status', '--short'), 'M source.txt')
  assert.equal(git(isolated.worktree, 'branch', '--show-current'), 'fix/remote')
  assert.equal(git(isolated.worktree, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/fix/remote')
  const worktree = await planWorktree(directory, isolated.worktree)
  const preview = await mrPreview(cwd, repository.key, {
    repository: async () => ({ id: 1, path: 'org/term', defaultBranch: 'main' }),
    openForSource: async () => [],
  }, worktree)
  assert.equal(preview.branch, isolated.branch)
  assert.deepEqual(await createWorkflow(options).plans(cwd, 'project'), [JSON.parse(JSON.stringify(plan)), isolated])
})
