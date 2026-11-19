import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5'
import type { Details } from './contracts.ts'

type FileInfo = { fileId?: string; fileName?: string; name?: string; url?: string; downloadUrl?: string }
type MaterialsApi = {
  attachments(issue: string, signal: undefined): Promise<FileInfo[]>
  file(issue: string, id: string, signal: undefined): Promise<FileInfo>
}

function webUrl(value?: string) {
  return value && URL.canParse(value) && new URL(value).protocol === 'https:' ? value : ''
}

export async function issueMaterials(api: MaterialsApi, issue: string, source: string) {
  const files: Details['files'] = []
  const ids = new Map<string, number>()
  const body: Details['body'] = []
  let materialsError: string | undefined
  try {
    for (const file of await api.attachments(issue, undefined)) {
      const name = file.fileName || file.fileId || '附件'
      if (file.fileId) ids.set(file.fileId, files.length)
      files.push({ name, url: webUrl(file.url), image: /\.(png|jpe?g|gif|webp)$/i.test(name) })
    }
  } catch {
    materialsError = '议题附件读取失败，可重试或填补充后开工'
  }

  let buffer = ''
  function flush() {
    const value = buffer.trim()
    if (value) body.push({ text: value })
    buffer = ''
  }

  const attempted = new Set<string>()
  async function resolveImage(id: string, src: string, name: string) {
    let index = id ? ids.get(id) : undefined
    const direct = webUrl(src)
    if (index === undefined && direct) {
      const found = files.findIndex(file => file.url === direct)
      if (found >= 0) index = found
    }
    let url = index === undefined ? '' : files[index].url
    if (id && !url && !attempted.has(id) && attempted.size < 30) {
      attempted.add(id)
      try {
        const file = await api.file(issue, id, undefined)
        url = webUrl(file.url || file.downloadUrl)
        name = file.name || file.fileName || name
      } catch { /* Try the original image URL below. */ }
    }
    url ||= direct
    if (!url) materialsError = '部分正文图片无法读取，可在云效查看'
    if (index === undefined) {
      index = files.length
      files.push({ name, url, image: true })
    } else {
      files[index].image = true
      files[index].url = url
    }
    if (id) ids.set(id, index)
    return index
  }

  async function visit(node: DefaultTreeAdapterTypes.Node) {
    if ('value' in node) {
      buffer += node.value
      return
    }
    if (!('tagName' in node)) return
    const tag = node.tagName
    if (tag === 'script' || tag === 'style') return
    if (tag === 'img') {
      flush()
      const attr = (name: string) => node.attrs.find(a => a.name === name)?.value || ''
      const src = attr('src') || attr('data-src')
      const id = /[?&]fileIdentifier=([\w-]+)/i.exec(src)?.[1] || attr('fileidentifier')
      const index = await resolveImage(id, src, attr('alt') || '正文图片')
      body.push({ file: index })
      return
    }
    const block = /^(div|p|li|h[1-6]|br)$/.test(tag)
    if (block && buffer && !buffer.endsWith('\n')) buffer += '\n'
    for (const child of node.childNodes) await visit(child)
    if (block && buffer && !buffer.endsWith('\n')) buffer += '\n'
  }
  for (const child of parseFragment(source).childNodes) await visit(child)
  flush()
  // Older descriptions can reference a file outside an image element.
  for (const [, id] of source.matchAll(/fileIdentifier=([\w-]+)/g)) {
    if (!ids.has(id) && attempted.size < 30) await resolveImage(id, '', id)
  }
  return { body, files, materialsError, text: body.flatMap(part => 'text' in part ? [part.text] : []).join('\n') }
}
