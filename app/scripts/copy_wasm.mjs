// Copies the browser-dev WASM build of the simulation core into public/.
import { copyFileSync, mkdirSync } from 'node:fs'
const src = new URL('../target/wasm32-unknown-unknown/release/sim_wasm.wasm', import.meta.url)
const dst = new URL('../public/sim/sim.wasm', import.meta.url)
mkdirSync(new URL('../public/sim/', import.meta.url), { recursive: true })
copyFileSync(src, dst)
console.log('copied sim.wasm ->', dst.pathname)
