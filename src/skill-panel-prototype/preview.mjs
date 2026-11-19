// Builds an isolated DSH package with the prototype rendered in the real workbench slot.
import { build } from 'esbuild'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = fileURLToPath(new URL('../../', import.meta.url))
const preview = await mkdtemp(join(tmpdir(), 'dy-skill-prototype-'))
const dist = join(preview, 'dist')
const patch = join(preview, 'preview.yml')
const host = join(dist, 'host.js')
const cli = join(process.env.LOCALAPPDATA, 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd')
try {
  await mkdir(dist)
  await Promise.all([
    build({
      entryPoints: [join(root, 'src/host.ts')], bundle: true, platform: 'node', format: 'esm', outfile: host,
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    }),
    build({
      entryPoints: [join(root, 'src/panel.tsx')], bundle: true, platform: 'browser', format: 'iife',
      outfile: join(dist, 'client.js'),
      plugins: [{ name: 'skill-panel-preview', setup(builder) {
        builder.onResolve({ filter: /^\.\/skill-panel\.tsx$/ }, () => ({
          path: fileURLToPath(new URL('./variants.tsx', import.meta.url)),
        }))
      } }],
    }),
    writeFile(join(preview, 'package.json'), await readFile(join(root, 'package.json'))),
    cp(join(root, 'skills'), join(preview, 'skills'), { recursive: true }),
    writeFile(join(dist, 'panel.css'), (await readFile(join(root, 'src/panel.css'), 'utf8')) +
      '\n' + await readFile(new URL('./variants.css', import.meta.url), 'utf8')),
    writeFile(patch, '- insert:\n    - id: dy-yunxiao\n      name: ' + JSON.stringify(host.replaceAll('\\', '/')) + '\n'),
  ])
  const args = ['web', '--patch', patch, '--host', '127.0.0.1', '--port', '0']
  if (process.argv.includes('--no-open')) args.push('--no-open')
  const processArgs = args.map(arg => '"' + arg + '"').join(' ')
  const child = spawn('cmd.exe', ['/d', '/s', '/c', '""' + cli + '" ' + processArgs + '"'], {
    windowsVerbatimArguments: true,
    windowsHide: true,
    env: { ...process.env, DSH_HOME: join(preview, 'profile') },
    stdio: 'inherit',
  })
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 0))
  })
} finally {
  await rm(preview, { recursive: true, force: true, maxRetries: 3 })
}
