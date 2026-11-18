import { readFile } from 'node:fs/promises'
export const inject = ['webServer']
export function apply(ctx) {
  ctx.webServer.register({ kind: 'exact', path: '/prototype/yunxiao', async handler(req, res) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(await readFile(new URL('./prototype.html', import.meta.url)))
  } })
}
