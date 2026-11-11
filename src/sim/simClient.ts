// Frontend side of the simulation: receives snapshots from the transport,
// keeps a short history and produces a smoothly interpolated render state
// for each display frame (the physics runs at a fixed 120 Hz, snapshots
// arrive at ~60 Hz with jitter, and the display may run at 60-120 Hz).

import { Quaternion } from 'three'
import { createTransport, type SimTransport } from './transport'
import { S, type ControlInput, type SimCommand, type SimEvent, type WorldQuery } from './protocol'

/** Interpolation delay behind the newest snapshot (seconds). */
const RENDER_DELAY = 0.03
const HISTORY = 8


export interface RenderState {
  valid: boolean
  generation: number
  x: number
  y: number
  z: number
  quat: Quaternion
  gear: number
  flaps: number
  spoilers: number
  aileron: number
  elevator: number
  rudder: number
  engine: number
  /** Raw newest snapshot for values that don't need smoothing. */
  latest: Float64Array
}

const _qa = new Quaternion()
const _qb = new Quaternion()

class SimClient {
  private transport: SimTransport = createTransport()
  readonly latest = new Float64Array(S.LEN)
  /** Ring buffer of recent snapshots (preallocated; no per-snapshot garbage). */
  private ring: Float64Array[] = Array.from({ length: HISTORY }, () => new Float64Array(S.LEN))
  private head = 0
  private count = 0
  private clockOffset: number | null = null
  private eventListeners = new Set<(e: SimEvent) => void>()
  private lastInput: ControlInput = { pitch: 0, roll: 0, yaw: 0, throttle_rate: 0, brake: 0, reverse: 0 }
  private lastInputSent = 0
  readonly ready: Promise<void>
  snapshotsReceived = 0

  readonly render: RenderState = {
    valid: false,
    generation: -1,
    x: 0,
    y: 0,
    z: 0,
    quat: new Quaternion(),
    gear: 1,
    flaps: 0,
    spoilers: 0,
    aileron: 0,
    elevator: 0,
    rudder: 0,
    engine: 0,
    latest: this.latest,
  }

  constructor() {
    this.ready = this.transport.start(
      (s) => this.onSnapshot(s),
      (events) => events.forEach((e) => this.eventListeners.forEach((l) => l(e))),
    )
  }

  get transportKind() {
    return this.transport.kind
  }

  private onSnapshot(s: Float64Array) {
    if (s.length < S.LEN) return
    this.snapshotsReceived++
    const now = performance.now() / 1000
    if (s[S.GENERATION] !== this.latest[S.GENERATION]) {
      this.count = 0
    }
    this.latest.set(s.subarray(0, S.LEN))
    // Track the local-clock minus sim-clock offset. Snap down immediately
    // (earliest arrival = least delayed), drift up slowly to follow pauses.
    const off = now - s[S.TIME]
    if (this.clockOffset === null || off < this.clockOffset || off - this.clockOffset > 1) {
      this.clockOffset = off
    } else {
      this.clockOffset += (off - this.clockOffset) * 0.01
    }
    this.head = (this.head + 1) % HISTORY
    this.ring[this.head].set(s.subarray(0, S.LEN))
    this.count = Math.min(this.count + 1, HISTORY)
  }

  /** i-th snapshot from oldest (0) to newest (count - 1). */
  private at(i: number): Float64Array {
    return this.ring[(this.head - (this.count - 1 - i) + HISTORY) % HISTORY]
  }

  /** Computes the interpolated render state for the current display time. */
  sample(): RenderState {
    const r = this.render
    const n = this.count
    if (n === 0 || this.clockOffset === null) {
      r.valid = false
      return r
    }
    const t = performance.now() / 1000 - this.clockOffset - RENDER_DELAY
    let a = this.at(0)
    let b = this.at(n - 1)
    let f = 1
    if (t <= a[S.TIME]) {
      b = a
      f = 0
    } else if (t < b[S.TIME]) {
      for (let i = n - 1; i > 0; i--) {
        const prev = this.at(i - 1)
        if (prev[S.TIME] <= t) {
          a = prev
          b = this.at(i)
          const span = b[S.TIME] - a[S.TIME]
          f = span > 1e-6 ? (t - a[S.TIME]) / span : 1
          break
        }
      }
    } else {
      a = b
      f = 1
    }
    const lerp = (i: number) => a[i] + (b[i] - a[i]) * f
    r.valid = true
    r.generation = b[S.GENERATION]
    r.x = lerp(S.ECEF_X)
    r.y = lerp(S.ECEF_Y)
    r.z = lerp(S.ECEF_Z)
    _qa.set(a[S.QX], a[S.QY], a[S.QZ], a[S.QW])
    _qb.set(b[S.QX], b[S.QY], b[S.QZ], b[S.QW])
    r.quat.slerpQuaternions(_qa, _qb, f)
    r.gear = lerp(S.GEAR)
    r.flaps = lerp(S.FLAPS)
    r.spoilers = lerp(S.SPOILERS)
    r.aileron = lerp(S.AILERON)
    r.elevator = lerp(S.ELEVATOR)
    r.rudder = lerp(S.RUDDER)
    r.engine = lerp(S.ENGINE)
    return r
  }

  onEvent(cb: (e: SimEvent) => void) {
    this.eventListeners.add(cb)
    return () => {
      this.eventListeners.delete(cb)
    }
  }

  /** Sends pilot inputs; deduplicated, with a 4 Hz keep-alive. */
  setInput(input: ControlInput) {
    const now = performance.now()
    const p = this.lastInput
    const same =
      Math.abs(p.pitch - input.pitch) < 1e-3 &&
      Math.abs(p.roll - input.roll) < 1e-3 &&
      Math.abs(p.yaw - input.yaw) < 1e-3 &&
      p.throttle_rate === input.throttle_rate &&
      p.brake === input.brake &&
      p.reverse === input.reverse
    if (same && now - this.lastInputSent < 250) return
    Object.assign(this.lastInput, input)
    this.lastInputSent = now
    this.transport.sendInput(input)
  }

  command(cmd: SimCommand) {
    this.transport.sendCommand(cmd)
  }

  query<T>(q: WorldQuery): Promise<T> {
    return this.ready.then(() => this.transport.query<T>(q))
  }
}

export const sim = new SimClient()
