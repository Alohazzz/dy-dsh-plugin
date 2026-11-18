const endpoint = 'https://openapi-rdc.aliyuncs.com'

function segment(value) {
  if (typeof value !== 'string' || !/^[\w-]+$/.test(value)) {
    throw new Error('云效 ID 或编号格式无效')
  }
  return value
}

function list(value, field) {
  const items = Array.isArray(value) ? value : value?.[field]
  if (!Array.isArray(items)) throw new Error('云效返回了无法识别的列表')
  return items
}

export class YunxiaoHttpError extends Error {
  constructor(status, message = `云效请求失败（HTTP ${status}）`) {
    super(message)
    this.status = status
  }
}

function transport(token, fetcher) {
  return async function call(path, signal = null, method = 'GET', body) {
    const timeout = AbortSignal.timeout(20_000)
    const response = await fetcher(endpoint + path, {
      method,
      headers: { 'x-yunxiao-token': token.trim(), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (!response.ok) throw new YunxiaoHttpError(response.status)
    const raw = await response.text()
    return raw ? JSON.parse(raw) : null
  }
}

export async function listOrganizations(token, fetcher = fetch) {
  const call = transport(token, fetcher)
  return list(await call('/oapi/v1/platform/organizations'), 'organizations')
}

export function createClient({
  token = process.env.YUNXIAO_TOKEN,
  organization = process.env.YUNXIAO_ORG_ID,
  project = process.env.YUNXIAO_PROJECT_ID,
  fetcher = fetch,
} = {}) {
  if (!token?.trim() || !organization) {
    throw new Error('请在 DSH 宿主环境配置 YUNXIAO_TOKEN 和 YUNXIAO_ORG_ID')
  }
  const org = `/oapi/v1/projex/organizations/${segment(organization)}`
  const itemPath = id => `/${segment(id)}`

  const call = transport(token, fetcher)

  const request = (path, signal, method, body) => call(org + '/workitems' + path, signal, method, body)
  const projectPath = id => org + '/projects/' + segment(id)
  const typePath = (space, type) => projectPath(space) + '/workitemTypes/' + segment(type)
  const typeOf = issue => issue.workitemTypeId || issue.workitemType?.id

  async function get(id, signal = null) {
    const response = await request(itemPath(id), signal)
    const issue = response?.result ?? response
    if (issue?.id !== id) throw new Error('云效返回的工作项 ID 与请求不符')
    return issue
  }

  async function currentUser() {
    const user = await call('/oapi/v1/platform/user')
    const id = user?.id || user?.userId
    if (!id) throw new Error('云效未返回当前用户')
    return { id, name: user.name || user.userName || id }
  }

  return {
    organization,
    project,
    currentUser,
    async projects() {
      const projects = []
      for (let page = 1; ; page++) {
        const items = list(await call(org + '/projects:search', undefined, 'POST', {
          page, perPage: 100, conditions: '{"conditionGroups":[[]]}', orderBy: 'gmtCreate', sort: 'desc',
        }), 'projects')
        projects.push(...items)
        if (items.length < 100) return projects
      }
    },
    async search(space, category, conditions, page) {
      return list(await request(':search', undefined, 'POST', {
        spaceId: segment(space), spaceType: 'Project', category, conditions: JSON.stringify({ conditionGroups: conditions }),
        orderBy: 'gmtCreate', sort: 'desc', page, perPage: 50,
      }), 'workitems')
    },
    async filters(space) {
      const batches = await Promise.all(['Req','Bug','Task'].map(async category =>
        list(await call(projectPath(space) + '/workitemTypes?category=' + category), 'workitemTypes')))
      const types = [...new Set(batches.flat().map(type => type.id).filter(Boolean))]
      const items = await Promise.all(types.map(async type => ({
        statuses: list(await call(typePath(space, type) + '/workflows'), 'statuses'),
        fields: list(await call(typePath(space, type) + '/fields'), 'fields'),
      })))
      return {
        statuses: [...new Map(items.flatMap(item => item.statuses).map(value => [value.id,value])).values()],
        fields: items.flatMap(item => item.fields),
        versions: list(await call(projectPath(space) + '/versions'), 'versions'),
      }
    },
    async schedule(issue, space) {
      const type = typeOf(issue)
      const [user, fields, statuses] = await Promise.all([
        currentUser(), call(typePath(space, type) + '/fields'),
        request(itemPath(issue.id) + '/workflow'),
      ])
      const start = list(fields, 'fields').find(field => field.name === '计划开始时间')
      const target = list(statuses, 'statuses').find(status => (status.displayName || status.name) === '待开发')
      if (!start?.id || !target?.id) throw new YunxiaoHttpError(422, '缺少计划开始时间字段或无可用的待开发流转')
      const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
      await request(itemPath(issue.id), undefined, 'PUT', {
        [start.id]: today + ' 00:00:00', assignedTo: user.id, status: target.id,
      })
      if ((await get(issue.id)).status?.id !== target.id) throw new Error('尚未核实待开发状态，请重试')
    },
    get,
    async find(reference, signal) {
      segment(reference)
      if (!/^[\w-]+-\d+$/.test(reference)) return get(reference, signal)
      if (!project) throw new Error('按显示编号查找需要配置 YUNXIAO_PROJECT_ID，也可以使用工作项 ID')
      const conditions = JSON.stringify({ conditionGroups: [[{
        fieldIdentifier: 'serialNumber', operator: 'CONTAINS', value: [reference.toUpperCase()], toValue: null,
        className: 'string', format: 'input',
      }]] })
      const perPage = 100
      for (let page = 1; page <= 100; page += 1) {
        const items = list(await request(':search', signal, 'POST', {
          spaceId: segment(project), spaceType: 'Project', category: 'Req,Bug,Task',
          conditions, page, perPage,
        }), 'workitems')
        const match = items.find(item => item.serialNumber?.toUpperCase() === reference.toUpperCase())
        if (match) return get(match.id, signal)
        if (items.length < perPage) break
      }
      throw new Error(`在配置的项目中未找到工作项 ${reference}`)
    },
    async attachments(id, signal) {
      return list(await request(`${itemPath(id)}/attachments`, signal), 'attachments')
        .map(file => ({ ...file, fileId: file.fileId ?? file.fileIdentifier ?? file.id,
          fileName: file.fileName ?? file.name, url: file.url ?? file.downloadUrl }))
    },
    file(id, fileId, signal) {
      return request(`${itemPath(id)}/files/${segment(fileId)}`, signal)
    },
    async comments(id, signal) {
      return list(await request(`${itemPath(id)}/comments`, signal), 'comments')
    },
    async comment(id, content, signal) {
      const result = await request(`${itemPath(id)}/comments`, signal, 'POST', {
        content, formatType: 'MARKDOWN',
      })
      if (!result?.id) throw new Error('云效未返回评论 ID')
      return result.id
    },
    async statuses(id, signal = null) {
      return list(await request(`${itemPath(id)}/workflow`, signal), 'statuses')
    },
    async setStatus(id, status, signal = null) {
      await request(itemPath(id), signal, 'PUT', { status })
    },
  }
}
