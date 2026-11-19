export function codeupApi(call, organization) {
  const base = '/oapi/v1/codeup/organizations/' + organization
  function pathOf(remote) {
    const match = /^(?:https:\/\/codeup\.aliyun\.com\/|git@codeup\.aliyun\.com:|ssh:\/\/git@codeup\.aliyun\.com\/)([^?#\s]+)$/.exec(remote)
    const path = match?.[1].replace(/\.git$/, '')
    if (!path || path.split('/').some(part => !part || part === '..' || part === '.') || !path.includes('/')) {
      throw new Error('请选择使用 Codeup origin 的仓库')
    }
    return path
  }
  function receipt(raw) {
    const item = raw?.result ?? raw
    const localId = Number(item?.localId)
    if (!Number.isSafeInteger(localId) || localId <= 0) throw new Error('缺少 MR 编号，请核对远端结果')
    const link = item.detailUrl || item.webUrl
    return { localId, url: typeof link === 'string' && /^https:\/\//i.test(link) ? link : '' }
  }
  function requestRow(item, repositoryId = Number(item.projectId ?? item.targetProjectId)) {
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) throw new Error('缺少 MR 所属仓库')
    /** @type {{ id: string, name: string, reviewed: boolean }[]} */
    const reviewers = (Array.isArray(item.reviewers) ? item.reviewers : []).map(user => ({
      id: String(user.userId || ''), name: String(user.name || user.username || user.userId || ''), reviewed: user.hasReviewed === true,
    }))
    return {
      ...receipt(item), repositoryId,
      repository: typeof item.sshUrl === 'string' ? item.sshUrl.replace(/^(?:ssh:\/\/)?[^/:]+[:/]/, '').replace(/\.git$/, '') : '',
      source: item.sourceBranch || '', target: item.targetBranch || '', title: item.title || '',
      status: item.status || item.state || '', author: item.author?.name || item.author?.username || '',
      description: item.description || '', conflict: item.hasConflict === true || item.conflictCheckStatus === 'HAS_CONFLICT',
      reviewers,
      ahead: typeof item.ahead === 'number' ? item.ahead : undefined, mergedRevision: item.mergedRevision || '',
    }
  }
  async function listPage(query) {
    const items = await call(base + '/changeRequests?' + new URLSearchParams(query))
    if (!Array.isArray(items)) throw new Error('无法读取 Codeup 合并请求列表')
    return items
  }
  return {
    async repository(fetchUrl, pushUrl) {
      const path = pathOf(fetchUrl)
      if (pathOf(pushUrl) !== path) throw new Error('origin 的读取仓库与推送仓库不同')
      const repo = await call(base + '/repositories/' + encodeURIComponent(path))
      const id = Number(repo?.id)
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Codeup 未返回有效仓库 ID')
      return { id, path, defaultBranch: repo.defaultBranch || '' }
    },
    async openForSource(id, source) {
      const matches = []
      for (let page = 1; ; page++) {
        const items = await listPage({ state: 'opened', projectIds: String(id), perPage: '20', page: String(page) })
        for (const item of items.filter(item => Number(item.sourceProjectId) === id && Number(item.targetProjectId) === id &&
          item.sourceBranch === source && item.sourceType !== 'COMMIT' && item.targetType !== 'COMMIT')) {
          matches.push({ target: item.targetBranch, title: item.title || '', ...receipt(item) })
        }
        if (items.length < 20) return matches
      }
    },
    async list({ page, authorId = '', reviewerId = '', repository = '' }) {
      const query = { page: String(page), perPage: '20' }
      if (repository) query.projectIds = repository
      if (authorId) query.authorIds = authorId
      if (reviewerId) {
        query.reviewerIds = reviewerId
        query.state = 'opened'
      }
      const items = await listPage(query)
      const rows = items.map(item => requestRow(item))
      return { rows: reviewerId ? rows.filter(row => row.status === 'UNDER_REVIEW' &&
        row.reviewers.some(user => user.id === reviewerId && !user.reviewed)) : rows, more: items.length === 20 }
    },
    async detail({ repositoryId, localId }) {
      if (![repositoryId, localId].every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('无效的合并请求编号')
      const raw = await call(base + '/repositories/' + repositoryId + '/changeRequests/' + localId)
      const item = raw?.result ?? raw
      if (Number(item?.localId) !== localId || (item?.projectId != null && Number(item.projectId) !== repositoryId)) {
        throw new Error('Codeup 返回的合并请求与请求不符')
      }
      return requestRow(item, repositoryId)
    },
    async create(id, source, target, title, description) {
      return receipt(await call(base + '/repositories/' + id + '/changeRequests', undefined, 'POST', {
        sourceProjectId: id, targetProjectId: id, sourceBranch: source, targetBranch: target, title, description,
      }))
    },
  }
}
