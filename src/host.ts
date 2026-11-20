import { writingSkill } from './writing-skill.mjs'
import { workbenchWritingSkill } from './workbench-documents.mjs'
import { archiveIndex, archiveScope, assertOpenPlan, listIssueArchiveDocuments, readIssueArchiveDocument, savePlanArchive, searchedArchive } from './workbench-archive.ts'
import { saveCompletion, workbenchCompletion, type CompletionAction } from './workbench-completion.ts'
import { researchSkill } from './research-skill.ts'
import { deliveryOptions, git, mrPreview, mrRepos, submitMr, workspaceRepository, type MrInput } from './merge-request.ts'
import { createMrReviews, reviewSessionPrefix } from './mr-review.ts'
import { availableMrActions, createMrActions } from './mr-actions.ts'
import { issueMaterials } from './issue-materials.ts'
import { createResearch } from './research-prototype.ts'
import { existsSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { checkPlanBranch, planWorktree } from './plan-git.ts'
import { createConnectionSettings, type CredentialStore } from './connection-settings.ts'
import { createHandler, descriptionOf, digest } from './yunxiao.mjs'
import { createWorkflow, executionSkill, label, projectOf } from './workflow.ts'
import type { Details, Issue, IssueDocumentKey, IssueDocuments, IssueKey, Meta, MrRef, Option, Plan, PlanCreate, PlanDetails, PlanKey, PlanRow, Search } from './contracts.ts'
import { createSkillSources } from './skill-sources.ts'
import { createSkillInstallations, skillProjectRoot } from './skill-installations.ts'
import { dshSkillTarget, type SkillSourceInput, type SkillTarget } from './skill-catalog.ts'

export const name = 'dy-yunxiao'
export const inject = ['commands', 'connection', 'workspaceRegistry', 'sessionController', 'agentPresets', 'permissionPresets', 'credentials', 'agents', 'tools']
type Workspace = { id: string; path: string; title: string }
type SessionSummary = {
  sessionId: string
  origin?: 'subagent'
  formatStatus?: 'current' | 'migration-required'
  projections?: { values: { title?: string | null } }
}
type ReviewWait = Awaited<ReturnType<Parameters<typeof createMrReviews>[4]['wait']>>
type Context = {
  emit(event: 'plugin-manager/changed', change: { reason: 'plugin' }): void
  on(event: 'agent/created', listener: (event: { agent: { id: string } }) => void): void
  tools: { guard(check: (execution: { agent?: { id: string } }) => string | undefined): unknown }
  inject(names: string[], install: (scope: { skills: {
    register(skill: typeof executionSkill | typeof writingSkill): unknown
    registerProvider(factory: ReturnType<typeof createSkillInstallations>['provider']): unknown
  } }) => void): unknown
  get?(name: 'sessionSkillCatalog'): { list(request: { sessionId: string }, signal: AbortSignal): Promise<{ skills: { name: string }[] }> } | undefined
  credentials: CredentialStore
  agents: { get(id: string): object | undefined }
  commands: { register(value: { name: string; description: string; input: { hint: string }; handler: ReturnType<typeof createHandler> }): void }
  connection: { fetch: { register(route: {
    path: string; methods: ('GET' | 'HEAD' | 'POST')[]; requestBody: 'buffered'
    fetch(req: Request): Promise<Response>
  }): void } }
  workspaceRegistry: { list(): Workspace[]; get(id: string): Workspace | undefined }
  sessionController: {
    list(input: Record<string, never>, signal: AbortSignal): Promise<{ items: SessionSummary[] }>
    create(input: { sessionId: string; cwd?: string; workspaceId?: string; agentPreset?: string }): Promise<{ sessionId?: string } | undefined>
    prompt(input: { sessionId: string; requestId: string; mode: 'queue'; content: { type: 'text'; text: string }[] }, signal: AbortSignal): Promise<unknown>
    resolveAgent(id: string): Promise<{ agent?: { session: { append(event: string, payload: object): unknown } } }>
    wait(input: { sessionId: string; timeoutMs: number; maxMessages: number }, signal: AbortSignal): Promise<ReviewWait>
  }
  agentPresets: { remoteExportList(): Promise<{ presets: { id: string; name?: string; broken?: string }[] }> }
  permissionPresets: { names: string[]; optionOf(name: string): { label: string }; set(session: unknown, name: string): void }
}

function options(items: { id: string; name?: string; displayName?: string }[]): Option[] {
  return items.filter(row => row.id).map(row => ({ id: row.id, name: label(row) }))
}

type Field = { fieldName?: string; values?: { displayValue?: string; value?: string }[] }
type Workitem = Record<string, unknown> & {
  id: string; serialNumber?: string; subject?: string; categoryId?: string; category?: string
  status?: Option; assignedTo?: Option; priority?: Option | string; gmtCreate?: string | number
  product?: string; planEndDate?: string | number; customFieldValues?: Field[]; logicalStatus?: string
}

function dateLabel(value?: string | number) {
  if (value === undefined || value === '') return ''
  const date = new Date(typeof value === 'string' && /^\d{13}$/.test(value) ? Number(value) : value)
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date)
}

function summarize(item: Workitem, project: string): Issue {
  const field = (name: string) => {
    const value = item.customFieldValues?.find(field => field.fieldName === name)?.values?.[0]
    return value?.displayValue || value?.value
  }
  return {
    id: item.id, project, reference: item.serialNumber || item.id, title: item.subject || '',
    category: item.categoryId || item.category || '',
    state: { id: item.status?.id || '', name: label(item.status) || '未知' },
    owner: label(item.assignedTo),
    product: item.product || field('所属产品') || '',
    priority: typeof item.priority === 'string' ? item.priority : label(item.priority) || field('优先级') || '',
    created: dateLabel(item.gmtCreate), deadline: dateLabel(item.planEndDate ?? field('计划完成时间')),
    url: 'https://devops.aliyun.com/projex/project/' + encodeURIComponent(project) + '/workitem/' + encodeURIComponent(item.id),
  }
}

async function inBatches<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const rows: R[] = []
  for (let i = 0; i < items.length; i += 8) rows.push(...await Promise.all(items.slice(i, i + 8).map(run)))
  return rows
}

export function apply(ctx: Context) {
  const home = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dy-yunxiao')
  const deadlineFields = new Map<string, string>()
  const settings = createConnectionSettings(ctx.credentials)
  const mrActions = createMrActions(settings.client)
  const skillSources = createSkillSources(home)
  const installations = createSkillInstallations(home, id => ctx.agents.get(id), () => {
    // DSH 0.2.2's slash menu uses this forwarded event to drop its per-session catalog cache.
    ctx.emit('plugin-manager/changed', { reason: 'plugin' })
  })
  ctx.on('agent/created', ({ agent }) => { void installations.agentStarted(agent.id).catch(() => {}) })
  ctx.tools.guard(({ agent }) => agent?.id.startsWith(reviewSessionPrefix) ?
    'MR 只读审查会话禁用工具，仅使用宿主提供的 Git 证据。' : undefined)
  ctx.inject(['skills'], scope => {
    scope.skills.register(writingSkill)
    scope.skills.register(workbenchWritingSkill)
    scope.skills.register(executionSkill)
    scope.skills.register(researchSkill)
    scope.skills.registerProvider(installations.provider)
  })
  async function hasSessionSkill(sessionId: string, name: string) {
    try {
      const catalog = ctx.get?.('sessionSkillCatalog')
      if (!catalog) return false
      const result = await catalog.list({ sessionId }, AbortSignal.timeout(10_000))
      return result.skills.some(skill => skill.name === name)
    } catch {
      return false
    }
  }
  async function createTaskSession(input: { sessionId: string; cwd: string; agentPreset: string }) {
    const created = await ctx.sessionController.create(input)
    const { agent } = await ctx.sessionController.resolveAgent(created?.sessionId ?? input.sessionId)
    if (!agent) throw new Error('任务会话未就绪，无法设置完全访问权限')
    ctx.permissionPresets.set(agent.session, 'danger-full-access')
    return created
  }
  const reviews = createMrReviews(home, settings.client, skillSources.list, installations, {
    async create(sessionId, cwd) {
      await createTaskSession({ sessionId, cwd, agentPreset: 'standard' })
    },
    hasSkill: sessionId => hasSessionSkill(sessionId, 'merge-code-review'),
    prompt: (sessionId, text) => ctx.sessionController.prompt({
      sessionId, requestId: sessionId, mode: 'queue', content: [{ type: 'text', text }],
    }, AbortSignal.timeout(60_000)),
    wait: sessionId => ctx.sessionController.wait({ sessionId, timeoutMs: 1200, maxMessages: 1 }, AbortSignal.timeout(5_000)),
  })
  const workflow = createWorkflow({
    home, client: settings.client,
    host: {
      hasExecutionSkill: sessionId => hasSessionSkill(sessionId, executionSkill.name),
      create: createTaskSession,
      prompt: ({ sessionId, requestId, text }) => ctx.sessionController.prompt(
        { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }] }, AbortSignal.timeout(60_000)),
    },
  })

  ctx.commands.register({
    name: 'yunxiao',
    description: '读取、回写和流转云效议题',
    input: { hint: '<read|preview|publish|statuses|transition>' },
    handler: createHandler({ home, clientFactory: settings.client, publication: workflow }),
  })

  function workspace(id: string) {
    const value = ctx.workspaceRegistry.get(id)
    if (!value) throw new Error('请先在 DSH 中注册并选择目标工作区')
    return value
  }

  async function agentSkillTargets(): Promise<SkillTarget[]> {
    const { items } = await ctx.sessionController.list({}, AbortSignal.timeout(10_000))
    return items.filter(item => item.sessionId !== dshSkillTarget.id &&
      item.origin !== 'subagent' && item.formatStatus !== 'migration-required')
      .map(({ sessionId, projections }) => ({
        kind: 'agent', id: sessionId, name: (projections?.values.title?.trim() || '未命名会话') + ' · ' + sessionId.slice(-8),
      }))
  }

  function projectSkillTargets(): SkillTarget[] {
    return ctx.workspaceRegistry.list().map(({ id, title }) => ({ kind: 'project', id, name: title }))
  }

  async function skillTargets(): Promise<SkillTarget[]> {
    return [
      ...projectSkillTargets(),
      ...await agentSkillTargets(),
      dshSkillTarget,
    ]
  }

  async function findSkillTarget(kind: SkillTarget['kind'], id: string) {
    if (kind === 'project') return projectSkillTargets().find(item => item.id === id)
    if (kind !== 'agent') return undefined
    if (id === dshSkillTarget.id) return dshSkillTarget
    return (await agentSkillTargets()).find(item => item.id === id)
  }

  async function meta(): Promise<Meta> {
    const { presets } = await ctx.agentPresets.remoteExportList()
    const result: Meta = {
      projects: [], workspaces: ctx.workspaceRegistry.list().map(item => ({ id: item.id, name: item.title })),
      presets: options(presets.filter(item => !item.broken)),
      permissions: (ctx.permissionPresets?.names ?? []).map(id => ({ id, name: ctx.permissionPresets?.optionOf(id).label || id })),
    }
    try {
      const api = await settings.client()
      const [projects, user] = await Promise.all([api.projects(), api.currentUser()])
      return { ...result, organization: api.organization, defaultProject: api.project, user: user.name, projects: options(projects) }
    } catch (error) {
      return { ...result, setupError: error instanceof Error ? error.message : '连接云效失败' }
    }
  }

  async function search(input: Search) {
    const api = await settings.client()
    const filters: object[] = []
    function add(fieldIdentifier: string, className: string, value: string[], format = 'list') {
      if (value.length) filters.push({ fieldIdentifier, className, value, format, operator: 'CONTAINS', toValue: null })
    }
    const query = input.query.trim()
    if (query) {
      const serial = /^[\w-]+-\d+$/.test(query)
      add(serial ? 'serialNumber' : 'subject', 'string', [serial ? query.toUpperCase() : query], 'input')
    }
    if (input.mine) add('assignedTo', 'user', [(await api.currentUser()).id])
    add('status', 'status', input.status)
    add('version', 'version', input.version)
    const field = deadlineFields.get(input.project)
    if (field && (input.from || input.to)) {
      const bound = (value: string, end: boolean) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('请输入有效的计划完成日期')
        return String(Date.parse(value + (end ? 'T23:59:59.999+08:00' : 'T00:00:00+08:00')))
      }
      const value = [input.from && bound(input.from, false), input.to && bound(input.to, true)].filter(Boolean)
      filters.push({ fieldIdentifier: field, className: 'date', format: 'input',
        operator: value.length === 2 ? 'BETWEEN' : input.from ? 'GTE' : 'LTE', toValue: null, value })
    }
    const [items, plans] = await Promise.all([
      api.search(input.project, input.category || 'Req,Bug,Task', [filters], input.page),
      input.workspaceId ? workflow.plans(workspace(input.workspaceId).path, input.project, api.organization) : [],
    ])
    const rows = await Promise.all(items.map(async item => {
      const row = summarize(item, input.project)
      const plan = plans.find(plan => plan.members.includes(row.id))
      row.plan = plan?.name
      row.planId = plan?.id
      if (input.workspaceId) {
        const binding = await workflow.bindingFor(workspace(input.workspaceId).path, row, api.organization)
        if (binding?.dispatched) row.sessionId = binding.sessionId
      }
      return row
    }))
    return { rows, more: items.length === 50 }
  }

  async function detail(input: IssueKey & { workspaceId: string }): Promise<Details> {
    const api = await settings.client()
    const item = await api.get(input.id)
    if (projectOf(item) && projectOf(item) !== input.project) throw new Error('议题不属于当前云效项目')
    const root = input.workspaceId ? workspace(input.workspaceId).path : undefined
    const [plans, materials, transition] = await Promise.all([
      root ? workflow.plans(root, input.project, api.organization) : [],
      issueMaterials(api, item.id, descriptionOf(item)),
      workflow.pendingTransition(input, api),
    ])
    const plan = plans.find(plan => plan.members.includes(input.id))
    const binding = root ? await workflow.bindingFor(root, { ...input, planId: plan?.id }, api.organization) : null
    return { ...summarize(item, input.project), ...materials, plan: plan?.name, planId: plan?.id,
      sessionId: binding?.dispatched ? binding.sessionId : undefined, pendingTarget: transition?.target }
  }

  type Client = Awaited<ReturnType<typeof settings.client>>
  function planDirectory(input: PlanKey) {
    return workspace(input.workspaceId).path
  }
  async function readPlan(api: Client, input: PlanKey) {
    const plan = (await workflow.plans(planDirectory(input), input.project, api.organization)).find(row => row.id === input.planId)
    if (!plan) throw new Error('当前工作区没有该交付计划')
    return plan
  }
  function updateDelivery(api: Client, input: PlanKey, update: Parameters<typeof workflow.updateDelivery>[4]) {
    return workflow.updateDelivery(planDirectory(input), input.project, api.organization, input.planId, update)
  }
  async function planRows(api: Client, filter: { project?: string; workspaceId?: string } = {}, includeVoided = false): Promise<PlanRow[]> {
    const projects = options(await api.projects()).filter(project => !filter.project || project.id === filter.project)
    const workspaces = filter.workspaceId ? [workspace(filter.workspaceId)] : ctx.workspaceRegistry.list()
    const scopes = workspaces.flatMap(target => projects.map(project => ({ target, project })))
    const list = includeVoided ? workflow.allPlans : workflow.plans
    const groups = await inBatches(scopes, async ({ target, project }) =>
      (await list(target.path, project.id, api.organization)).map(plan => ({
        plan, planId: plan.id, project: project.id, projectName: project.name, workspaceId: target.id, workspaceName: target.title,
      })))
    return groups.flat().sort((a, b) => a.plan.end.localeCompare(b.plan.end) || a.plan.name.localeCompare(b.plan.name))
  }
  function requireDelivery(plan: Plan) {
    if (!plan.delivery) throw new Error('请先配置计划仓库和目标分支')
    return plan.delivery
  }
  async function deliveryWorktree(input: PlanKey, plan: Plan, key: string) {
    if (!plan.worktree) return
    const repository = await workspaceRepository(planDirectory(input), key)
    return planWorktree(repository, plan.worktree)
  }
  async function planDetails(api: Client, input: PlanKey): Promise<PlanDetails> {
    const plan = await readPlan(api, input)
    const delivery = plan.delivery
    const mrState = async () => {
      if (!delivery) return { candidates: [] }
      try {
        if (delivery.mr) return { candidates: [], mrStatus: (await api.codeup.detail(delivery.mr)).status }
        const existing = await api.codeup.openForSource(delivery.repositoryId, plan.branch)
        return { candidates: existing.filter(mr => mr.target === delivery.target) }
      } catch (error) {
        return { candidates: [], mrError: error instanceof Error ? error.message : String(error) }
      }
    }
    const archive = await archiveIndex(reportScope(api, input)).then(index => ({
      plan: index.plans.find(entry => entry.id === plan.id), error: undefined,
    }), error => ({ plan: undefined, error: error instanceof Error ? error.message : String(error) }))
    const [issues, state] = await Promise.all([inBatches(plan.members, async id => {
      try {
        const item = await api.get(id)
        if (projectOf(item) && projectOf(item) !== input.project) throw new Error('议题不属于当前云效项目')
        const binding = await workflow.bindingFor(planDirectory(input), { project: input.project, planId: plan.id, id }, api.organization)
        return { ...summarize(item, input.project), sessionId: binding?.dispatched ? binding.sessionId : undefined,
          dispatchedVersion: binding?.dispatched ? binding.planVersion : undefined,
          executionStage: binding?.dispatched ? await workflow.executionProgress(binding,
            archive.plan?.issues.find(issue => issue.id === id)?.documents ?? []) : undefined,
          executionVersion: !binding?.dispatched && binding?.planId === plan.id ? binding.planVersion : undefined }
      } catch {
        return { id, reference: id, title: '', owner: '', state: { id: '', name: '' }, url: '', error: '议题读取失败' }
      }
    }), mrState()])
    return { plan, issues, ...state, archiveError: archive.error, executionSupported: true }
  }

  const researchDirectory = join(home, 'research')
  const research = createResearch(ctx.sessionController, researchDirectory, createTaskSession, hasSessionSkill)
  function researchBatch(organization: string, input: PlanKey) {
    const current = digest(JSON.stringify([organization, realpathSync(planDirectory(input)), input.project, input.planId]))
    const legacy = digest(JSON.stringify([organization, input.workspaceId, input.project, input.planId]))
    return !existsSync(join(researchDirectory, current + '.json')) && existsSync(join(researchDirectory, legacy + '.json'))
      ? legacy : current
  }
  async function planCheckout(input: PlanKey, plan: Plan) {
    const key = plan.repositoryKey || plan.delivery?.key
    const root = planDirectory(input)
    const repo = key ? await workspaceRepository(root, key) : root
    return plan.worktree ? planWorktree(repo, plan.worktree) : repo
  }
  const reviewActor = () => settings.client().then(api => api.currentUser()).then(user => user.name || String(user.id), () => undefined)
  const reportScope = (api: Client, input: PlanKey) => archiveScope(planDirectory(input), api.organization, input.project, input.planId)
  async function draftCompletion(api: Client, input: PlanKey) {
    const scope = reportScope(api, input)
    return workflow.withPlan(scope.root, scope.project, scope.organization, scope.planId,
      plan => saveCompletion(scope, plan, api, 'draft'))
  }

  const methods = {
    async planResearch(input: PlanKey & { start?: boolean }) {
      const api = await settings.client()
      const plan = await readPlan(api, input)
      const batchId = researchBatch(api.organization, input)
      const rows = research.status({ batchId }).filter(row => row.issueId && plan.members.includes(row.issueId))
      if (!input.start) return { batchId, rows }
      const cwd = await planCheckout(input, plan)
      const scope = archiveScope(realpathSync(planDirectory(input)), api.organization, input.project, plan.id)
      await assertOpenPlan(scope)
      await savePlanArchive(scope, plan)
      const missing = plan.members.filter(id => !rows.some(r => r.issueId === id && (r.status !== 'failed' || r.drafts.length)))
      const inputs = await inBatches(missing, async id => {
        const item = await detail({ ...input, id })
        const keywords = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(item.title)]
          .filter(word => word.isWordLike && word.segment.length > 1).slice(0, 10).map(word => word.segment)
        const hints = await searchedArchive(scope, [id, item.reference, item.product, item.title, ...keywords])
        return { id, title: item.reference + ' ' + item.title,
          text: [item.text, item.materialsError,
            '历史档案索引（按当前项目查找，若无相关材料请记录缺口）：' + JSON.stringify(hints)].filter(Boolean).join('\n'),
          archive: { scope, issue: { id, reference: item.reference, title: item.title, module: item.product },
            historicalPaths: hints.map(hint => hint.path), participation: plan.history?.changes.findLast(change =>
              change.issueId === id && ['initial', 'added'].includes(change.kind))?.id } }
      })
      await workflow.withPlan(scope.root, scope.project, scope.organization, scope.planId, async current => {
        await assertOpenPlan(scope)
        research.start(cwd, inputs.filter(issue => current.members.includes(issue.id)), batchId)
      })
      return { batchId, rows: research.status({ batchId }).filter(row => row.issueId && plan.members.includes(row.issueId)) }
    },
    async executePlanIssue(input: PlanKey & { id: string; version: number }) {
      const binding = await workflow.executePlan(planDirectory(input), input, async (plan, organization) => {
        const cwd = await planCheckout(input, plan)
        if (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true) !== plan.branch) {
          throw new Error('请在计划的代码目录检出源分支「' + plan.branch + '」后再执行')
        }
        const researchRow = research.status({ batchId: researchBatch(organization, input) }).find(row => row.issueId === input.id)
        return { cwd, version: input.version, approvedProposalVersion: researchRow?.drafts[input.version - 1]?.proposalVersion,
          readDraft: () => research.finalizedDraft(researchBatch(organization, input), input.id, input.version) }
      })
      return { sessionId: binding.sessionId }
    },
    archivePlanExecution(input: PlanKey & { id: string; commit?: string }) {
      return workflow.archiveExecution(planDirectory(input), input)
    },
    researchStatus: research.status,
    researchSummaries: research.summaries,
    async researchSubmit(input: Parameters<typeof research.submit>[0]) {
      const result = research.submit({ ...input, actor: await reviewActor() })
      await research.archiveReviews(input.batchId, input.sessionId)
      return result
    },
    async researchFinalize(input: Parameters<typeof research.finalize>[0]) {
      const result = research.finalize({ ...input, actor: await reviewActor() })
      await research.archiveReviews(input.batchId, input.sessionId)
      return result
    },
    async researchRevise(input: Parameters<typeof research.revise>[0]) {
      const result = research.revise({ ...input, actor: await reviewActor() })
      await research.archiveReviews(input.batchId, input.sessionId)
      return result
    },
    async searchWorkbenchArchive(input: { project: string; workspaceId: string; query: string }) {
      const api = await settings.client()
      if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 200) throw new Error('请输入档案检索关键词')
      return searchedArchive({ root: workspace(input.workspaceId).path, organization: api.organization, project: input.project },
        input.query.split(/\s+/))
    },
    async issueDocuments(input: IssueKey): Promise<IssueDocuments> {
      const api = await settings.client()
      const workspaces = ctx.workspaceRegistry.list()
      const groups = await inBatches(workspaces, async target => {
        try {
          const documents = await listIssueArchiveDocuments({ root: target.path, organization: api.organization, project: input.project }, input.id)
          return { documents: documents.map(document => ({ ...document, workspaceId: target.id, workspaceName: target.title })) }
        } catch (error) {
          return { documents: [], error: `${target.title} · ${error instanceof Error ? error.message : String(error)}` }
        }
      })
      return {
        documents: groups.flatMap(group => group.documents).sort((a, b) => b.time.localeCompare(a.time) || b.version - a.version),
        errors: groups.flatMap(group => group.error ? [group.error] : []),
      }
    },
    async issueDocument(input: IssueKey & IssueDocumentKey) {
      const api = await settings.client()
      return readIssueArchiveDocument(reportScope(api, input), input.id, input)
    },
    async planCompletion(input: PlanKey) {
      return workbenchCompletion(reportScope(await settings.client(), input))
    },
    async refreshPlanArchive(input: PlanKey) {
      const api = await settings.client()
      await savePlanArchive(reportScope(api, input), await readPlan(api, input))
      return { saved: true }
    },
    async updatePlanCompletion(input: PlanKey & { action: CompletionAction; note?: string }) {
      const api = await settings.client()
      const scope = reportScope(api, input)
      return workflow.withPlan(scope.root, scope.project, scope.organization, scope.planId, plan =>
        saveCompletion(scope, plan, api, input.action, typeof input.note === 'string' ? input.note.slice(0, 5000) : ''))
    },
    pullMrSnapshot: reviews.pull,
    cancelMrSnapshotPull: reviews.cancelPull,
    startMrReview: reviews.start,
    mrReview: reviews.status,
    publishMrReviewComment: reviews.publish,
    previewMrAction: mrActions.preview,
    submitMrAction: mrActions.submit,
    checkMrAction: mrActions.check,
    mrRepos: ({ workspaceId }: { workspaceId: string }) => mrRepos(workspace(workspaceId).path),
    async mrPreview({ workspaceId, key }: { workspaceId: string; key: string }) {
      return mrPreview(workspace(workspaceId).path, key, (await settings.client()).codeup)
    },
    async planMrPreview(input: PlanKey) {
      const api = await settings.client()
      const plan = await readPlan(api, input)
      const { key } = requireDelivery(plan)
      return mrPreview(planDirectory(input), key, api.codeup, await deliveryWorktree(input, plan, key))
    },
    async mrReviewerCandidates({ repositoryId, target }: { repositoryId: number; target: string }) {
      return (await settings.client()).codeup.reviewerCandidates(repositoryId, target)
    },
    async submitMr(input: MrInput) {
      return submitMr(workspace(input.workspaceId).path, input, (await settings.client()).codeup)
    },
    async workbenchPlans(filter: { project?: string; workspaceId?: string }) {
      const api = await settings.client()
      return inBatches(await planRows(api, filter, true), async row => {
        const mr = row.plan.delivery?.mr
        if (!mr) return row
        const status = await api.codeup.detail(mr).then(result => result.status, () => 'UNAVAILABLE')
        return { ...row, mrStatus: status || 'UNAVAILABLE' }
      })
    },
    async voidPlan(input: PlanKey) {
      const api = await settings.client()
      return workflow.voidPlan(planDirectory(input), input.project, api.organization, input.planId)
    },
    async workbenchPlan(input: PlanKey) {
      return planDetails(await settings.client(), input)
    },
    async planDeliveryOptions(input: PlanKey & { key: string }) {
      const api = await settings.client()
      const plan = await readPlan(api, input)
      return deliveryOptions(planDirectory(input), input.key, plan.branch, api.codeup)
    },
    async bindPlanDelivery(input: PlanKey & { key: string; repositoryId: number; target: string }) {
      const api = await settings.client()
      return updateDelivery(api, input, async plan => {
        if (plan.delivery?.mr) throw new Error('交付分支已有合并请求，无法修改绑定')
        if (plan.kind && plan.repositoryKey !== input.key) throw new Error('请选择计划创建时的仓库')
        const { repository, targets } = await deliveryOptions(planDirectory(input), input.key, plan.branch, api.codeup)
        if (repository.id !== input.repositoryId || !targets.includes(input.target)) throw new Error('仓库或目标分支已变化，请重新选择')
        return { key: input.key, repositoryId: repository.id, path: repository.path, target: input.target }
      })
    },
    async linkPlanMr(input: PlanKey & MrRef) {
      const api = await settings.client()
      const result = await updateDelivery(api, input, async plan => {
        const delivery = requireDelivery(plan)
        if (delivery.repositoryId !== input.repositoryId) throw new Error('计划仓库已变化，请刷新')
        if (delivery.mr?.localId === input.localId) return delivery
        if (delivery.mr) throw new Error('交付分支已关联其他合并请求')
        const matches = await api.codeup.openForSource(delivery.repositoryId, plan.branch)
        if (!matches.some(mr => mr.localId === input.localId && mr.target === delivery.target)) {
          throw new Error('该开放 MR 与计划的仓库、源分支或目标分支不匹配，请刷新计划')
        }
        return { ...delivery, mr: { repositoryId: delivery.repositoryId, localId: input.localId } }
      })
      try { await draftCompletion(api, input) }
      catch (error) { return { ...result, reportError: error instanceof Error ? error.message : String(error) } }
      return result
    },
    async submitPlanMr(input: PlanKey & MrInput) {
      const api = await settings.client()
      const delivery = await updateDelivery(api, input, async plan => {
        const binding = requireDelivery(plan)
        if (input.repositoryId !== binding.repositoryId || input.key !== binding.key ||
          input.branch !== plan.branch || input.target !== binding.target) throw new Error('计划分支已变化，请刷新后重试')
        if (binding.mr) return binding
        const directory = await deliveryWorktree(input, plan, binding.key)
        const result = await submitMr(planDirectory(input), input, api.codeup, directory)
        return { ...binding, mr: { repositoryId: binding.repositoryId, localId: result.localId } }
      })
      try { await draftCompletion(api, input) }
      catch (error) { return { ...delivery.mr!, reportError: error instanceof Error ? error.message : String(error) } }
      return delivery.mr!
    },
    async workbenchMrs(input: { queue: 'mine' | 'review' | 'all'; page: number; repository: string }) {
      if (!['mine', 'review', 'all'].includes(input.queue) || !Number.isSafeInteger(input.page) || input.page < 1 ||
        typeof input.repository !== 'string' || input.repository.length > 256) throw new Error('无效的合并请求筛选条件')
      const api = await settings.client()
      const user = input.queue === 'all' ? undefined : await api.currentUser()
      const result = await api.codeup.list({ page: input.page, repository: input.repository.trim(),
        authorId: input.queue === 'mine' ? user?.id : undefined, reviewerId: input.queue === 'review' ? user?.id : undefined })
      return { ...result, user: user?.name }
    },
    async workbenchMr(input: MrRef) {
      const api = await settings.client()
      const [mr, plans, actor] = await Promise.all([
        api.codeup.detail(input),
        planRows(api).then(rows => ({
          rows: rows.filter(row => row.plan.delivery?.mr?.repositoryId === input.repositoryId &&
            row.plan.delivery.mr.localId === input.localId), error: '',
        }), () => ({ rows: [], error: '关联计划读取失败' })),
        api.currentUser().catch(() => undefined),
      ])
      return { mr, plans: plans.rows, planError: plans.error, reviewSupported: true,
        actions: actor ? availableMrActions(mr, String(actor.id)) : [] }
    },
    skillSources: skillSources.list,
    bindSkillSource: (input: SkillSourceInput) => skillSources.bind(input),
    refreshSkillSource: ({ id }: { id: string }) => skillSources.refresh(id),
    renameSkillSource: ({ id, name }: { id: string; name: string }) => skillSources.rename(id, name),
    unbindSkillSource: ({ id }: { id: string }) => skillSources.unbind(id),
    skillTargets,
    skillInstallations: installations.list,
    async installSkill(input: { sourceId: string; path: string; readAt: string; targetKind: SkillTarget['kind']; targetId: string }) {
      const source = skillSources.list().find(item => item.id === input.sourceId)
      const skill = source?.skills.find(item => item.path === input.path)
      if (!source || !skill || skill.readAt !== input.readAt) throw new Error('技能目录已更新，请重新读取后安装')
      const target = await findSkillTarget(input.targetKind, input.targetId)
      if (!target) throw new Error('请选择仍然可用的项目或会话 Agent')
      if (target.kind === 'project') {
        const { root } = await skillProjectRoot(workspace(target.id).path)
        await installations.install(source, skill, { ...target, directory: root })
      } else {
        if (target.id !== dshSkillTarget.id && !ctx.agents.get(target.id)) {
          const { agent } = await ctx.sessionController.resolveAgent(target.id)
          if (!agent) throw new Error('无法启动所选会话的 Agent，请先在 DSH 中打开该会话')
        }
        await installations.install(source, skill, target)
      }
      return installations.list()
    },
    async uninstallSkill({ id }: { id: string }) {
      await installations.uninstall(id)
      return installations.list()
    },
    meta, search, detail,
    connectionSettings: settings.describe,
    connectionOrganizations: settings.organizations,
    connectionProjects: settings.projects,
    testConnection: settings.test,
    async saveConnection(input: Parameters<typeof settings.save>[0]) {
      await settings.save(input)
      deadlineFields.clear()
    },
    async clearConnection() {
      await settings.clear()
      deadlineFields.clear()
    },
    async filters({ project }: IssueKey) {
      const values = await (await settings.client()).filters(project)
      const deadlines = [...new Set<string>(values.fields.filter(field => field.name === '计划完成时间').map(field => field.id).filter(Boolean))]
      if (deadlines.length === 1) deadlineFields.set(project, deadlines[0])
      else deadlineFields.delete(project)
      const products = values.fields.filter(field => field.name === '所属产品')
        .flatMap(field => Array.isArray(field.options) ? field.options : [])
        .map(item => typeof item === 'string' ? item : label(item)).filter(Boolean)
      return { statuses: options(values.statuses), versions: options(values.versions), products: [...new Set<string>(products)] }
    },
    preview(input: IssueKey & { workspaceId: string; planId?: string; regenerate?: boolean }) {
      return workflow.preview(workspace(input.workspaceId).path, input, input.regenerate)
    },
    publish(input: IssueKey & { workspaceId: string; planId?: string; code: string; sections: string[] }) {
      return workflow.publish(workspace(input.workspaceId).path, input, input.code, input.sections)
    },
    async statuses(input: IssueKey) {
      const api = await settings.client()
      const issue = await api.get(input.id)
      if (projectOf(issue) && projectOf(issue) !== input.project) throw new Error('议题不属于当前云效项目')
      return { current: { id: issue.status?.id, name: label(issue.status) }, options: options(await api.statuses(input.id)) }
    },
    transition(input: IssueKey & { current: string; target: string }) {
      return workflow.transition(input, input.current, input.target)
    },
    checkTransition: workflow.checkTransition,
    plans(input: { project: string; workspaceId: string }) {
      return workflow.plans(workspace(input.workspaceId).path, input.project)
    },
    async planRepositories({ workspaceId }: { workspaceId: string }) {
      const cwd = workspace(workspaceId).path
      return { repositories: await mrRepos(cwd), worktreeDir: join(dirname(cwd), basename(cwd) + '-worktrees') }
    },
    async planVersions({ project }: { project: string }) {
      return options(await (await settings.client()).versions(project))
    },
    async checkPlanBranch(input: { workspaceId: string; repositoryKey: string; branch: string }) {
      if (typeof input.branch !== 'string') throw new Error('请输入源分支')
      const directory = await workspaceRepository(workspace(input.workspaceId).path, input.repositoryKey)
      return checkPlanBranch(directory, input.branch.trim())
    },
    async createPlan(input: { project: string; workspaceId: string; repositoryKey?: string } &
      (PlanCreate | Pick<Plan, 'name' | 'branch' | 'end' | 'goal'>)) {
      const cwd = workspace(input.workspaceId).path
      const key = input.repositoryKey || ('kind' in input ? '.' : '')
      const repository = key ? { key, directory: await workspaceRepository(cwd, key) } : undefined
      return workflow.createPlan(cwd, input.project, input, repository)
    },
    addToPlan(input: PlanKey & { ids: string[]; reason?: string; initial?: boolean }) {
      if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 100) throw new Error('每批可选 1 到 100 条议题')
      return workflow.addToPlan(workspace(input.workspaceId).path, input.project, input.planId, input.ids,
        typeof input.reason === 'string' ? input.reason.slice(0, 1000) : '', input.initial === true)
    },
    async removeFromPlan(input: PlanKey & { id: string; reason?: string; defer?: boolean }) {
      const api = await settings.client()
      await workflow.removeFromPlan(workspace(input.workspaceId).path, input.project, input.planId, input.id,
        typeof input.reason === 'string' ? input.reason.slice(0, 1000) : '', input.defer === true)
      if (!input.defer) research.retire(researchBatch(api.organization, input), input.id)
      return { removed: true }
    },
  }

  const noStore = { 'Cache-Control': 'no-store' }
  ctx.connection.fetch.register({
    path: '/api/dy-yunxiao', methods: ['POST'], requestBody: 'buffered',
    async fetch(req) {
      if (req.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        return Response.json({ error: '云效请求需要 JSON 内容' }, { status: 415, headers: noStore })
      }
      try {
        const bytes = await req.arrayBuffer()
        if (bytes.byteLength > 256 * 1024) throw new Error('请求内容过长')
        const { method, input } = JSON.parse(new TextDecoder().decode(bytes))
        if (typeof method !== 'string' || !Object.hasOwn(methods, method)) throw new Error('未知云效操作')
        const value = await methods[method as keyof typeof methods](input)
        return Response.json({ value: value ?? null }, { headers: noStore })
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : '操作失败' }, { status: 400, headers: noStore })
      }
    },
  })
  ctx.connection.fetch.register({
    path: '/api/dy-yunxiao/panel.css', methods: ['GET', 'HEAD'], requestBody: 'buffered',
    async fetch(req) {
      const content = await readFile(new URL('./panel.css', import.meta.url), 'utf8')
      return new Response(req.method === 'HEAD' ? null : content, {
        headers: { ...noStore, 'Content-Type': 'text/css; charset=utf-8' },
      })
    },
  })
}
