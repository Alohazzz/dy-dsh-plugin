import { createClient, listOrganizations, YunxiaoHttpError } from './yunxiao-client.mjs'
import type { ConnectionSettings, Option } from './contracts.ts'

type StoredConnection = { kind: 'api-key'; key: string; env: Record<string, string> }
export type CredentialStore = {
  readRecord(key: string): Promise<unknown>
  modifyRecord(key: string, update: (current: unknown) => Promise<StoredConnection>): Promise<unknown>
  deleteRecord(key: string): Promise<void>
}

const recordKey = 'dy-yunxiao/connection'

function saved(record: unknown) {
  const value = record as Partial<StoredConnection> | undefined
  if (value?.kind !== 'api-key' || typeof value.key !== 'string' || !value.key.trim()) return
  return {
    token: value.key,
    organization: value.env?.YUNXIAO_ORG_ID || '',
    project: value.env?.YUNXIAO_PROJECT_ID || '',
  }
}

function effective(record: unknown) {
  return saved(record) ?? {
    token: process.env.YUNXIAO_TOKEN?.trim() ?? '',
    organization: process.env.YUNXIAO_ORG_ID?.trim() ?? '',
    project: process.env.YUNXIAO_PROJECT_ID?.trim() ?? '',
  }
}

function choices(items: { id?: string; name?: string; displayName?: string }[]): Option[] {
  return [...new Map(items.flatMap(item =>
    typeof item?.id === 'string' && /^[\w-]{1,128}$/.test(item.id)
      ? [[item.id, { id: item.id, name: item.displayName || item.name || item.id }] as const]
      : [])).values()]
}

export function createConnectionSettings(store: CredentialStore, clientFactory = createClient, organizations = listOrganizations) {
  function tokenFor(record: unknown, input?: string) {
    if (input !== undefined && typeof input !== 'string') throw new Error('请检查云效连接设置')
    const token = input?.trim() || effective(record).token
    if (!token || token.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) throw new Error('请输入有效的云效个人访问令牌')
    return token
  }

  async function discover(load: () => Promise<Parameters<typeof choices>[0]>, resource: string) {
    try {
      return choices(await load())
    } catch (error) {
      const status = error instanceof YunxiaoHttpError ? `（HTTP ${error.status}）` : ''
      throw new Error(`获取${resource}失败${status}。请检查网络、令牌和${resource}读取权限后重试。`)
    }
  }

  function candidate(record: unknown, input: { token?: string; organization: string; project: string }) {
    if (typeof input?.organization !== 'string' || typeof input.project !== 'string') {
      throw new Error('请检查云效连接设置')
    }
    const token = tokenFor(record, input.token)
    const organization = input.organization.trim()
    const project = input.project.trim()
    if (!/^[\w-]{1,128}$/.test(organization)) throw new Error('请输入有效的云效组织 ID')
    if (project && !/^[\w-]{1,128}$/.test(project)) throw new Error('请输入有效的默认项目 ID')
    return { token, organization, project }
  }

  async function check(config: ReturnType<typeof candidate>) {
    try {
      const api = clientFactory(config)
      const [user, projects] = await Promise.all([api.currentUser(), api.projects()])
      if (config.project && !projects.some(project => project.id === config.project)) {
        throw new Error('默认项目不可访问')
      }
      return { user: user.name, projectCount: projects.length }
    } catch (error) {
      if (error instanceof YunxiaoHttpError) {
        throw new Error(`云效连接失败（HTTP ${error.status}）。请检查令牌、组织 ID 和访问权限。`)
      }
      if (error instanceof Error && error.message === '默认项目不可访问') {
        throw new Error('在该组织中未找到可访问的默认项目，请检查项目 ID 或留空。')
      }
      throw new Error('无法完成云效连接检查，请检查网络后重试。')
    }
  }

  return {
    async client() {
      const config = effective(await store.readRecord(recordKey))
      if (!config.token || !config.organization) throw new Error('请在「连接设置」填写云效 Token 和组织 ID。')
      return clientFactory(config)
    },
    async describe(): Promise<ConnectionSettings> {
      const record = await store.readRecord(recordKey)
      const config = effective(record)
      return {
        hasToken: Boolean(config.token),
        source: saved(record) ? 'saved' : config.token ? 'env' : 'none',
        organization: config.organization,
        project: config.project,
      }
    },
    async organizations(input: { token?: string }) {
      const token = tokenFor(await store.readRecord(recordKey), input?.token)
      return discover(() => organizations(token), '组织')
    },
    async projects(input: { token?: string; organization: string }) {
      const config = candidate(await store.readRecord(recordKey), { ...input, project: '' })
      return discover(() => clientFactory(config).projects(), '项目')
    },
    async test(input: Parameters<typeof candidate>[1]) {
      return check(candidate(await store.readRecord(recordKey), input))
    },
    async save(input: Parameters<typeof candidate>[1]) {
      await store.modifyRecord(recordKey, async current => {
        const config = candidate(current, input)
        await check(config)
        return {
          kind: 'api-key',
          key: config.token,
          env: { YUNXIAO_ORG_ID: config.organization, ...(config.project ? { YUNXIAO_PROJECT_ID: config.project } : {}) },
        }
      })
    },
    async clear() {
      await store.deleteRecord(recordKey)
    },
  }
}
