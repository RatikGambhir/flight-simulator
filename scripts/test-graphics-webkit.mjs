import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const destination = process.argv[2]
const output = destination ?? await mkdtemp(join(tmpdir(), 'geoflight-graphics-'))
try {
  // Embed the production cloud assets so WebKit's file-origin test can use
  // exactly the same density fields and temporal noise without network access.
  const cloudFixtures = Object.fromEntries(await Promise.all(
    ['local_weather.png', 'shape.bin', 'shape_detail.bin', 'turbulence.png', 'stbn.bin'].map(async name =>
      [name, (await readFile(new URL(`../public/clouds/${name}`, import.meta.url))).toString('base64')]),
  ))
  await build({
    configFile: false,
    publicDir: false,
    logLevel: 'error',
    define: {
      __CLOUD_FIXTURES__: JSON.stringify(cloudFixtures),
      __WATER_FIXTURE__: JSON.stringify((await readFile(new URL('../public/water/shorelines.bin', import.meta.url))).toString('base64')),
    },
    build: {
      outDir: output,
      rollupOptions: {
        input: fileURLToPath(new URL('./graphics-render.mjs', import.meta.url)),
        output: { format: 'iife', codeSplitting: false, entryFileNames: 'graphics.js' },
      },
    },
  })
  const page = join(output, 'index.html')
  await writeFile(page, '<!doctype html><meta charset="utf-8"><title>GeoFlight graphics</title><pre>Running WebGL checks…</pre><script src="./graphics.js"></script>')
  if (!destination) {
    if (process.platform !== 'darwin') throw new Error('The graphics render tests require macOS WebKit')
    const runner = fileURLToPath(new URL('./graphics-webkit.swift', import.meta.url))
    const result = spawnSync('swift', ['-module-cache-path', join(output, 'swift-cache'), runner, page], {
      stdio: 'inherit',
      timeout: 120_000,
    })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
  }
} finally {
  if (!destination) await rm(output, { recursive: true, force: true })
}
