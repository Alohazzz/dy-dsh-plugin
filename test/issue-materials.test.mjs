import assert from 'node:assert/strict'
import { test } from 'node:test'
import { issueMaterials } from '../src/issue-materials.ts'

test('正文按原顺序引用附件和单独解析的图片，同名文件按 ID 区分', async () => {
  const calls = []
  const api = {
    attachments: async () => [
      { fileId: 'a', fileName: 'image.png', url: 'https://example.test/a' },
      { fileId: 'other', fileName: 'image.png', url: 'https://example.test/other' },
    ],
    file: async (_, id) => {
      calls.push(id)
      return { fileName: 'image.png', downloadUrl: 'https://example.test/b' }
    },
  }
  const result = await issueMaterials(api, 'issue',
    '<p>缺陷描述 &amp; 影响</p><img src="/f?v=2&amp;fileIdentifier=b"><p>发生频率</p>' +
    '<img src="/f?fileIdentifier=a"><img src="/f?fileIdentifier=b">')
  assert.deepEqual(result.body, [{ text: '缺陷描述 & 影响' }, { file: 2 }, { text: '发生频率' }, { file: 0 }, { file: 2 }])
  assert.deepEqual(calls, ['b'])
  assert.equal(result.files.length, 3)
  assert.equal(result.files[2].url, 'https://example.test/b')
})
