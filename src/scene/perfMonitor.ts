// Frame-time, draw-call and GPU-resource monitor shared by the in-flight
// overlay and the benchmark harness. Kept free of React and R3F so the menu
// bundle can read it without pulling in the 3D scene.

import type { WebGLRenderer } from 'three'
import { FrameStats, type FrameSummary } from './perfStats'

export interface PerfSnapshot extends FrameSummary {
  width: number
  height: number
  dpr: number
  geometries: number
  textures: number
  programs: number
  /** JS heap in MB, where the engine exposes it (Chromium only). */
  heapMB: number | null
  /** Mean time the CPU waited for the GPU to drain the frame (ms); only measured in GPU-sync mode. */
  gpuWait: number | null
  /** Mean GPU time per composer pass (ms); only measured in GPU-sync mode. */
  passes: Record<string, number> | null
}

interface TimedPass {
  name: string
  render: (...args: unknown[]) => void
  effects?: { name: string }[]
}

type Listener = (s: PerfSnapshot) => void

class PerfMonitor {
  readonly stats = new FrameStats(1800)
  private frameStart = 0
  private lastStart = 0
  /**
   * Forces a GPU round trip at the end of each frame to estimate GPU frame time.
   * This defeats CPU/GPU pipelining, so only diagnostic benchmark runs use it.
   */
  gpuSync = false
  private gpuWaitTotal = 0
  private gpuWaitFrames = 0
  private readonly pixel = new Uint8Array(4)
  private listeners = new Set<Listener>()
  private composer: { passes: TimedPass[] } | null = null
  private readonly wrapped = new WeakSet<TimedPass>()
  private readonly passTotals = new Map<string, number>()
  private passFrames = 0
  private lastPublish = 0
  latest: PerfSnapshot | null = null
  /** Free-form render state for the overlay and benchmark (e.g. the adaptive cloud level). */
  readonly notes: Record<string, number | string> = {}

  begin(gl: WebGLRenderer) {
    const now = performance.now()
    this.frameStart = now
    if (this.lastStart === 0) this.lastStart = now
    gl.info.autoReset = false
    gl.info.reset()
    this.gl = gl
    if (this.gpuSync && this.composer) {
      this.passFrames++
      for (const pass of this.composer.passes) if (!this.wrapped.has(pass)) this.wrapPass(pass, gl)
    }
  }

  /** The effect composer whose passes GPU-sync mode times individually. */
  readonly attachComposer = (composer: { passes: unknown[] } | null) => {
    this.composer = composer as { passes: TimedPass[] } | null
  }

  private sync(gl: WebGLRenderer) {
    const ctx = gl.getContext()
    // finish() commits every queued command buffer; the read then waits for the GPU.
    // (A read alone only waits for work touching the bound framebuffer on Metal.)
    ctx.finish()
    ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, this.pixel)
  }

  private gl: WebGLRenderer | null = null

  /** Times a nested pass (e.g. one stage of an effect) under its own label in GPU-sync mode. */
  track(label: string, pass: object, method = 'render') {
    const timed = pass as unknown as TimedPass
    if (this.wrapped.has(timed)) return
    this.wrapPass(timed, null, label, method as 'render')
  }

  private wrapPass(pass: TimedPass, gl: WebGLRenderer | null, name?: string, method: 'render' = 'render') {
    this.wrapped.add(pass)
    const render = pass[method]
    const label = name ?? (pass.effects?.length ? pass.effects.map((e) => e.name.replace(/Effect$/, '')).join('+') : pass.name)
    pass[method] = (...args: unknown[]) => {
      const renderer = gl ?? this.gl
      if (!this.gpuSync || !renderer) return render.apply(pass, args)
      // Drain earlier work, then time this pass alone (binds whatever framebuffer is current).
      this.sync(renderer)
      const t = performance.now()
      render.apply(pass, args)
      this.sync(renderer)
      this.passTotals.set(label, (this.passTotals.get(label) ?? 0) + performance.now() - t)
    }
  }

  end(gl: WebGLRenderer) {
    const now = performance.now()
    const cpu = now - this.frameStart
    if (this.gpuSync) {
      const ctx = gl.getContext()
      const t = performance.now()
      ctx.finish()
      // A 1-pixel read blocks until the queued commands have executed.
      ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, this.pixel)
      this.gpuWaitTotal += performance.now() - t
      this.gpuWaitFrames++
    }
    const interval = this.frameStart - this.lastStart
    this.lastStart = this.frameStart
    // Frames after a hidden tab or a long stall are not representative.
    if (interval > 0 && interval < 1000) {
      this.stats.push({ interval, cpu, calls: gl.info.render.calls, triangles: gl.info.render.triangles })
    }
    if (now - this.lastPublish > 500) {
      this.lastPublish = now
      this.publish(gl)
    }
  }

  private publish(gl: WebGLRenderer) {
    const window = Math.min(this.stats.count, 240)
    const canvas = gl.domElement
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
    this.latest = {
      ...this.stats.summary(window),
      width: canvas.width,
      height: canvas.height,
      dpr: gl.getPixelRatio(),
      geometries: gl.info.memory.geometries,
      textures: gl.info.memory.textures,
      programs: gl.info.programs?.length ?? 0,
      heapMB: heap ? heap.usedJSHeapSize / 1048576 : null,
      gpuWait: this.gpuWaitFrames ? this.gpuWaitTotal / this.gpuWaitFrames : null,
      passes: this.passFrames ? Object.fromEntries([...this.passTotals].map(([k, v]) => [k, v / this.passFrames])) : null,
    }
    this.gpuWaitTotal = this.gpuWaitFrames = 0
    this.passTotals.clear()
    this.passFrames = 0
    for (const l of this.listeners) l(this.latest)
  }

  subscribe(l: Listener) {
    this.listeners.add(l)
    return () => { this.listeners.delete(l) }
  }

  reset() {
    this.stats.clear()
    this.lastStart = 0
    this.gpuWaitTotal = this.gpuWaitFrames = 0
    this.passTotals.clear()
    this.passFrames = 0
  }
}

export const perfMonitor = new PerfMonitor()

/** `?perf` shows the overlay without the setting; `?bench=…` runs a scripted benchmark. */
export const PERF_FORCED = typeof location !== 'undefined' && /[?&](bench|perf)\b/.test(location.search)


/**
 * Benchmark-only overrides, e.g. `?bench=ocean&tune=clouds.maxIterationCount:200,lightShafts:false`.
 * Applied to an object each frame so experiments can isolate one setting at a time.
 */
export const TUNING: [string[], number | boolean][] = PERF_FORCED
  ? (new URLSearchParams(location.search).get('tune') ?? '').split(',').filter(Boolean).map((pair) => {
    const [key, raw] = pair.split(':')
    return [key.split('.'), raw === 'true' ? true : raw === 'false' ? false : Number(raw)]
  })
  : []

export function applyTuning(target: object, prefix: string) {
  for (const [path, value] of TUNING) {
    if (path[0] !== prefix) continue
    let object = target as Record<string, unknown>
    for (const key of path.slice(1, -1)) object = object[key] as Record<string, unknown>
    const last = path[path.length - 1]
    if (object[last] !== value) object[last] = value
  }
}
