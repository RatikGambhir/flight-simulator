// Frame-rate benchmark in WKWebView (the Tauri engine on macOS).
//
//   node scripts/bench.mjs <label> [scenario…] [--no-build] [--gpusync] [--quality=high] [--adaptive=0] [--provider=google]
//
// Builds the production bundle, serves it locally, runs each scenario in its own
// fresh WKWebView window (1600x960 points: the app's default window) and writes
// bench-results/<label>/<scenario>.{json,png} plus a summary table.
import { spawnSync, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, preview } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const positional = args.filter((a) => !a.startsWith('--'))
const label = positional[0] ?? 'run'
const ALL = ['ocean', 'mountains', 'city', 'night', 'sunset', 'highspeed']
const scenarios = positional.length > 1 ? positional.slice(1) : ALL
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]

if (process.platform !== 'darwin') throw new Error('The benchmark needs macOS WebKit')
const out = join(root, 'bench-results', label)
await mkdir(out, { recursive: true })

if (!flags.has('--no-build')) {
  console.log('Building production bundle…')
  await build({ root, logLevel: 'error' })
}
const server = await preview({ root, logLevel: 'error', preview: { port: 4173, strictPort: true } })
const runner = join(root, 'target', 'bench-webkit')
if (!existsSync(runner) || flags.has('--rebuild-runner')) {
  const r = spawnSync('swiftc', ['-O', '-o', runner, join(root, 'scripts', 'bench-webkit.swift')], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('swiftc failed')
}

const query = new URLSearchParams()
if (flags.has('--gpusync')) query.set('gpusync', '1')
if (option('quality')) query.set('quality', option('quality'))
if (option('adaptive')) query.set('adaptive', option('adaptive'))
if (option('tune')) query.set('tune', option('tune'))
if (option('glass')) query.set('glass', option('glass'))
if (option('provider')) query.set('provider', option('provider'))
if (option('relevel')) query.set('relevel', option('relevel'))
if (flags.has('--frames')) query.set('frames', '1')

const results = []
try {
  for (const name of scenarios) {
    query.set('bench', name)
    const url = `http://localhost:4173/?${query}`
    console.log(`\n▶ ${name}  ${url}`)
    const code = await new Promise((resolve) => {
      const child = spawn(runner, [url, out, '1600', '960'], { stdio: 'inherit' })
      child.on('exit', (c) => resolve(c ?? 1))
    })
    if (code !== 0) console.error(`  ${name} exited with ${code}`)
    try {
      results.push(JSON.parse(await readFile(join(out, `${name}.json`), 'utf8')))
    } catch {
      results.push({ scenario: name, failed: true })
    }
  }
} finally {
  server.httpServer.close()
}

const f = (v, d = 1) => (typeof v === 'number' ? v.toFixed(d) : '—')
const rows = results.map((r) => r.failed
  ? `| ${r.scenario} | failed ||||||||||||||`
  : `| ${r.scenario} | ${f(r.fps)} | ${f(r.low1)} | ${f(r.p50)} | ${f(r.p95)} | ${f(r.p99)} | ${f(r.cpuMean)} | ${r.gpuWait == null ? '—' : f(r.gpuWait)} | ${Math.round(r.calls)} | ${f(r.triangles / 1e6, 2)}M | ${r.width}×${r.height} (${f(r.dpr, 2)}x) | ${r.textures}/${r.geometries} | ${r.spikes} | ${f(r.stability?.flicker, 2)} | ${f(r.stability?.flickerPeak, 2)} | ${f(r.stability?.edgeJitter, 2)} |`)
const table = [
  `## ${label}`,
  '',
  '| scenario | avg FPS | 1% low | p50 ms | p95 ms | p99 ms | CPU ms | GPU wait ms | draws | tris | render size | tex/geo | spikes | flicker | peak | edge px |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows,
  '',
].join('\n')
await writeFile(join(out, 'summary.md'), table)
console.log(`\n${table}`)
