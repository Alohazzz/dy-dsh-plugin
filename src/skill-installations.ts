import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { dshSkillTarget, type CatalogSkill, type SkillInstallation, type SkillSource, type SkillTarget } from './skill-catalog.ts'
import { copySkillBundle, parseSkillDocument } from './skill-sources.ts'

type Target = SkillTarget & { directory?: string }
type StoredInstallation = Omit<SkillInstallation, 'target'> & { target: Target; files: string[] }
type Lookup = { cwd?: string; scope?: object }
const providerName = 'dy-workbench-skills'
const notFound = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const normalize = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
const safeId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const below = (root: string, path: string) => {
  const child = relative(normalize(root), normalize(path))
  return !isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep)
}

function installedDocument(text: string, name: string) {
  const { fields, markdown } = parseSkillDocument(text, 'core')
  const description = typeof fields.description === 'string' ? fields.description.trim() : ''
  if (!description || typeof fields.name !== 'string' || fields.name.trim() !== name) {
    throw new Error('技能名称或简介与目录记录不一致，请刷新后重试')
  }
  for (const key of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) {
    if (Object.hasOwn(fields, key)) throw new Error('技能使用了 DSH 未支持的调用配置：' + key)
  }
  const optionalBoolean = (key: string, fallback: boolean) => {
    const value = fields[key]
    if (value === undefined) return fallback
    if (typeof value !== 'boolean') throw new Error('技能调用配置无效：' + key)
    return value
  }
  return {
    description, content: markdown, metadata: fields,
    whenToUse: typeof fields['when-to-use'] === 'string' ? fields['when-to-use'] : undefined,
    invocation: { modelInvocable: !optionalBoolean('disable-model-invocation', false), userInvocable: optionalBoolean('user-invocable', true) },
  }
}

export async function skillProjectRoot(directory: string) {
  const cwd = await realpath(directory)
  for (let path = cwd; ; path = dirname(path)) {
    try {
      await lstat(join(path, '.git'))
      return { cwd, root: path, git: true }
    } catch (error) {
      if (!notFound(error)) throw error
    }
    if (dirname(path) === path) return { cwd, root: cwd, git: false }
  }
}

export function createSkillInstallations(home: string, getAgent: (id: string) => object | undefined, catalogChanged: () => void) {
  const root = join(home, 'skill-installations')
  let invalidate = () => {}
  let queue: Promise<unknown> = Promise.resolve()

  function mutate<T>(operation: () => Promise<T>): Promise<T> {
    const task = queue.then(operation)
    queue = task.catch(() => {})
    return task
  }
  const directory = (id: string) => join(root, id, 'bundle')

  async function records(): Promise<StoredInstallation[]> {
    const folders = await readdir(root).catch(error => {
      if (notFound(error)) return []
      throw error
    })
    const rows = await Promise.all(folders.filter(id => safeId.test(id)).map(async id => {
      const json = await readFile(join(root, id, 'installation.json'), 'utf8').catch(error => {
        if (notFound(error)) return undefined
        throw error
      })
      return json === undefined ? undefined : JSON.parse(json) as StoredInstallation
    }))
    return rows.filter(row => row !== undefined)
  }
  async function intact(row: StoredInstallation) {
    const bundle = directory(row.id)
    return (await Promise.all(row.files.map(async file => {
      try {
        const path = join(bundle, file)
        return below(bundle, path) && normalize(await realpath(path)) === normalize(path) && (await lstat(path)).isFile()
      } catch {
        return false
      }
    }))).every(Boolean)
  }
  async function list(): Promise<SkillInstallation[]> {
    return Promise.all((await records()).map(async ({ files, target: { directory: _directory, ...target }, ...row }) => ({
      ...row, target, broken: !await intact({ ...row, files, target }),
    })))
  }
  function install(source: SkillSource, skill: CatalogSkill, target: Target) {
    return mutate(async () => {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) || !skill.description || skill.missing.length) {
        throw new Error('DSH 安装需要有效的技能名称（小写 kebab-case）和简介')
      }
      for (const row of await records()) {
        const sameTarget = row.target.kind === target.kind && (target.kind === 'agent' ? row.target.id === target.id :
          normalize(row.target.directory!) === normalize(target.directory!))
        if (!sameTarget || row.name !== skill.name) continue
        if (row.sourceId === source.id && row.path === skill.path && await intact(row)) return
        throw new Error('该目标已有同名技能，请先卸载现有安装')
      }
      await mkdir(root, { recursive: true })
      const pending = await mkdtemp(join(root, '.pending-'))
      const id = randomUUID()
      try {
        await copySkillBundle(source, skill, join(pending, 'bundle'))
        installedDocument(await readFile(join(pending, 'bundle', 'SKILL.md'), 'utf8'), skill.name)
        const prefix = skill.path.slice(0, -'SKILL.md'.length)
        const record: StoredInstallation = {
          id, target, name: skill.name, sourceId: source.id, sourceName: source.name, path: skill.path,
          readAt: skill.readAt, commit: skill.commit, files: ['SKILL.md', ...skill.files.map(path => path.slice(prefix.length))],
        }
        await writeFile(join(pending, 'installation.json'), JSON.stringify(record), 'utf8')
        await rename(pending, join(root, id))
        invalidate()
        catalogChanged()
      } finally {
        await rm(pending, { recursive: true, force: true })
      }
    })
  }
  function uninstall(id: string) {
    return mutate(async () => {
      if (!safeId.test(id)) throw new Error('无效的安装记录')
      const removed = join(root, '.removed-' + randomUUID())
      try {
        await rename(join(root, id), removed)
      } catch (error) {
        if (notFound(error)) return
        throw error
      }
      invalidate()
      catalogChanged()
      await rm(removed, { recursive: true, force: true, maxRetries: 3 })
    })
  }
  async function visible(rows: StoredInstallation[], options: Lookup) {
    const workspace = options.cwd && rows.some(row => row.target.kind === 'project') ?
      await skillProjectRoot(options.cwd).catch(() => undefined) : undefined
    return rows.filter(({ target }) => {
      if (target.kind === 'agent') {
        if (target.id === dshSkillTarget.id) return true
        // Preserve the scope of installations created with older versions.
        return options.scope !== undefined && options.scope === getAgent(target.id)
      }
      if (!workspace || !target.directory) return false
      return workspace.git ? normalize(workspace.root) === normalize(target.directory) : below(target.directory, workspace.cwd)
    })
  }
  async function definition(row: StoredInstallation) {
    if (!await intact(row)) return undefined
    const base = directory(row.id)
    const path = join(base, 'SKILL.md')
    const text = await readFile(path, 'utf8').catch(error => {
      if (notFound(error)) return undefined
      throw error
    })
    if (text === undefined) return undefined
    return {
      ...installedDocument(text, row.name),
      name: row.name, path, source: 'custom' as const, provider: providerName,
      resourceBase: { kind: 'directory' as const, path: base },
    }
  }
  function provider(control: { invalidate: () => void }) {
    invalidate = control.invalidate
    return {
      name: providerName,
      async list(options: Lookup) {
        const rows = await visible(await records(), options)
        const candidates = await Promise.all(rows.map(async row => {
          const skill = await definition(row).catch(() => undefined)
          if (!skill) return undefined
          const { content: _content, ...summary } = skill
          const rank = row.target.kind === 'project' ? 110 : row.target.id === dshSkillTarget.id ? 410 : 90
          return { ...summary, locator: row.id, rank }
        }))
        return { candidates: candidates.filter(candidate => candidate !== undefined), complete: candidates.every(Boolean) }
      },
      async get(candidate: { locator: unknown }, options: Lookup) {
        const rows = await visible((await records()).filter(row => row.id === candidate.locator), options)
        return rows.length ? definition(rows[0]) : undefined
      },
    }
  }
  return { install, uninstall, list, provider }
}
