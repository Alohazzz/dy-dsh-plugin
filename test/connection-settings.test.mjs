import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createConnectionSettings } from '../src/connection-settings.ts'
import { createClient, listOrganizations, YunxiaoHttpError } from '../src/yunxiao-client.mjs'

function memoryStore(record) {
  return {
    async readRecord() { return record },
    async modifyRecord(_, update) { record = await update(record) },
    async deleteRecord() { record = undefined },
  }
}

test('用表单令牌发现组织，按所选组织返回项目且保留已保存配置', async () => {
  const store = memoryStore({
    kind: 'api-key', key: 'fixture-original', env: { YUNXIAO_ORG_ID: 'original' },
  })
  const fetcher = async (url, request) => {
    assert.equal(request.headers['x-yunxiao-token'], 'fixture-discover')
    if (url.endsWith('/platform/organizations')) {
      assert.equal(request.method, 'GET')
      return Response.json([{ id: 'org-one', name: '组织一' }, { id: 'org-two', name: '组织二' }])
    }
    assert.match(url, /organizations\/org-two\/projects:search$/)
    assert.equal(request.method, 'POST')
    return Response.json([{ id: 'project-two', name: '组织二项目' }])
  }
  const settings = createConnectionSettings(store, config => createClient({ ...config, fetcher }),
    token => listOrganizations(token, fetcher))
  assert.deepEqual(await settings.organizations({ token: 'fixture-discover' }), [
    { id: 'org-one', name: '组织一' }, { id: 'org-two', name: '组织二' },
  ])
  assert.deepEqual(await settings.projects({ token: 'fixture-discover', organization: 'org-two' }), [
    { id: 'project-two', name: '组织二项目' },
  ])
  assert.equal((await settings.describe()).organization, 'original')
})

test('连接配置只展示令牌状态，新令牌验证失败时保留原设置', async () => {
  const store = memoryStore({
    kind: 'api-key', key: 'fixture-first-token', env: { YUNXIAO_ORG_ID: 'org' },
  })
  const createClient = ({ token, organization }) => ({
    organization,
    async currentUser() {
      if (token === 'rejected-fixture') throw new YunxiaoHttpError(401)
      return { name: token === 'fixture-first-token' ? '原用户' : '新用户' }
    },
    async projects() { return [{ id: 'project' }] },
  })
  const settings = createConnectionSettings(store, createClient)
  assert.deepEqual(await settings.describe(), { hasToken: true, source: 'saved', organization: 'org', project: '' })
  const input = { token: 'fixture-next-token', organization: ' new-org ', project: 'project' }
  assert.deepEqual(await settings.test(input), { user: '新用户', projectCount: 1 })
  assert.equal((await settings.client()).organization, 'org')
  await assert.rejects(settings.save({ ...input, token: 'rejected-fixture' }), /HTTP 401/)
  assert.equal((await settings.client()).organization, 'org')
  await settings.save(input)
  assert.deepEqual(await settings.describe(), {
    hasToken: true, source: 'saved', organization: 'new-org', project: 'project',
  })
  await settings.save({ token: '', organization: 'another-org', project: '' })
  const api = await settings.client()
  assert.equal(api.organization, 'another-org')
  assert.deepEqual(await api.currentUser(), { name: '新用户' })
})

test('清除已保存配置后恢复使用宿主环境变量', async t => {
  const env = { YUNXIAO_TOKEN: 'fixture-env-token', YUNXIAO_ORG_ID: 'env-org', YUNXIAO_PROJECT_ID: 'env-project' }
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  Object.assign(process.env, env)
  const store = memoryStore({
    kind: 'api-key', key: 'fixture-local-token', env: { YUNXIAO_ORG_ID: 'saved-org' },
  })
  const settings = createConnectionSettings(store, config => ({ ...config }))
  assert.equal((await settings.describe()).organization, 'saved-org')
  await settings.clear()
  assert.deepEqual(await settings.describe(), {
    hasToken: true, source: 'env', organization: 'env-org', project: 'env-project',
  })
  assert.equal((await settings.client()).organization, 'env-org')
})
