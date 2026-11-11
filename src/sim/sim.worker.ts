/// <reference lib="webworker" />
// Runs the Rust simulation core (compiled to WASM) off the main thread when
// the app is opened in a regular browser. Mirrors the native sim thread:
// fixed-step physics driven by a ~250 Hz timer, snapshots posted at ~60 Hz.

interface SimExports {
  memory: WebAssembly.Memory
  io_reserve(len: number): number
  io_ptr(): number
  sim_advance(elapsed: number): number
  sim_snapshot(): number
  sim_snapshot_len(): number
  sim_input(pitch: number, roll: number, yaw: number, throttleRate: number, brake: number): void
  sim_command(): number
  sim_events(): number
  world_query(): number
}

const ctx = self as unknown as DedicatedWorkerGlobalScope
let wasm: SimExports
const enc = new TextEncoder()
const dec = new TextDecoder()

function writeIo(s: string) {
  const bytes = enc.encode(s)
  const ptr = wasm.io_reserve(bytes.length)
  new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes)
}

function readIo(len: number): string {
  if (len === 0) return ''
  return dec.decode(new Uint8Array(wasm.memory.buffer, wasm.io_ptr(), len).slice())
}

function loop() {
  let last = performance.now()
  let lastPublish = 0
  const len = wasm.sim_snapshot_len()
  setInterval(() => {
    const now = performance.now()
    wasm.sim_advance((now - last) / 1000)
    last = now
    if (now - lastPublish >= 16) {
      lastPublish = now
      const ptr = wasm.sim_snapshot()
      const data = new Float64Array(wasm.memory.buffer, ptr, len).slice()
      ctx.postMessage({ type: 'snapshot', data }, [data.buffer])
      const evLen = wasm.sim_events()
      if (evLen > 0) ctx.postMessage({ type: 'events', events: JSON.parse(readIo(evLen)) })
    }
  }, 4)
}

ctx.onmessage = async (ev: MessageEvent) => {
  const m = ev.data
  try {
    switch (m.type) {
      case 'init': {
        const { instance } = await WebAssembly.instantiateStreaming(fetch(m.url), {})
        wasm = instance.exports as unknown as SimExports
        loop()
        ctx.postMessage({ type: 'ready' })
        break
      }
      case 'input': {
        const i = m.input
        wasm.sim_input(i.pitch, i.roll, i.yaw, i.throttle_rate, i.brake)
        break
      }
      case 'command':
        writeIo(m.json)
        wasm.sim_command()
        break
      case 'query': {
        writeIo(m.json)
        const n = wasm.world_query()
        ctx.postMessage({ type: 'query', id: m.id, json: readIo(n) })
        break
      }
    }
  } catch (e) {
    ctx.postMessage({ type: 'error', message: String(e) })
  }
}
