import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reviewChanges, reviewVersion, sharedAcceptance } from '../src/plan-review.ts'

test('首份方案与调研轮次分开，修订只与同类文档对比', () => {
  const report = '## 业务规则\n旧资料'
  const proposal = '## 验收与回归\n已保存值优先'
  const row = { drafts: [{ report, decisions: [] }, { report, proposal, decisions: ['保存值优先'], proposalVersion: 1 }] }
  assert.equal(reviewVersion(2, 1), '第 2 轮调研 · 执行方案 v1')
  assert.equal(reviewChanges(row).previous, undefined)
  assert.deepEqual(reviewChanges(row).decisions, ['保存值优先'])
  row.drafts.push({ report, decisions: ['保存值优先'] }, { proposal: proposal + '，清空后回落', decisions: ['保存值优先'] })
  assert.deepEqual(reviewChanges(row).changes, [{ name: '验收与回归', before: '已保存值优先', after: '已保存值优先，清空后回落' }])
})

test('组合验收在两行共用，限定计划成员、同一对议题和已批准版本', () => {
  const draft = ref => ({ proposal: '## **五、验收与回归**\n### 1) 组合验收·' + ref + '\n清空后按默认值回填', proposalVersion: 1 })
  const row = (ref, peer, approved) => ({ reference: ref, issueId: ref, status: 'ready', drafts: [draft(peer)], finalizedVersion: approved ? 1 : undefined })
  const rows = [row('A', 'B', false), row('B', 'A', true), row('C', 'removed', true)]
  const fromA = sharedAcceptance(rows, 'A', true)
  assert.equal(fromA.length, 1)
  assert.equal(fromA[0].source, 'B')
  assert.deepEqual(sharedAcceptance(rows, 'B'), fromA)
  assert.deepEqual(sharedAcceptance(rows.slice(1), 'B'), [])
  assert.deepEqual(sharedAcceptance(rows, 'C'), [])
})
