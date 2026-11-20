import { link, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, relative, sep } from 'node:path'
import { stringify } from 'yaml'
import type { IssueDocumentBody, IssueDocumentKey, Plan } from './contracts.ts'
import { atomicJson, digest, readJson } from './yunxiao.mjs'
import { archiveManifest, archiveReadme, templateFor, validatedDocument } from './workbench-documents.mjs'

export type ArchiveScope = { root: string; organization: string; project: string; planId: string; projectName?: string }
export type ArchiveIssue = { id: string; reference?: string; title?: string; module?: string }
type Kind = Parameters<typeof validatedDocument>[0]
type StoredDocument = { event: string; type: Kind; file: string; version: number; templateVersion: number; time: string;
  participation?: string; commitSha?: string; reportStatus?: string; patch?: string; supersedes?: string[]; executionSession?: string;
  evidence?: string; verification?: string; pendingVerification?: string }
type IssueManifest = ArchiveIssue & { documents: StoredDocument[]; reviews?: unknown[] }
type PlanManifest = { voidedAt?: string; id: string; name: string; branch: string; end: string; repositoryKey?: string; goal?: string;
  history?: Plan['history']; members: string[]; delivery?: Plan['delivery']; documents: StoredDocument[]; revision?: number }

const locks = new Map<string, Promise<unknown>>()
function lock<T>(key: string, action: () => Promise<T>) {
  const previous = locks.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(action)
  locks.set(key, next)
  return next.finally(() => { if (locks.get(key) === next) locks.delete(key) })
}

async function stat(path: string) {
  try { return await lstat(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}

async function safeDirectory(path: string, create: boolean) {
  if (create) await mkdir(path).catch(error => { if (error.code !== 'EEXIST') throw error })
  const info = await stat(path)
  if (!info) return false
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`档案目录冲突：${path}`)
  return true
}

async function safeRead<T>(path: string): Promise<T | null> {
  const info = await stat(path)
  if (!info) return null
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`档案文件冲突：${path}`)
  try { return await readJson(path) }
  catch (error) { throw new Error(`无法读取档案 ${path}，请核对文件内容后重试`, { cause: error }) }
}

async function writeNew(path: string, text: string) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 })
    await link(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

const shortKey = (id: string) => digest(id).slice(0, 12)
const readableKey = (id: string, label: string) => {
  const safe = label.normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '')
  return `${Array.from(safe).slice(0, 30).join('') || '档案'}--${shortKey(id)}`
}

async function namedDirectory(parent: string, id: string, create: boolean, label = id) {
  if (!await safeDirectory(parent, false)) return
  const legacy = join(parent, digest(id))
  if (await safeDirectory(legacy, false)) return legacy
  const names = (await readdir(parent)).filter(name => name.endsWith('--' + shortKey(id)))
  if (names.length > 1) throw new Error(`档案目录标识重复：${parent}`)
  const path = join(parent, names[0] ?? readableKey(id, label))
  if (await safeDirectory(path, create)) return path
}

async function projectDirectory(scope: Omit<ArchiveScope, 'planId'>, create: boolean) {
  const workspace = await realpath(scope.root)
  const docs = join(workspace, 'docs')
  if (!await safeDirectory(docs, create)) return
  const root = join(docs, 'workbench')
  if (!await safeDirectory(root, create)) return
  const path = join(root, 'manifest.json')
  const manifest = await safeRead<typeof archiveManifest>(path)
  if (manifest && manifest.archiveVersion !== archiveManifest.archiveVersion) {
    throw new Error(`不支持档案格式 v${manifest.archiveVersion}（${path}），请安装支持该格式的插件`)
  }
  if (create) {
    await lock(root, async () => {
      if (!await safeRead(path)) await atomicJson(path, archiveManifest)
      const readme = join(root, 'README.md')
      const info = await stat(readme)
      if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error(`档案文件冲突：${readme}`)
      if (!info) await writeNew(readme, archiveReadme + '\n')
    })
  }
  const org = join(root, digest(scope.organization))
  const legacy = join(org, digest(scope.project))
  if (await safeDirectory(org, false) && await safeDirectory(legacy, false)) return legacy
  const identity = { organization: scope.organization, project: scope.project }
  return lock(root, async () => {
    const project = await namedDirectory(root, JSON.stringify([scope.organization, scope.project]), create, scope.projectName || scope.project)
    if (!project) return
    const info = join(project, '.project.json')
    const existing = await safeRead<typeof identity>(info)
    if (existing && (existing.organization !== scope.organization || existing.project !== scope.project)) {
      throw new Error(`档案项目标识冲突：${project}`)
    }
    if (!existing && create) await atomicJson(info, identity)
    if (existing || create) return project
  })
}

async function directories(path: string) {
  if (!await safeDirectory(path, false)) return []
  return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory() && /(?:^[a-f0-9]{64}$|--[a-f0-9]{12}$)/.test(entry.name))
    .map(entry => entry.name).sort()
}

const matchesDirectory = (name: string, id: string) => name === digest(id) || name.endsWith('--' + shortKey(id))
const archiveFileName = (type: Kind, version: number, format: 'json' | 'md', templateVersion?: number) =>
  `${templateFor(type, templateVersion).title}-v${version}.${format}`
const validDocumentFile = (document: StoredDocument, format: 'json' | 'md') => Number.isSafeInteger(document.version) &&
  document.version > 0 && [archiveFileName(document.type, document.version, format, document.templateVersion),
    `${document.type}-v${document.version}.${format}`].includes(document.file)

async function rebuild(project: string, scope: Omit<ArchiveScope, 'planId'>) {
  const plans = join(project, 'plans')
  const rows = []
  for (const planKey of await directories(plans)) {
    const folder = join(plans, planKey)
    const plan = await safeRead<PlanManifest>(join(folder, 'plan.json'))
    if (!plan || !matchesDirectory(planKey, plan.id)) continue
    const issues = []
    for (const issueKey of await directories(join(folder, 'issues'))) {
      const manifest = await safeRead<IssueManifest>(join(folder, 'issues', issueKey, 'issue.json'))
      if (manifest && matchesDirectory(issueKey, manifest.id)) issues.push({ ...manifest, folder: `plans/${planKey}/issues/${issueKey}` })
    }
    rows.push({ ...plan, folder: `plans/${planKey}`, issues })
  }
  const folder = relative(await realpath(scope.root), project).split(sep).join('/')
  const index = { version: 1, organization: scope.organization, project: scope.project, folder, plans: rows }
  const path = join(project, 'index.json')
  const previous = await safeRead(path).catch(error => {
    if (error.cause instanceof SyntaxError) return null
    throw error
  })
  if (JSON.stringify(previous) !== JSON.stringify(index)) await atomicJson(path, index)
  return index
}

export function archiveScope(root: string, organization: string, project: string, planId: string, projectName?: string): ArchiveScope {
  return { root, organization, project, planId, projectName }
}

export async function savePlanArchive(scope: ArchiveScope, plan: Plan) {
  if (plan.id !== scope.planId) throw new Error('档案计划与当前计划不符')
  const project = (await projectDirectory(scope, true))!
  await lock(project, async () => {
    const plans = join(project, 'plans')
    await safeDirectory(plans, true)
    const folder = (await namedDirectory(plans, plan.id, true, plan.name))!
    const path = join(folder, 'plan.json')
    const existing = await safeRead<PlanManifest>(path)
    if (existing && existing.id !== plan.id) throw new Error(`档案计划标识冲突：${path}`)
    if ((existing?.revision ?? 0) <= (plan.revision ?? 0)) {
      const { id, name, branch, end, repositoryKey, goal, history, members, delivery, voidedAt, revision } = plan
      const data = { ...existing, id, name, branch, end, repositoryKey, goal, history, members, delivery, voidedAt, revision,
        documents: existing?.documents ?? [] }
      if (JSON.stringify(existing) !== JSON.stringify(data)) await atomicJson(path, data)
    }
    await rebuild(project, scope)
  })
}

export async function archiveIndex(scope: Omit<ArchiveScope, 'planId'>) {
  const project = await projectDirectory(scope, false)
  if (project) return lock(project, () => rebuild(project, scope))
  return { version: 1, organization: scope.organization, project: scope.project, folder: '', plans: [] }
}

export async function assertOpenPlan(scope: ArchiveScope) {
  const project = await projectDirectory(scope, false)
  if (!project) return
  const plans = join(project, 'plans')
  const folder = await namedDirectory(plans, scope.planId, false)
  if (!folder) return
  const manifest = await safeRead<PlanManifest>(join(folder, 'plan.json'))
  if (manifest?.voidedAt) throw new Error('交付计划已作废')
  if (manifest?.documents.some(document => document.type === 'completion' && document.reportStatus === 'final')) {
    throw new Error('交付计划已关闭')
  }
}

export async function saveArchiveDocument(scope: ArchiveScope, issue: ArchiveIssue | undefined, type: Kind, event: string,
  fields: Record<string, unknown>, markdown?: string) {
  const project = (await projectDirectory(scope, true))!
  return lock(project, async () => {
    const planFolder = await namedDirectory(join(project, 'plans'), scope.planId, false)
    if (!planFolder) throw new Error(`档案缺少对应计划：${scope.planId}`)
    const planPath = join(planFolder, 'plan.json')
    const plan = await safeRead<PlanManifest>(planPath)
    if (!plan || plan.id !== scope.planId) throw new Error(`档案缺少对应计划：${planPath}`)
    let folder = planFolder
    let path = planPath
    let manifest: PlanManifest | IssueManifest = plan
    if (issue) {
      const issues = join(planFolder, 'issues')
      await safeDirectory(issues, true)
      const label = [issue.reference || issue.id, issue.title].filter(Boolean).join('-')
      folder = (await namedDirectory(issues, issue.id, true, label))!
      path = join(folder, 'issue.json')
      const existing = await safeRead<IssueManifest>(path)
      if (existing && existing.id !== issue.id) throw new Error(`档案议题标识冲突：${path}`)
      manifest = { ...existing, ...issue, documents: existing?.documents ?? [] }
    }
    const previous = manifest.documents.find(document => document.type === type && document.event === event)
    if (previous) {
      await rebuild(project, scope)
      return previous
    }
    const version = 1 + Math.max(0, ...manifest.documents.filter(document => document.type === type).map(document => document.version))
    const file = archiveFileName(type, version, markdown === undefined ? 'json' : 'md')
    const destination = join(folder, file)
    const checked = validatedDocument(type, destination, {
      ...fields, documentVersion: version, projectId: scope.project, planId: scope.planId, ...(issue && { issueId: issue.id }),
    }, markdown)
    const text = markdown === undefined ? JSON.stringify(checked) + '\n' :
      '---\n' + stringify(Object.fromEntries(Object.entries(checked).filter(([key]) => key !== 'markdown'))) +
      '---\n\n' + markdown.trim() + '\n'
    const info = await stat(destination)
    if (info && (!info.isFile() || info.isSymbolicLink() || await readFile(destination, 'utf8') !== text)) {
      throw new Error(`档案快照冲突：${destination}，请核对原文件后重试`)
    }
    if (!info) await writeNew(destination, text)
    const entry = { event, type, file, version, templateVersion: checked.templateVersion, time: new Date().toISOString(),
      participation: typeof fields.participation === 'string' ? fields.participation : undefined,
      commitSha: typeof fields.commitSha === 'string' ? fields.commitSha : undefined,
      reportStatus: typeof fields.reportStatus === 'string' ? fields.reportStatus : undefined,
      patch: typeof fields.patch === 'string' ? fields.patch : undefined,
      supersedes: Array.isArray(fields.supersedes) ? fields.supersedes : undefined,
      executionSession: typeof fields.executionSession === 'string' ? fields.executionSession : undefined,
      evidence: typeof fields.evidence === 'string' ? fields.evidence : undefined,
      verification: typeof fields.verification === 'string' ? fields.verification : undefined,
      pendingVerification: typeof fields.pendingVerification === 'string' ? fields.pendingVerification : undefined,
    }
    manifest.documents = [...manifest.documents, entry]
    await atomicJson(path, manifest)
    await rebuild(project, scope)
    return entry
  })
}

export async function saveArchiveReviews(scope: ArchiveScope, issue: ArchiveIssue, reviews: unknown[]) {
  const project = (await projectDirectory(scope, false))!
  if (!project) throw new Error('项目档案尚未创建')
  return lock(project, async () => {
    const plan = await namedDirectory(join(project, 'plans'), scope.planId, false)
    const entry = plan && await issueManifestAt(plan, issue.id)
    if (!entry) throw new Error(`档案缺少议题清单：${issue.id}`)
    const { folder, manifest } = entry
    const path = join(folder, 'issue.json')
    const combined = new Map((manifest.reviews ?? []).map(row => [JSON.stringify(row), row]))
    for (const review of reviews) combined.set(JSON.stringify(review), review)
    await atomicJson(path, { ...manifest, reviews: [...combined.values()] })
    await rebuild(project, scope)
  })
}

export async function searchedArchive(scope: Omit<ArchiveScope, 'planId'>, terms: string[], limit = 12) {
  const index = await archiveIndex(scope)
  const project = await projectDirectory(scope, false)
  if (!project) return []
  const needles = terms.map(term => term.trim().toLowerCase()).filter(Boolean)
  const results = []
  const root = index.folder
  const replacements = new Map<string, string[]>()
  for (const plan of index.plans) {
    for (const issue of plan.issues) {
      for (const document of issue.documents) {
        for (const previous of document.supersedes ?? []) {
          replacements.set(previous, [...(replacements.get(previous) ?? []), `${root}/${issue.folder}/${document.file}`])
        }
      }
    }
  }
  for (const plan of index.plans) {
    const planText = [plan.name, plan.goal, plan.id].join(' ').toLowerCase()
    const candidates = [
      ...plan.documents.filter(doc => doc.type === 'completion').slice(-1).map(doc => ({ doc, folder: plan.folder, issue: undefined })),
      ...plan.issues.flatMap(issue => issue.documents.filter(doc => ['research', 'proposal', 'execution'].includes(doc.type))
        .map(doc => ({ doc, folder: issue.folder, issue }))),
    ]
    for (const { doc, folder, issue } of candidates) {
      if (!validDocumentFile(doc, 'md')) continue
      const components = folder.split('/')
      let path = project
      let available = true
      for (const part of components) {
        path = join(path, part)
        if (!await safeDirectory(path, false)) { available = false; break }
      }
      if (!available) continue
      const document = join(path, doc.file)
      const info = await stat(document)
      if (!info?.isFile() || info.isSymbolicLink()) continue
      templateFor(doc.type, doc.templateVersion)
      const text = await readFile(document, 'utf8')
      const sample = [planText, issue?.id, issue?.reference, issue?.module, issue?.title, text].join(' ').toLowerCase()
      const exactIssue = needles.some(needle => issue?.id.toLowerCase() === needle || issue?.reference?.toLowerCase() === needle)
      const score = (exactIssue ? 100 : 0) +
        needles.reduce((value, needle) => value + (sample.includes(needle) ? 1 : 0), 0)
      if (needles.length && !score) continue
      const relative = `${root}/${folder}/${doc.file}`
      results.push({ score, time: doc.time, plan: plan.name, issue: issue?.reference, path: relative,
        type: doc.type, version: doc.version, supersedes: doc.supersedes, supersededBy: replacements.get(relative),
        excerpt: text.slice(0, 4500) })
    }
  }
  return results.sort((left, right) => right.score - left.score || right.time.localeCompare(left.time))
    .slice(0, limit).map(({ score: _score, time: _time, ...result }) => result)
}

export async function readPlanArchiveDocument(scope: ArchiveScope, file: string) {
  const project = await projectDirectory(scope, false)
  if (!project) return
  const folder = await namedDirectory(join(project, 'plans'), scope.planId, false)
  if (folder) {
    const plan = await safeRead<PlanManifest>(join(folder, 'plan.json'))
    const document = plan?.id === scope.planId && plan.documents.find(row => row.type === 'completion' && row.file === file)
    if (!document || !validDocumentFile(document, 'md')) throw new Error('无效的计划报告快照')
    const path = join(folder, file)
    const info = await stat(path)
    if (info?.isFile() && !info.isSymbolicLink()) return readFile(path, 'utf8')
  }
}

function planContainsIssue(plan: PlanManifest, id: string) {
  return plan.members.includes(id) || plan.history?.initialMembers?.includes(id) ||
    plan.history?.changes.some(change => change.issueId === id)
}

async function issueManifestAt(planFolder: string, id: string) {
  const folder = await namedDirectory(join(planFolder, 'issues'), id, false)
  if (!folder) return
  const manifest = await safeRead<IssueManifest>(join(folder, 'issue.json'))
  if (manifest?.id === id) return { folder, manifest }
}

export async function planIssueDocuments(scope: ArchiveScope, id: string) {
  const project = await projectDirectory(scope, false)
  const folder = project && await namedDirectory(join(project, 'plans'), scope.planId, false)
  return folder ? (await issueManifestAt(folder, id))?.manifest.documents ?? [] : []
}

export async function listIssueArchiveDocuments(scope: Omit<ArchiveScope, 'planId'>, id: string) {
  const project = await projectDirectory(scope, false)
  if (!project) return []
  const plans = join(project, 'plans')
  const rows = []
  for (const key of await directories(plans)) {
    const folder = join(plans, key)
    const plan = await safeRead<PlanManifest>(join(folder, 'plan.json'))
    if (!plan || !matchesDirectory(key, plan.id)) continue
    const issue = await issueManifestAt(folder, id)
    if (!issue && !planContainsIssue(plan, id)) continue
    const documents = [
      ...(issue?.manifest.documents ?? []).filter(document => document.type !== 'completion'),
      ...plan.documents.filter(document => document.type === 'completion'),
    ]
    rows.push(...documents.map(({ type, version, time }) => ({
      planId: plan.id, planName: plan.name, type, version, time, title: templateFor(type).title,
    })))
  }
  return rows
}

export async function readIssueArchiveDocument(scope: ArchiveScope, id: string,
  { type, version }: Pick<IssueDocumentKey, 'type' | 'version'>): Promise<IssueDocumentBody> {
  const project = await projectDirectory(scope, false)
  if (!project) throw new Error('测试或交付档案中没有这份文档')
  const folder = await namedDirectory(join(project, 'plans'), scope.planId, false)
  if (!folder) throw new Error('未找到文档所属计划')
  const plan = await safeRead<PlanManifest>(join(folder, 'plan.json'))
  if (plan?.id !== scope.planId) throw new Error('未找到文档所属计划')
  const issue = await issueManifestAt(folder, id)
  const record = type === 'completion' ? (issue || planContainsIssue(plan, id) ? plan : undefined) : issue?.manifest
  const document = record?.documents.find(row => row.type === type && row.version === version)
  if (!document) throw new Error('未找到该议题关联的文档版本')
  const template = templateFor(document.type, document.templateVersion)
  const format = template.format === 'json' ? 'json' : 'markdown'
  if (!validDocumentFile(document, format === 'json' ? 'json' : 'md')) throw new Error('档案文档名与版本不符')
  const path = join(type === 'completion' ? folder : issue!.folder, document.file)
  const info = await stat(path)
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error('档案正文不可读取')
  const body = await readFile(path, 'utf8')
  return { format, body: format === 'markdown' ? body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim() : body }
}
