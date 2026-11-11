// Transports connect the UI to the Rust simulation core.
//  * TauriTransport — native sim thread in the desktop app (production).
//  * WorkerTransport — the same Rust core compiled to WASM, running in a Web
//    Worker, for `npm run dev:web` in a regular browser.
// Both deliver identical binary snapshots (Float64Array, see protocol.ts).

import type { ControlInput, SimCommand, SimEvent, WorldQuery } from './protocol'

export interface SimTransport {
  readonly kind: 'tauri' | 'wasm'
  start(onSnapshot: (s: Float64Array) => void, onEvents: (e: SimEvent[]) => void): Promise<void>
  sendInput(input: ControlInput): void
  sendCommand(cmd: SimCommand): void
  query<T>(q: WorldQuery): Promise<T>
}

export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

class TauriTransport implements SimTransport {
  readonly kind = 'tauri' as const
  private invoke!: typeof import('@tauri-apps/api/core').invoke

  async start(onSnapshot: (s: Float64Array) => void, onEvents: (e: SimEvent[]) => void) {
    const core = await import('@tauri-apps/api/core')
    this.invoke = core.invoke
    const snapshots = new core.Channel<ArrayBuffer>()
    snapshots.onmessage = (buf) => onSnapshot(new Float64Array(buf))
    const events = new core.Channel<SimEvent[]>()
    events.onmessage = (e) => onEvents(e)
    await this.invoke('sim_subscribe', { snapshots, events })
  }

  sendInput(input: ControlInput) {
    void this.invoke('sim_input', { input }).catch(console.error)
  }

  sendCommand(command: SimCommand) {
    void this.invoke('sim_command', { command }).catch(console.error)
  }

  query<T>(query: WorldQuery): Promise<T> {
    return this.invoke<T>('world_query', { query })
  }
}

type WorkerReply =
  | { type: 'ready' }
  | { type: 'snapshot'; data: Float64Array }
  | { type: 'events'; events: SimEvent[] }
  | { type: 'query'; id: number; json: string }
  | { type: 'error'; message: string }

class WorkerTransport implements SimTransport {
  readonly kind = 'wasm' as const
  private worker!: Worker
  private nextId = 1
  private pending = new Map<number, (v: unknown) => void>()

  start(onSnapshot: (s: Float64Array) => void, onEvents: (e: SimEvent[]) => void) {
    this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' })
    return new Promise<void>((resolve, reject) => {
      this.worker.onmessage = (ev: MessageEvent<WorkerReply>) => {
        const m = ev.data
        switch (m.type) {
          case 'ready':
            resolve()
            break
          case 'snapshot':
            onSnapshot(m.data)
            break
          case 'events':
            onEvents(m.events)
            break
          case 'query': {
            const cb = this.pending.get(m.id)
            this.pending.delete(m.id)
            cb?.(JSON.parse(m.json))
            break
          }
          case 'error':
            reject(new Error(m.message))
            break
        }
      }
      this.worker.postMessage({ type: 'init', url: new URL('/sim/sim.wasm', location.href).href })
    })
  }

  sendInput(input: ControlInput) {
    this.worker.postMessage({ type: 'input', input })
  }

  sendCommand(cmd: SimCommand) {
    this.worker.postMessage({ type: 'command', json: JSON.stringify(cmd) })
  }

  query<T>(q: WorldQuery): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve) => {
      this.pending.set(id, resolve as (v: unknown) => void)
      this.worker.postMessage({ type: 'query', id, json: JSON.stringify(q) })
    })
  }
}

export function createTransport(): SimTransport {
  return isTauri() ? new TauriTransport() : new WorkerTransport()
}
