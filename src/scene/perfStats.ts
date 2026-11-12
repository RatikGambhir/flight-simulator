// Frame statistics for the performance overlay and the benchmark harness.
// Pure data (no three.js / DOM), so the percentile maths is unit-testable.

export interface FrameSample {
  /** Wall-clock interval since the previous frame (ms). */
  interval: number
  /** Main-thread time spent inside the frame: simulation, culling, command submission (ms). */
  cpu: number
  /** Draw calls submitted across every render pass of the frame. */
  calls: number
  triangles: number
}

export interface FrameSummary {
  frames: number
  /** Mean frames per second over the window (frames / elapsed time). */
  fps: number
  /** "1% low": the frame rate of the slowest 1% of frames. */
  low1: number
  p50: number
  p95: number
  p99: number
  max: number
  cpuMean: number
  cpuP95: number
  calls: number
  triangles: number
  /** Frames longer than 2x the median: visible hitches. */
  spikes: number
}

/** Fixed-size ring buffer of frame samples; no allocation per frame. */
export class FrameStats {
  private readonly interval: Float32Array
  private readonly cpu: Float32Array
  private readonly calls: Float32Array
  private readonly triangles: Float32Array
  private head = 0
  count = 0
  readonly capacity: number

  constructor(capacity = 1200) {
    this.capacity = capacity
    this.interval = new Float32Array(capacity)
    this.cpu = new Float32Array(capacity)
    this.calls = new Float32Array(capacity)
    this.triangles = new Float32Array(capacity)
  }

  push(s: FrameSample) {
    const i = this.head
    this.interval[i] = s.interval
    this.cpu[i] = s.cpu
    this.calls[i] = s.calls
    this.triangles[i] = s.triangles
    this.head = (i + 1) % this.capacity
    if (this.count < this.capacity) this.count++
  }

  clear() {
    this.head = 0
    this.count = 0
  }

  /** Statistics over the most recent `window` frames (all retained frames by default). */
  summary(window = this.count): FrameSummary {
    const n = Math.min(window, this.count)
    if (n === 0) return { frames: 0, fps: 0, low1: 0, p50: 0, p95: 0, p99: 0, max: 0, cpuMean: 0, cpuP95: 0, calls: 0, triangles: 0, spikes: 0 }
    const intervals = new Float64Array(n)
    const cpu = new Float64Array(n)
    let total = 0
    let cpuTotal = 0
    let calls = 0
    let triangles = 0
    for (let k = 0; k < n; k++) {
      const i = (this.head - 1 - k + this.capacity) % this.capacity
      intervals[k] = this.interval[i]
      cpu[k] = this.cpu[i]
      total += this.interval[i]
      cpuTotal += this.cpu[i]
      calls += this.calls[i]
      triangles += this.triangles[i]
    }
    intervals.sort()
    cpu.sort()
    const p50 = percentile(intervals, 0.5)
    // Mean of the slowest 1% of frames (at least one frame), expressed as a rate.
    const worst = Math.max(1, Math.floor(n * 0.01))
    let worstTotal = 0
    for (let k = n - worst; k < n; k++) worstTotal += intervals[k]
    let spikes = 0
    for (let k = 0; k < n; k++) if (intervals[k] > p50 * 2) spikes++
    return {
      frames: n,
      fps: total > 0 ? (n * 1000) / total : 0,
      low1: worstTotal > 0 ? (worst * 1000) / worstTotal : 0,
      p50,
      p95: percentile(intervals, 0.95),
      p99: percentile(intervals, 0.99),
      max: intervals[n - 1],
      cpuMean: cpuTotal / n,
      cpuP95: percentile(cpu, 0.95),
      calls: calls / n,
      triangles: triangles / n,
      spikes,
    }
  }
}

/** Linear-interpolated percentile of an ascending array. */
export function percentile(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length
  if (n === 0) return 0
  const x = Math.min(n - 1, Math.max(0, q * (n - 1)))
  const lo = Math.floor(x)
  const hi = Math.min(n - 1, lo + 1)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (x - lo)
}
