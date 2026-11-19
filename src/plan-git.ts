import { mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import type { PlanBranchCheck, PlanCreate } from './contracts.ts'
import { git } from './merge-request.ts'

async function requireBranchName(cwd: string, branch: string) {
  if (!branch || branch.startsWith('-') ||
      await git(cwd, ['check-ref-format', '--normalize', 'refs/heads/' + branch], true) !== 'refs/heads/' + branch) {
    throw new Error('无效的 Git 分支名「' + branch + '」')
  }
}

const localBranch = (cwd: string, branch: string) =>
  git(cwd, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch + '^{commit}'], true)

export async function checkPlanBranch(cwd: string, branch: string): Promise<PlanBranchCheck> {
  await requireBranchName(cwd, branch)
  const localExists = Boolean(await localBranch(cwd, branch))
  const remotes = (await git(cwd, ['remote'])).split(/\r?\n/)
  const ref = 'refs/heads/' + branch
  const remote = remotes.includes('origin')
    ? await git(cwd, ['ls-remote', '--heads', '--', 'origin', ref]) : ''
  return { localExists, remoteExists: remote.split(/\r?\n/).some(row => row.split('\t')[1] === ref) }
}

export async function commonGitDirectory(cwd: string) {
  return realpath(await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
}

export async function planWorktree(cwd: string, path: string) {
  try {
    const directory = await realpath(path)
    const root = await git(directory, ['rev-parse', '--show-toplevel'])
    if (!relative(directory, root) && !relative(await commonGitDirectory(cwd), await commonGitDirectory(directory))) return directory
  } catch { /* The worktree may have been removed or moved. */ }
  throw new Error('找不到该计划的 Git worktree，请检查创建时的代码目录')
}

export async function createPlanCheckout(cwd: string, plan: PlanCreate, id: string) {
  const { branch, baseBranch, targetBranch, useExistingRemote, worktreeDir } = plan
  if (branch === targetBranch) throw new Error('源分支不能与合并目标分支相同')
  if (targetBranch) await requireBranchName(cwd, targetBranch)
  await requireBranchName(cwd, baseBranch)
  const { localExists, remoteExists } = await checkPlanBranch(cwd, branch)
  if (localExists) throw new Error('本地已存在同名分支，请改名')
  if (remoteExists && !useExistingRemote) throw new Error('远端已存在同名分支，请检测后选择继续使用或改名')
  if (!remoteExists && useExistingRemote) throw new Error('远端同名分支已不存在，请重新检测')

  const worktree = worktreeDir ? join(worktreeDir, id) : undefined
  if (worktreeDir && !isAbsolute(worktreeDir)) throw new Error('代码目录必须是绝对路径')
  const head = worktree ? '' : await git(cwd, ['rev-parse', '--verify', 'HEAD'])
  const previous = worktree ? '' : await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true)
  if (!worktree && await git(cwd, ['status', '--porcelain'])) {
    throw new Error('主工作区存在未提交改动，请先提交或使用 git stash，或另建 worktree')
  }

  let start = 'refs/heads/' + baseBranch
  if (useExistingRemote) {
    start = 'refs/remotes/origin/' + branch
    await git(cwd, ['fetch', '--no-tags', '--no-recurse-submodules', '--', 'origin', '+refs/heads/' + branch + ':' + start])
  } else if (!await localBranch(cwd, baseBranch)) {
    start = 'refs/remotes/' + baseBranch
    if (!await git(cwd, ['rev-parse', '--verify', '--quiet', start + '^{commit}'], true)) {
      throw new Error('目标仓库找不到基础分支「' + baseBranch + '」')
    }
  }
  // Reserve the branch without replacing an existing ref, including one created after the check.
  await git(cwd, ['branch', useExistingRemote ? '--track' : '--no-track', '--', branch, start])
  async function rollback() {
    if (worktree) {
      const entries = (await git(cwd, ['worktree', 'list', '--porcelain', '-z'])).split('\0')
      if (entries.some(entry => entry.startsWith('worktree ') && !relative(worktree, entry.slice(9)))) {
        await git(cwd, ['worktree', 'remove', '--', worktree])
      }
    } else if (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true) === branch) {
      await git(cwd, ['switch', '--no-recurse-submodules', ...(previous ? ['--', previous] : ['--detach', head])])
    }
    await git(cwd, ['branch', '-D', '--', branch])
  }
  try {
    if (worktree) {
      await mkdir(worktreeDir!, { recursive: true })
      await git(cwd, ['worktree', 'add', '--', worktree, branch])
    } else await git(cwd, ['switch', '--no-recurse-submodules', '--', branch])
  } catch (failure) {
    await rollback().catch(() => { throw new Error('检出失败，且自动清理未完成，请检查分支「' + branch + '」') })
    throw failure
  }
  return { worktree, rollback }
}
