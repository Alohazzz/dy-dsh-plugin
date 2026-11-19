import { build } from 'esbuild'
import { copyFile } from 'node:fs/promises'

await Promise.all([
  build({
    entryPoints: ['src/host.ts'], bundle: true, platform: 'node', format: 'esm', outfile: 'dist/host.js',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  }),
  build({ entryPoints: ['src/panel.tsx'], bundle: true, platform: 'browser', format: 'iife', outfile: 'dist/client.js' }),
])
await copyFile('src/panel.css', 'dist/panel.css')
