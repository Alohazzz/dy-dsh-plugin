export function codeupApi(call, organization) {
  const base = '/oapi/v1/codeup/organizations/' + organization
  function requestPath({ repositoryId, localId }) {
    if (![repositoryId, localId].every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('无效的合并请求编号')
    return base + '/repositories/' + repositoryId + '/changeRequests/' + localId
  }
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
    async detail(reference) {
      const { repositoryId, localId } = reference
      const raw = await call(requestPath(reference))
      const item = raw?.result ?? raw
      if (Number(item?.localId) !== localId || (item?.projectId != null && Number(item.projectId) !== repositoryId)) {
        throw new Error('Codeup 返回的合并请求与请求不符')
      }
      return requestRow(item, repositoryId)
    },
    /** @param {AbortSignal} [signal] */
    async reviewTarget(reference, signal) {
      const mrPath = requestPath(reference)
      const { repositoryId, localId } = reference
      const repositoryPath = base + '/repositories/' + repositoryId
      const [repository, patches] = await Promise.all([
        call(repositoryPath, signal),
        call(mrPath + '/diffs/patches', signal),
      ])
      const remote = repository?.httpUrlToRepo
      if (Number(repository?.id) !== repositoryId || typeof remote !== 'string' ||
        !remote.startsWith('https://codeup.aliyun.com/') || pathOf(remote) !== repository.pathWithNamespace ||
        !/^[\w.-]+(?:\/[\w.-]+)+$/.test(repository.pathWithNamespace)) {
        throw new Error('无法核对合并请求所属的 Codeup 仓库地址')
      }
      if (!Array.isArray(patches)) throw new Error('无法读取 Codeup 补丁集')
      /** @param {string} type */
      const latest = type => {
        const patch = patches.filter(item => item?.relatedMergeItemType === type && Number.isSafeInteger(item.versionNo))
          .sort((a, b) => b.versionNo - a.versionNo)[0]
        if (!patch || !/^[a-f0-9]{40}$/.test(patch.commitId)) throw new Error('Codeup 补丁集缺少有效的固定提交')
        const ref = typeof patch.ref === 'string' && /^refs\/changes\/[0-9]+\/(?:target\/)?[0-9]+$/.test(patch.ref)
          && patch.ref.split('/')[2] === String(localId) ? patch.ref : patch.commitId
        return {
          sha: patch.commitId, ref, version: patch.versionNo,
          patchSetId: typeof patch.patchSetBizId === 'string' ? patch.patchSetBizId : '',
        }
      }
      return { remote, source: latest('MERGE_SOURCE'), target: latest('MERGE_TARGET') }
    },
    async findReviewComment(reference, marker) {
      const rows = await call(requestPath(reference) + '/comments/list', undefined, 'POST', { comment_type: 'GLOBAL_COMMENT' })
      if (!Array.isArray(rows)) throw new Error('无法读取 Codeup 评论列表')
      const found = rows.find(row => row?.state === 'OPENED' && !row.is_deleted &&
        typeof row.comment_biz_id === 'string' && typeof row.content === 'string' && row.content.includes(marker))
      return found?.comment_biz_id
    },
    async publishReviewComment(reference, patchSetId, content) {
      const item = await call(requestPath(reference) + '/comments', undefined, 'POST', {
        comment_type: 'GLOBAL_COMMENT', content, draft: false, patchset_biz_id: patchSetId, resolved: false,
      })
      if (typeof item?.comment_biz_id !== 'string' || !item.comment_biz_id) throw new Error('Codeup 未返回评论编号')
      return item.comment_biz_id
    },
    async create(id, source, target, title, description) {
      return receipt(await call(base + '/repositories/' + id + '/changeRequests', undefined, 'POST', {
        sourceProjectId: id, targetProjectId: id, sourceBranch: source, targetBranch: target, title, description,
      }))
    },
  }
}
