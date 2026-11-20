import { type createClient, YunxiaoHttpError } from './yunxiao-client.mjs'
import { digest } from './yunxiao.mjs'
import type { MrAction, MrActionPreview, MrActionResult, MrMergeType, MrRef } from './contracts.ts'

type Client = ReturnType<typeof createClient>
type Mr = Awaited<ReturnType<Client['codeup']['detail']>>
type Intent = MrRef & { action: MrAction }
type Check = Intent & { scope: string }
type Submit = Check & { token: string; mergeType?: MrMergeType }

const openStatuses = ['UNDER_DEV', 'UNDER_REVIEW', 'TO_BE_MERGED']
const mergeTypes: MrMergeType[] = ['no-fast-forward', 'squash', 'rebase', 'ff-only']
const approved = (mr: Mr, actor: string) => mr.reviewers.some(row => row.id === actor && row.opinion === 'PASS')

export function availableMrActions(mr: Mr, actor: string): MrAction[] {
  const actions: MrAction[] = []
  if ((mr.status === 'UNDER_REVIEW' || mr.status === 'TO_BE_MERGED') &&
    mr.reviewers.some(row => row.id === actor) && !approved(mr, actor)) {
    actions.push('approve')
  }
  if (!mr.conflict && mr.requirementsPassed !== false &&
    (mr.status === 'TO_BE_MERGED' || (mr.status === 'UNDER_REVIEW' && mr.requirementsPassed === true))) {
    actions.push('merge')
  }
  if (openStatuses.includes(mr.status)) actions.push('close')
  return actions
}

function hasResult(action: MrAction, mr: Mr, actor: string) {
  if (action === 'approve') return approved(mr, actor)
  if (action === 'merge') return mr.status === 'MERGED' && Boolean(mr.mergedRevision)
  return mr.status === 'CLOSED'
}

export function createMrActions(client: () => Promise<Client>) {
  const running = new Set<string>()

  async function context(input: Intent) {
    if (!['approve', 'merge', 'close'].includes(input.action) ||
      ![input.repositoryId, input.localId].every(id => Number.isSafeInteger(id) && id > 0)) {
      throw new Error('无效的合并请求操作')
    }
    const api = await client()
    const actor = await api.currentUser()
    const key = digest(api.organization, input.repositoryId, input.localId)
    return { api, actor, key, scope: digest(key, actor.id, input.action) }
  }

  async function previewOf(input: Intent, mr: Mr, { api, actor, scope }: Awaited<ReturnType<typeof context>>): Promise<MrActionPreview> {
    if (!availableMrActions(mr, String(actor.id)).includes(input.action)) {
      throw new Error('当前状态或审核人已变化，请刷新合并请求后重试')
    }
    const patches = input.action === 'close' ? undefined : await api.codeup.patches(input)
    const token = digest(scope, JSON.stringify([mr.title, mr.source, mr.target, mr.status, mr.fastForward,
      patches?.source.version, patches?.source.sha, patches?.target.version, patches?.target.sha]))
    return { scope, token, title: mr.title, source: mr.source, target: mr.target, actor: actor.name,
      patch: patches && { version: patches.source.version, sha: patches.source.sha }, fastForward: mr.fastForward }
  }

  async function verify(input: Intent, api: Client, actor: string): Promise<MrActionResult> {
    const mr = await api.codeup.detail(input).catch(() => undefined)
    if (mr && hasResult(input.action, mr, actor)) return { confirmed: true }
    if (mr?.status === 'CLOSED') throw new Error('Codeup 中的 MR 已关闭，请返回详情查看')
    if (mr?.status === 'MERGED' && input.action !== 'merge') throw new Error('Codeup 中的 MR 已合并，请返回详情查看')
    return { confirmed: false }
  }

  return {
    async preview(input: Intent) {
      const ctx = await context(input)
      return previewOf(input, await ctx.api.codeup.detail(input), ctx)
    },
    async submit(input: Submit): Promise<MrActionResult> {
      const ctx = await context(input)
      const { api, actor, key, scope } = ctx
      if (input.scope !== scope) throw new Error('当前云效账号或组织已变化，请重新确认')
      if (running.has(key)) throw new Error('此合并请求正在处理，请稍后核对结果')
      running.add(key)
      try {
        const mr = await api.codeup.detail(input)
        if (hasResult(input.action, mr, String(actor.id))) return { confirmed: true }
        const latest = await previewOf(input, mr, ctx)
        if (latest.token !== input.token) throw new Error('合并请求或补丁集已变化，请重新确认')
        const { mergeType } = input
        if (input.action === 'merge' && (!mergeType || !mergeTypes.includes(mergeType) ||
          (mergeType === 'ff-only' && !latest.fastForward))) throw new Error('请选择可用的合并方式')
        const write = input.action === 'merge' ? api.codeup.merge(input, mergeType) : api.codeup[input.action](input)
        const response: unknown = await write.catch(error => error)
        const result = await verify(input, api, String(actor.id))
        if (!result.confirmed && response === false) throw new Error('Codeup 拒绝了操作，请在 Codeup 核对权限和当前状态')
        if (!result.confirmed && response instanceof YunxiaoHttpError && [400, 401, 403, 404, 409, 422].includes(response.status)) {
          throw new Error(response.detail || response.message)
        }
        return result
      } finally {
        running.delete(key)
      }
    },
    async check(input: Check) {
      const { api, actor, scope } = await context(input)
      if (input.scope !== scope) throw new Error('请切回发起操作时的云效账号和组织，再核对结果')
      return verify(input, api, String(actor.id))
    },
  }
}
