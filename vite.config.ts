import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { rmSync } from 'node:fs'

// Tauri expects a fixed dev port. `TAURI_ENV_*` variables are set by the Tauri CLI.
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [
    react(),
    {
      // The WASM simulation is only for browser development; the desktop app
      // runs the simulation natively, so keep it out of the Tauri bundle.
      name: 'strip-browser-sim',
      apply: 'build',
      closeBundle() {
        if (process.env.TAURI_ENV_PLATFORM) rmSync('dist/sim', { recursive: true, force: true })
      },
    },
  ],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**', '**/target/**', '**/crates/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  worker: { format: 'es' },
  build: {
    // WKWebView on macOS 13+ (Safari 16)
    target: 'safari16',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        // Only three.js core gets its own chunk (the menu needs its math classes).
        // Grouping the atmosphere, postprocessing and 3D Tiles libraries by hand made
        // the bundler hoist three.js into that group, so the menu's first paint
        // waited for ~1.7 MB of scene code; left alone, they load with the lazy scene.
        manualChunks(id: string) {
          if (id.includes('node_modules/three/build/')) return 'three'
          return undefined
        },
      },
    },
  },
})
