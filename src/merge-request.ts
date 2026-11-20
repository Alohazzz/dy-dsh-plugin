import { execFile, spawn } from 'node:child_process'
import { access, readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { createClient } from './yunxiao-client.mjs'

type Api = ReturnType<typeof createClient>['codeup']
const exec = promisify(execFile)
const gitOutputLimit = 16 << 20

async function cancellableGit(args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal) {
  signal.throwIfAborted()
  const windows = process.platform === 'win32'
  const child = spawn('git', args, { cwd, env, windowsHide: true, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] })
  let stopping: Promise<unknown> | undefined
  function stop() {
    if (stopping || !child.pid) return
    const pid = child.pid
    // Git can leave remote helpers downloading if only its launcher is killed.
    if (windows) {
      const taskkill = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
      stopping = exec(taskkill, ['/pid', String(pid), '/t', '/f'], { windowsHide: true })
        .catch(() => { if (child.exitCode === null) child.kill() })
    } else {
      stopping = Promise.resolve()
      try { process.kill(-pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }
  }
  signal.addEventListener('abort', stop, { once: true })
  try {
    return await new Promise<string>((resolve, reject) => {
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let bytes = 0
      function collect(chunks: Buffer[], data: Buffer) {
        bytes += data.length
        if (bytes <= gitOutputLimit) chunks.push(data)
        else stop()
      }
      child.stdout.on('data', data => collect(stdout, data))
      child.stderr.on('data', data => collect(stderr, data))
      child.once('error', reject)
      child.once('close', code => {
        if (code === 0 && bytes <= gitOutputLimit) resolve(Buffer.concat(stdout).toString())
        else reject(Object.assign(new Error('Git command failed'), { code, stderr: Buffer.concat(stderr).toString() }))
      })
    })
  } finally {
    signal.removeEventListener('abort', stop)
    await stopping
    signal.throwIfAborted()
  }
}

export async function git(cwd: string, args: string[], optional = false, localOnly = false, signal?: AbortSignal) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never',
    ...(args[0] === 'switch' ? { LC_ALL: 'C' } : {}),
    ...(localOnly ? { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } : {}) }
  try {
    const output = signal ? await cancellableGit(args, cwd, env, signal) :
      (await exec('git', args, { cwd, env, windowsHide: true, timeout: 90_000, maxBuffer: gitOutputLimit })).stdout
    return output.trimEnd()
  } catch (error) {
    signal?.throwIfAborted()
    const failure = error as { code?: number; stderr?: string }
    if (optional && failure.code === 1) return ''
    if (args[0] === 'switch' && /would be overwritten by checkout/i.test(failure.stderr ?? '')) {
      throw new Error('切换分支会覆盖主工作区的未提交改动或未跟踪文件，请先保存这些内容，或另建 worktree')
    }
    let command = 0
    while (args[command] === '-c') command += 2
    throw new Error('Git ' + args[command] + ' 失败，请检查仓库、网络和 Git 访问权限')
  }
}

async function directories(workspace: string) {
  const root = await realpath(workspace)
  const entries = await readdir(root, { withFileTypes: true })
  const paths = new Set(['.'])
  if (entries.some(e => e.name === '.gitmodules')) {
    const values = await git(root, ['config', '-z', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'], true)
    for (const pair of values.split('\0').filter(Boolean)) paths.add(pair.slice(pair.indexOf('\n') + 1))
  }
  for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') paths.add(entry.name)
  const result = new Map<string, string>()
  for (const path of paths) {
    const dir = await realpath(resolve(root, path)).catch(() => '')
    if (!dir) continue
    const rel = relative(root, dir)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) continue
    if (await access(join(dir, '.git')).then(() => true, () => false)) result.set(rel.split(sep).join('/') || '.', dir)
  }
  return result
}

async function status(dir: string) {
  const raw = await git(dir, ['status', '--porcelain=v2', '--branch', '-z', '--no-renames'])
  const rows = raw.split('\0').filter(Boolean)
  const value = (field: string) => {
    const prefix = '# branch.' + field + ' '
    return rows.find(x => x.startsWith(prefix))?.slice(prefix.length) || ''
  }
  const head = value('head'), oid = value('oid'), ab = value('ab').split(' ')
  return { branch: head === '(detached)' ? '' : head, sha: oid === '(initial)' ? '' : oid, upstream: value('upstream'),
    upstreamGone: Boolean(value('upstream') && !value('ab')), ahead: Number(ab[0] || 0), behind: Math.abs(Number(ab[1] || 0)), dirty: rows.filter(x => !x.startsWith('# ')).length }
}

export async function mrRepos(root: string) {
  const rows = []
  for (const [key, dir] of await directories(root)) {
    try { rows.push({ key, name: basename(dir), ...await status(dir), error: '' }) }
    catch { rows.push({ key, name: basename(dir), branch: '', sha: '', upstream: '', upstreamGone: false, ahead: 0, behind: 0, dirty: 0, error: '读取 Git 状态失败' }) }
  }
  return rows
}
export async function workspaceRepository(root: string, key: string) {
  const dir = (await directories(root)).get(key)
  if (!dir) throw new Error('目标仓库已移出工作区，请刷新')
  return dir
}
async function ensureCommit(dir: string, remote: string, branch: string, sha: string) {
  try { await git(dir, ['cat-file', '-e', sha + '^{commit}']) }
  catch { await git(dir, ['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--', remote, 'refs/heads/' + branch]) }
}
async function remoteRepository(dir: string, api: Api) {
  const readUrl = await git(dir, ['remote', 'get-url', 'origin'])
  const pushUrl = await git(dir, ['remote', 'get-url', '--push', '--all', 'origin'])
  const repository = await api.repository(readUrl, pushUrl)
  return { repository, readUrl, pushUrl }
}

async function remoteBranches(dir: string, readUrl: string) {
  const refs = new Map<string, string>()
  for (const line of (await git(dir, ['ls-remote', '--heads', '--', readUrl])).split('\n')) {
    const match = /^([0-9a-f]+)\s+refs\/heads\/(.+)$/.exec(line.trim())
    if (match) refs.set(match[2], match[1])
  }
  return refs
}

export async function deliveryOptions(root: string, key: string, source: string, api: Api) {
  const dir = await workspaceRepository(root, key)
  const localRef = await git(dir, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + source + '^{commit}'], true)
  if (!localRef) throw new Error('所选仓库没有计划源分支「' + source + '」')
  const { repository, readUrl } = await remoteRepository(dir, api)
  const refs = await remoteBranches(dir, readUrl)
  return { repository, targets: [...refs.keys()].filter(branch => branch !== source) }
}

async function inspect(dir: string, api: Api) {
  const local = await status(dir)
  const { repository, readUrl, pushUrl } = await remoteRepository(dir, api)
  const refs = await remoteBranches(dir, readUrl)
  const remoteSha = refs.get(local.branch) || ''
  let ahead = 0, behind = 0
  let blocked = !local.sha ? '当前仓库尚无提交' : !local.branch ? '请先检出本地分支' : ''
  if (!blocked && remoteSha && remoteSha !== local.sha) {
    await ensureCommit(dir, readUrl, local.branch, remoteSha)
    const counts = await git(dir, ['rev-list', '--left-right', '--count', local.sha + '...' + remoteSha])
    ;[ahead, behind] = counts.split(/\s+/).map(Number)
    if (behind) blocked = ahead ? '本地与远端已分叉，请先整合提交' : '本地分支落后，请先同步'
  }
  const targets = [...refs.keys()].filter(x => x !== local.branch)
  const needPush = Boolean(!blocked && remoteSha !== local.sha)
  // For a new branch the default target gives a useful comparison even in a shallow checkout.
  const base = remoteSha || refs.get(repository.defaultBranch)
  let commits: string[] = []
  if (needPush) {
    if (base && !remoteSha) await ensureCommit(dir, readUrl, repository.defaultBranch, base)
    const log = await git(dir, ['log', '-20', '--format=%h %s', local.sha, ...(base ? ['^' + base] : []), '--'])
    commits = log ? log.split('\n') : []
  }
  const preview = { ...local, repository, remoteSha, ahead, behind, blocked, targets, needPush, commits }
  return { preview, refs, readUrl, pushUrl }
}
export async function mrPreview(root: string, key: string, api: Api, worktree?: string) {
  const { preview } = await inspect(worktree ?? await workspaceRepository(root, key), api)
  return { ...preview, openMrs: await api.openForSource(preview.repository.id, preview.branch) }
}

export type MrInput = { workspaceId: string; key: string; repositoryId: number; branch: string; sha: string; remoteSha: string;
  target: string; title: string; description: string; needPush: boolean; reviewerUserIds?: string[] }
const pending = new Set<string>()
export async function submitMr(root: string, input: MrInput, api: Api, worktree?: string) {
  const dir = worktree ?? await workspaceRepository(root, input.key)
  const lock = JSON.stringify([input.repositoryId, input.branch, input.target])
  if (pending.has(lock)) throw new Error('该合并请求正在提交')
  pending.add(lock)
  let pushed = false
  try {
    if (input.reviewerUserIds !== undefined && (!Array.isArray(input.reviewerUserIds) ||
      input.reviewerUserIds.some(id => typeof id !== 'string' || !id.trim()))) throw new Error('审核人 ID 无效')
    if (!input.title?.trim() || input.title.length > 256 || typeof input.description !== 'string' || input.description.length > 10000)
      throw new Error('请填写有效标题（最多 256 字）和描述（最多 10000 字）')
    const { preview: p, refs, pushUrl, readUrl } = await inspect(dir, api)
    if (p.repository.id !== input.repositoryId || p.branch !== input.branch || p.sha !== input.sha || !p.targets.includes(input.target))
      throw new Error('仓库、分支或提交已变化，请刷新后重新确认')
    const already = (await api.openForSource(p.repository.id, p.branch)).find(mr => mr.target === input.target)
    if (already) return { ...already, existing: true, pushed }
    if (input.reviewerUserIds?.length) {
      const eligible = await api.reviewerCandidates(p.repository.id, input.target)
      const ids = new Set(eligible.map(user => user.id))
      if (input.reviewerUserIds.some(id => !ids.has(id))) throw new Error('所选审核人缺少目标分支合并权限，请重新选择')
    }
    if (p.blocked) throw new Error(p.blocked)
    if (p.needPush && (input.needPush !== true || input.remoteSha !== p.remoteSha)) throw new Error('远端源分支已变化，请刷新后重新确认推送')
    const targetSha = refs.get(input.target)!
    await ensureCommit(dir, readUrl, input.target, targetSha)
    if (await git(dir, ['rev-list', '--count', targetSha + '..' + p.sha]) === '0') throw new Error('源分支相对目标分支没有新增提交')
    const current = await status(dir)
    if (current.sha !== p.sha || current.branch !== p.branch) throw new Error('当前检出已变化，请刷新后重新确认')
    if (p.needPush) {
      await git(dir, ['push', '--no-follow-tags', '--recurse-submodules=no', '--', pushUrl, p.sha + ':refs/heads/' + p.branch])
      pushed = true
    }
    const confirmed = await git(dir, ['ls-remote', '--heads', '--', readUrl, 'refs/heads/' + p.branch])
    if (confirmed.split(/\s+/)[0] !== p.sha) throw new Error('远端提交已变化，请刷新核对')
    const created = await api.create(p.repository.id, p.branch, input.target, input.title.trim(), input.description, input.reviewerUserIds)
    return { ...created, existing: false, pushed }
  } catch (error) {
    throw new Error((pushed ? '源分支已推送。' : '') + (error instanceof Error ? error.message : '创建失败') + '。重试时将先核对已有 MR。')
  } finally { pending.delete(lock) }
}
