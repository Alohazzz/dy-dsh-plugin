import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, posix, relative } from 'node:path'
import { promisify } from 'node:util'
import { parse } from 'yaml'
import type { CatalogSkill, SkillSource, SkillSourceInput } from './skill-catalog.ts'

const run = promisify(execFile)
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const inside = (path: string, parent: string) => !parent || path === parent || path.startsWith(parent + '/')
const definition = (path: string) => posix.basename(path) === 'SKILL.md'
const folder = (path: string) => posix.dirname(path) === '.' ? '' : posix.dirname(path)

async function gitBytes(cwd: string, ...args: string[]) {
  try {
    return (await run('git', ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
      '-c', 'protocol.ssh.allow=always', ...args], {
      cwd, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout: 60_000, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    })).stdout
  } catch (error) {
    const failure = error as { code?: string; killed?: boolean }
    if (failure.code === 'ENOENT') throw new Error('找不到 Git，请确认宿主可以调用本机 Git')
    if (failure.killed) throw new Error('Git 操作超时，请检查网络和仓库访问权限')
    throw new Error('Git ' + args[0] + ' 失败，请检查仓库地址、分支和本机 Git 访问权限')
  }
}

const git = async (cwd: string, ...args: string[]) => (await gitBytes(cwd, ...args)).toString('utf8')
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

export function parseSkillDocument(content: string, schema: 'failsafe' | 'core' = 'failsafe') {
  content = content.replace(/^\uFEFF/, '')
  const header = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(content)
  const hasHeader = /^---[ \t]*\r?\n/.test(content)
  if (hasHeader && header?.index !== 0) throw new Error('技能元数据缺少结束分隔线')
  const metadata: unknown = hasHeader && header ? parse(header[1], { schema }) : {}
  if (metadata != null && (typeof metadata !== 'object' || Array.isArray(metadata))) throw new Error('技能元数据应为键值映射')
  return {
    fields: (metadata ?? {}) as Record<string, unknown>,
    markdown: hasHeader && header ? content.slice(header[0].length) : content,
  }
}

function bundlePath(path: string, root: string) {
  if (!inside(path, root)) throw new Error('配套文件超出技能目录')
  const child = root ? path.slice(root.length + 1) : path
  if (child.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' ||
    /[\\:\x00-\x1f]/.test(part) || (process.platform === 'win32' &&
      (/[<>"|?*]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))))) {
    throw new Error('技能含有不支持的文件路径：' + child)
  }
  return child
}

export async function copySkillBundle(source: SkillSource, skill: CatalogSkill, destination: string) {
  if (skill.stale) throw new Error('请刷新来源，读取到有效的技能说明后再安装')
  const root = folder(skill.path)
  const bundle = [skill.path, ...skill.files].map(path => ({ path, child: bundlePath(path, root) }))
  const names = bundle.map(({ child }) => process.platform === 'win32' ? child.toLowerCase() : child)
  if (new Set(names).size !== names.length) throw new Error('技能包含重名文件')
  let repository: string | undefined
  try {
    const local = source.kind === 'local' ? await realpath(source.location) : undefined
    if (local === undefined) {
      if (!skill.commit || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(skill.commit)) throw new Error('来源缺少有效的 Git 提交，请刷新')
      repository = await mkdtemp(join(tmpdir(), 'dy-install-git-'))
      await git(repository, 'init', '--bare', '--quiet')
      await git(repository, 'fetch', '--no-tags', '--depth=1', '--', source.location, skill.commit)
      const fetched = (await git(repository, 'rev-parse', 'FETCH_HEAD')).trim()
      if (fetched !== skill.commit) throw new Error('来源提交已变化，请刷新后重试')
    }
    const tree = new Map<string, number>()
    if (repository) {
      for (const entry of (await git(repository, 'ls-tree', '-r', '-z', skill.commit!)).split('\0')) {
        if (/^100(?:644|755) blob /.test(entry)) tree.set(entry.slice(entry.indexOf('\t') + 1), parseInt(entry.slice(3, 6), 8))
      }
    }
    for (const { path, child } of bundle) {
      let content: Buffer
      let mode: number
      if (repository) {
        const permissions = tree.get(path)
        if (permissions === undefined) throw new Error('来源提交缺少文件：' + path)
        mode = permissions
        content = await gitBytes(repository, 'cat-file', 'blob', skill.commit + ':' + path)
      } else {
        const expected = join(local!, path)
        const actual = await realpath(expected)
        const samePath = process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected
        const details = await stat(actual)
        if (!samePath || !details.isFile() || isAbsolute(relative(local!, actual))) throw new Error('本地技能文件已变化，请刷新：' + path)
        mode = details.mode & 0o777
        content = await readFile(actual)
      }
      if (path === skill.path) {
        const text = content.toString('utf8').replace(/^\uFEFF/, '')
        const { fields, markdown } = parseSkillDocument(text)
        if (skill.digest ? skill.digest !== digest(text) : markdown !== skill.markdown ||
          (typeof fields.name === 'string' && fields.name.trim() !== skill.name) ||
          (typeof fields.description === 'string' && fields.description.trim() !== skill.description)) {
          throw new Error('技能说明已变化，请刷新来源后再安装')
        }
      }
      const output = join(destination, child)
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, content, { mode, flag: 'wx' })
    }
  } finally {
    if (repository) await rm(repository, { recursive: true, force: true, maxRetries: 3 })
  }
}

function gitLocation(location: string) {
  if (/^[\w.-]+@[\w.-]+:[^\s]+$/.test(location)) return location
  const url = URL.parse(location)
  if (!url || !['https:', 'ssh:'].includes(url.protocol) || !url.hostname || url.password ||
      (url.protocol === 'https:' && url.username) || url.search || url.hash || url.pathname === '/') {
    throw new Error('请输入 HTTPS 或 SSH 仓库地址，并在本机 Git 中配置访问凭据')
  }
  return url.href
}

async function readCatalog(source: SkillSource): Promise<SkillSource> {
  const files: string[] = []
  const problems: SkillSource['problems'] = []
  let read = (path: string) => readFile(join(source.location, path), 'utf8')
  let actualBranch: string | undefined
  let commit: string | undefined
  let repository: string | undefined

  async function walk(path: string) {
    try {
      const entries = await readdir(join(source.location, path), { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name === '.git') continue
        const child = path ? path + '/' + entry.name : entry.name
        if (entry.isDirectory()) await walk(child)
        else if (entry.isFile()) files.push(child)
      }
    } catch (error) {
      if (!path) throw new Error('无法读取本地来源：' + message(error))
      problems.push({ path, error: message(error) })
    }
  }

  try {
    if (source.kind === 'local') await walk('')
    else {
      repository = await mkdtemp(join(tmpdir(), 'dy-skill-git-'))
      const cwd = repository
      actualBranch = source.branch
      if (!actualBranch) {
        const head = await git(cwd, 'ls-remote', '--symref', '--', source.location, 'HEAD')
        actualBranch = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(head)?.[1]
        if (!actualBranch) throw new Error('无法读取远端默认分支，请确认仓库已有提交')
      }
      const ref = 'refs/heads/' + actualBranch
      await git(cwd, 'check-ref-format', ref)
      await git(cwd, 'init', '--bare', '--quiet')
      await git(cwd, 'fetch', '--no-tags', '--depth=1', '--', source.location, ref)
      commit = (await git(cwd, 'rev-parse', 'FETCH_HEAD')).trim()
      const tree = await git(cwd, 'ls-tree', '-r', '-z', commit)
      for (const entry of tree.split('\0')) {
        if (/^100(?:644|755) blob /.test(entry)) files.push(entry.slice(entry.indexOf('\t') + 1))
      }
      read = path => git(cwd, 'cat-file', 'blob', commit + ':' + path)
    }
    const readAt = new Date().toISOString()
    const definitions = new Set(files.filter(definition))
    const owned = new Map<string, string[]>()
    for (const file of files.sort()) {
      if (definition(file)) continue
      let parent = folder(file)
      for (;;) {
        const owner = parent ? parent + '/SKILL.md' : 'SKILL.md'
        if (definitions.has(owner)) {
          const list = owned.get(owner) ?? []
          list.push(file)
          owned.set(owner, list)
          break
        }
        if (!parent) break
        parent = folder(parent)
      }
    }
    const skills: CatalogSkill[] = []
    for (const path of definitions) {
      try {
        const content = (await read(path)).replace(/^\uFEFF/, '')
        const { fields, markdown } = parseSkillDocument(content)
        const field = (key: string) => typeof fields[key] === 'string' ? fields[key].trim() : ''
        const missing = ['name', 'description'].filter(key => !field(key))
        const previous = source.skills.find(skill => skill.path === path)
        const unavailable = problems.filter(problem => inside(problem.path, folder(path)))
        const preservedFiles = previous?.files.filter(file => unavailable.some(problem => inside(file, problem.path))) ?? []
        skills.push({
          sourceId: source.id, path, name: field('name') || (folder(path) ? posix.basename(folder(path)) : basename(source.location.replace(/\/$/, ''))),
          description: field('description'), version: field('version') || undefined, missing,
          markdown, digest: digest(content),
          files: [...new Set([...(owned.get(path) ?? []), ...preservedFiles])].sort(), readAt, commit,
        })
      } catch (error) {
        problems.push({ path, error: message(error) })
      }
    }
    const current = new Set(skills.map(skill => skill.path))
    const removed: string[] = []
    for (const skill of source.skills) {
      if (current.has(skill.path)) continue
      if (problems.some(problem => inside(skill.path, problem.path))) skills.push({ ...skill, stale: true })
      else removed.push(skill.path)
    }
    skills.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
    return { ...source, skills, readAt, actualBranch, commit, problems, removed, error: undefined }
  } finally {
    if (repository) await rm(repository, { recursive: true, force: true, maxRetries: 3 })
  }
}

export function createSkillSources(home: string) {
  const file = join(home, 'skill-sources.json')
  const refreshing = new Map<string, Promise<SkillSource>>()
  const binding = new Map<string, Promise<SkillSource>>()
  let sources: SkillSource[] | undefined
  function list(): SkillSource[] {
    if (sources) return sources
    try {
      return sources = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return sources = []
    }
  }
  function save(next: SkillSource[]) {
    mkdirSync(home, { recursive: true })
    const temporary = file + '.' + randomUUID()
    try {
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 })
      renameSync(temporary, file)
      sources = next
    } finally {
      rmSync(temporary, { force: true })
    }
  }
  function get(id: string) {
    const source = list().find(item => item.id === id)
    if (!source) throw new Error('技能源已解除绑定')
    return source
  }
  function update(source: SkillSource) {
    save(list().map(item => item.id === source.id ? source : item))
    return source
  }
  function sourceName(name: string) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('请输入来源名称')
    return name.trim()
  }
  return {
    list,
    async bind(input: SkillSourceInput) {
      const { kind, branch } = input
      const name = sourceName(input.name)
      if (kind !== 'git' && kind !== 'local') throw new Error('未知技能源类型')
      const raw = input.location.trim()
      if (kind === 'local' && !isAbsolute(raw)) throw new Error('请输入本地目录的绝对路径')
      const location = kind === 'local' ? await realpath(raw) : gitLocation(raw)
      const selectedBranch = kind === 'git' ? branch?.trim() || undefined : undefined
      const key = ({ kind, location, branch }: SkillSourceInput) =>
        JSON.stringify([kind, kind === 'local' && process.platform === 'win32' ? location.toLowerCase() : location, branch])
      const source = { id: randomUUID(), kind, location, branch: selectedBranch, name, readAt: '', skills: [], problems: [], removed: [] }
      const identity = key(source)
      const existing = list().find(item => key(item) === identity)
      if (existing) return { source: existing, duplicate: true }
      const pending = binding.get(identity)
      if (pending) return { source: await pending, duplicate: true }
      const task = readCatalog(source).then(result => {
        save([...list(), result])
        return result
      }).finally(() => binding.delete(identity))
      binding.set(identity, task)
      return { source: await task, duplicate: false }
    },
    refresh(id: string) {
      const pending = refreshing.get(id)
      if (pending) return pending
      const source = get(id)
      const task = readCatalog(source).catch(error => ({
        ...source, error: message(error), removed: [],
        skills: source.skills.map(skill => ({ ...skill, stale: true })),
      })).then(result => update({ ...result, name: get(id).name }))
        .finally(() => refreshing.delete(id))
      refreshing.set(id, task)
      return task
    },
    rename(id: string, name: string) {
      return update({ ...get(id), name: sourceName(name) })
    },
    unbind(id: string) {
      get(id)
      if (refreshing.has(id)) throw new Error('请等待当前来源刷新完成')
      save(list().filter(item => item.id !== id))
    },
  }
}
