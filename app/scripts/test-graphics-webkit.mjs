import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const destination = process.argv[2]
const output = destination ?? await mkdtemp(join(tmpdir(), 'geoflight-graphics-'))
try {
  await build({
    configFile: false,
    publicDir: false,
    logLevel: 'error',
    define: { 'import.meta.url': 'document.baseURI' },
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
