import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const [output, expectedVersion] = process.argv.slice(2)
if (!output) throw new Error('Usage: node scripts/plugin-index.mjs <output> [expected-version]')

const registry = manifest.publishConfig.registry
const response = await fetch(new URL(encodeURIComponent(manifest.name), registry), { signal: AbortSignal.timeout(15000) })
if (!response.ok && (response.status !== 404 || expectedVersion)) {
  throw new Error(`npm registry returned HTTP ${response.status}`)
}
const metadata = response.ok ? await response.json() : { versions: {}, time: {} }
const versions = Object.entries(metadata.versions)
  .filter(([version, entry]) => version !== '0.0.0-stage' && !entry.deprecated)
  .map(([version, entry]) => ({
    version,
    publishTimestamp: Math.floor(Date.parse(metadata.time[version]) / 1000),
    source: { type: 'npm', registry },
    engines: { dsh: entry.engines?.dsh },
  }))

if (expectedVersion && !versions.some(entry => entry.version === expectedVersion)) {
  throw new Error(`npm version ${expectedVersion} is not visible in the registry`)
}
if (versions.some(entry => !Number.isSafeInteger(entry.publishTimestamp))) {
  throw new Error('Invalid npm publish timestamp')
}

const index = {
  format: 1,
  title: 'DY DSH 插件',
  plugins: versions.length ? [{
    name: manifest.name,
    title: '云效议题',
    description: manifest.description,
    repository: { url: manifest.repository.url.replace(/^git\+/, '').replace(/\.git$/, '') },
    versions,
  }] : [],
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, JSON.stringify(index, null, 2) + '\n')
