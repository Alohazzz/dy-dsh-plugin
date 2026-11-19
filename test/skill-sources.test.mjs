import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSkillSources } from '../src/skill-sources.ts'

test('刷新区分技能删除、单项解析错误和来源读取失败，并保留最后成功结果', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dy-skill-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const local = join(root, 'source')
  await mkdir(join(local, 'parent', 'child'), { recursive: true })
  const original = '---\nname: Review\ndescription: Review code\nversion: 1\n---\n# Review\n'
  await writeFile(join(local, 'parent', 'SKILL.md'), original)
  await writeFile(join(local, 'parent', 'check.ps1'), '')
  await writeFile(join(local, 'parent', 'child', 'SKILL.md'), '# Example')
  await writeFile(join(local, 'parent', 'child', 'sample.txt'), 'data')
  const store = createSkillSources(home)
  const input = { kind: 'local', location: local, name: '开发' }
  const { source } = await store.bind(input)
  const { id } = source
  assert.equal((await store.bind(input)).duplicate, true)
  const parent = source.skills.find(skill => skill.path === 'parent/SKILL.md')
  const child = source.skills.find(skill => skill.path === 'parent/child/SKILL.md')
  assert.deepEqual(parent.files, ['parent/check.ps1'])
  assert.equal(parent.version, '1')
  assert.equal(child.name, 'child')
  assert.deepEqual(child.files, ['parent/child/sample.txt'])

  await writeFile(join(local, 'parent', 'SKILL.md'), '---\nname: [\n---\n')
  await rm(join(local, 'parent', 'child', 'SKILL.md'))
  const task = store.refresh(id)
  assert.equal(task, store.refresh(id))
  const partial = await task
  assert.deepEqual(partial.removed, [child.path])
  assert.equal(partial.problems[0].path, parent.path)
  assert.deepEqual(partial.skills, [{ ...parent, stale: true }])

  await writeFile(join(local, 'parent', 'SKILL.md'), original.replace('# Review', '# Updated'))
  const updated = await store.refresh(id)
  assert.equal(updated.skills[0].markdown, '# Updated\n')
  assert.equal(updated.skills[0].stale, undefined)
  store.rename(id, '本地开发')
  await rename(local, join(root, 'unavailable'))
  const resumed = createSkillSources(home)
  const failed = await resumed.refresh(id)
  assert.match(failed.error, /无法读取本地来源/)
  assert.equal(failed.name, '本地开发')
  assert.equal(failed.readAt, updated.readAt)
  assert.equal(failed.skills[0].stale, true)
  resumed.unbind(id)
  assert.deepEqual(createSkillSources(home).list(), [])
})
