/**
 * Bundle `lib/types/index.js` and `lib/types/bot-route.js` into `lib/index.js`
 * and `lib/bot-route.js` while keeping `peerDependencies` and runtime
 * `dependencies` external (matching DSH plugin loader conventions).
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type BuildOptions } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  peerDependencies?: Record<string, string>
  dependencies?: Record<string, string>
}

const externalPackages = [
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.dependencies ?? {}),
]
const external = externalPackages.flatMap(name => [name, `${name}/*`])

const shared: BuildOptions = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  external,
  logLevel: 'info',
}

await Promise.all([
  build({
    ...shared,
    entryPoints: [resolve(root, 'lib/types/index.js')],
    outfile: resolve(root, 'lib/index.js'),
  }),
  build({
    ...shared,
    entryPoints: [resolve(root, 'lib/types/bot-route.js')],
    outfile: resolve(root, 'lib/bot-route.js'),
  }),
])
