import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createClient } from './yunxiao-client.mjs'
import { createHandler, descriptionOf } from './yunxiao.mjs'
import { createWorkflow, label, projectOf } from './workflow.ts'
import type { Details, Issue, IssueKey, Meta, Option, Search } from './contracts.ts'

export const name = 'dy-yunxiao'
export const inject = ['commands', 'webServer', 'connection', 'workspaceRegistry', 'sessionController', 'agentPresets', 'permissionPresets']
type Request = IncomingMessage
type Response = ServerResponse
type Workspace = { id: string; path: string; title: string }
type Context = {
  commands: { register(value: { name: string; description: string; input: { hint: string }; handler: ReturnType<typeof createHandler> }): void }
  webServer: { register(value: { kind: 'exact'; path: string; handler(req: Request, res: Response): Promise<void> }): void }
  connection: { requestRejection(req: Request): number | undefined }
  workspaceRegistry: { list(): Workspace[]; get(id: string): Workspace | undefined }
  sessionController: {
    create(input: { sessionId: string; cwd?: string; workspaceId?: string; agentPreset?: string }): Promise<unknown>
    prompt(input: { sessionId: string; requestId: string; mode: 'queue'; content: { type: 'text'; text: string }[] }, signal: AbortSignal): Promise<unknown>
    resolveAgent(id: string): Promise<{ agent?: { session: unknown } }>
  }
  agentPresets: { remoteExportList(): Promise<{ presets: { id: string; name?: string; broken?: string }[] }> }
  permissionPresets?: { names: string[]; optionOf(name: string): { label: string }; set(session: unknown, name: string): void }
}

function options(items: { id: string; name?: string; displayName?: string }[]): Option[] {
  return items.filter(row => row.id).map(row => ({ id: row.id, name: label(row) }))
}

function webUrl(value: unknown) {
  if (typeof value !== 'string') return ''
  try {
    return new URL(value).protocol === 'https:' ? value : ''
  } catch {
    return ''
  }
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

async function json(req: Request) {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 256 * 1024) throw new Error('请求内容过长')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function apply(ctx: Context) {
  const home = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dy-yunxiao')
  const recentIssues = new Map<string, Issue>()
  const deadlineFields = new Map<string, string>()
  const workflow = createWorkflow({
    home, client: createClient,
    host: {
      create: ({ sessionId, cwd, workspaceId, agentPreset }) => ctx.sessionController.create({
        sessionId, agentPreset, ...(workspaceId ? { workspaceId } : { cwd }),
      }),
      async prompt({ sessionId, requestId, text, permission }) {
        if (permission) {
          const owner = await ctx.sessionController.resolveAgent(sessionId)
          if (!owner.agent || !ctx.permissionPresets?.names.includes(permission)) throw new Error('指定权限不可用')
          ctx.permissionPresets.set(owner.agent.session, permission)
        }
        await ctx.sessionController.prompt({ sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }] },
          AbortSignal.timeout(60_000))
      },
    },
  })

  ctx.commands.register({
    name: 'yunxiao',
    description: '读取、开工、回写和流转云效议题',
    input: { hint: '<read|start|preview|publish|statuses|transition>' },
    handler: createHandler({ home, startBound: workflow.start, publication: workflow }),
  })

  function workspace(id: string) {
    const value = ctx.workspaceRegistry.get(id)
    if (!value) throw new Error('请先在 DSH 中注册并选择目标工作区')
    return value
  }

  async function meta(): Promise<Meta> {
    const { presets } = await ctx.agentPresets.remoteExportList()
    const result: Meta = {
      projects: [], workspaces: ctx.workspaceRegistry.list().map(item => ({ id: item.id, name: item.title })),
      presets: options(presets.filter(item => !item.broken)),
      permissions: (ctx.permissionPresets?.names ?? []).map(id => ({ id, name: ctx.permissionPresets?.optionOf(id).label || id })),
    }
    try {
      const api = createClient()
      const [projects, user] = await Promise.all([api.projects(), api.currentUser()])
      return { ...result, organization: api.organization, defaultProject: api.project, user: user.name, projects: options(projects) }
    } catch (error) {
      return { ...result, setupError: error instanceof Error ? error.message : '连接云效失败' }
    }
  }

  async function search(input: Search) {
    const api = createClient()
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
      input.workspaceId ? workflow.plans(workspace(input.workspaceId).path, input.project) : [],
    ])
    const rows = await Promise.all(items.map(async item => {
      const row = summarize(item, input.project)
      row.plan = plans.find(plan => plan.members.includes(row.id))?.name
      const rowKey = JSON.stringify([api.organization, row.project, row.id])
      recentIssues.set(rowKey, row)
      if (recentIssues.size > 1000) recentIssues.delete(recentIssues.keys().next().value!)
      if (input.workspaceId) {
        const binding = await workflow.bindingFor(workspace(input.workspaceId).path, row)
        if (binding?.dispatched) row.sessionId = binding.sessionId
      }
      return row
    }))
    return { rows, more: items.length === 50 }
  }

  async function detail(input: IssueKey & { workspaceId: string }): Promise<Details> {
    const api = createClient()
    const item = await api.get(input.id)
    if (projectOf(item) && projectOf(item) !== input.project) throw new Error('议题不属于当前云效项目')
    const binding = input.workspaceId ? await workflow.bindingFor(workspace(input.workspaceId).path, input) : null
    const source = descriptionOf(item)
    const text = source.replace(/<\/?(?:div|p|li|br|h[1-6])\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '')
      .replace(/&(amp|nbsp|lt|gt|quot|#39);/g, (_match: string, key: string) => ({ amp: '&', nbsp: ' ', lt: '<', gt: '>', quot: '"', '#39': "'" })[key] || '')
      .trim()
    let materialsError: string | undefined
    const files: Details['files'] = []
    const seen = new Set<string>()
    try {
      for (const file of await api.attachments(item.id, undefined)) {
        seen.add(file.fileId)
        const fileName = file.fileName || file.fileId
        files.push({ name: fileName, url: webUrl(file.url), image: /\.(png|jpe?g|gif|webp)$/i.test(fileName) })
      }
    } catch {
      materialsError = '议题附件读取失败，可重试或填补充后开工'
    }
    const ids = [...new Set([...source.matchAll(/fileIdentifier=([\w-]+)/g)].map(match => match[1]))].slice(0, 30)
    for (const id of ids.filter(id => !seen.has(id))) {
      try {
        const file = await api.file(item.id, id, undefined)
        files.push({ name: file.name || file.fileName || id, url: webUrl(file.url), image: true })
      } catch {
        materialsError = '部分正文图片无法读取，可在云效查看'
      }
    }
    return { ...summarize(item, input.project), text, files, materialsError, sessionId: binding?.dispatched ? binding.sessionId : undefined, preparedSessionId: binding?.prepared && !binding.dispatched ? binding.sessionId : undefined, pendingTarget: (await workflow.pendingTransition(input))?.target }
  }

  const methods = {
    meta, search, detail,
    async filters({ project }: IssueKey) {
      const values = await createClient().filters(project)
      const deadlines = [...new Set<string>(values.fields.filter(field => field.name === '计划完成时间').map(field => field.id).filter(Boolean))]
      if (deadlines.length === 1) deadlineFields.set(project, deadlines[0])
      else deadlineFields.delete(project)
      const products = values.fields.filter(field => field.name === '所属产品')
        .flatMap(field => Array.isArray(field.options) ? field.options : [])
        .map(item => typeof item === 'string' ? item : label(item)).filter(Boolean)
      return { statuses: options(values.statuses), versions: options(values.versions), products: [...new Set<string>(products)] }
    },
    async start(input: IssueKey & { workspaceId: string; notes: string; clarify: boolean; preset?: string; permission?: string }) {
      const target = workspace(input.workspaceId)
      if (input.permission && !ctx.permissionPresets?.names.includes(input.permission)) throw new Error('指定权限不可用')
      const row = recentIssues.get(JSON.stringify([createClient().organization, input.project, input.id]))
      const result = await workflow.start({
        id: input.id, project: input.project, cwd: target.path, workspaceId: target.id,
        preset: input.preset, permission: input.permission, notes: input.notes, clarify: input.clarify,
        verifiedListItem: row,
      })
      return { sessionId: result.sessionId }
    },
    preview(input: IssueKey & { workspaceId: string; regenerate?: boolean }) {
      return workflow.preview(workspace(input.workspaceId).path, input, input.regenerate)
    },
    publish(input: IssueKey & { workspaceId: string; code: string; sections: string[] }) {
      return workflow.publish(workspace(input.workspaceId).path, input, input.code, input.sections)
    },
    async statuses(input: IssueKey) {
      const api = createClient()
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
    createPlan(input: { project: string; workspaceId: string; name: string; branch: string; end: string }) {
      return workflow.createPlan(workspace(input.workspaceId).path, input.project, input)
    },
    addToPlan(input: { project: string; workspaceId: string; planId: string; ids: string[] }) {
      if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 100) throw new Error('每批可选 1 到 100 条议题')
      return workflow.addToPlan(workspace(input.workspaceId).path, input.project, input.planId, input.ids)
    },
  }

  ctx.webServer.register({
    kind: 'exact', path: '/api/dy-yunxiao',
    async handler(req, res) {
      const rejection = ctx.connection.requestRejection(req)
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      if (rejection || req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) {
        res.statusCode = rejection || 405
        res.end(JSON.stringify({ error: '请从已连接的 DSH 面板访问' }))
        return
      }
      try {
        const { method, input } = await json(req)
        if (typeof method !== 'string' || !Object.hasOwn(methods, method)) throw new Error('未知云效操作')
        res.end(JSON.stringify({ value: await methods[method as keyof typeof methods](input) }))
      } catch (error) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : '操作失败' }))
      }
    },
  })
  ctx.webServer.register({
    kind: 'exact', path: '/dy-yunxiao/panel.css',
    async handler(_req, res) {
      res.setHeader('Content-Type', 'text/css; charset=utf-8')
      res.end(await readFile(new URL('./panel.css', import.meta.url)))
    },
  })
}
