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
        manualChunks(id: string) {
          if (id.includes('node_modules/three/')) return 'three'
          if (id.includes('3d-tiles-renderer')) return 'tiles'
          if (id.includes('@takram') || id.includes('postprocessing')) return 'atmosphere'
          return undefined
        },
      },
    },
  },
})
