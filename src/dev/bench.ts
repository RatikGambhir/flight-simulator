// Scripted flight benchmark. Loaded only with `?bench=<scenario>` (see
// scripts/bench.mjs, which drives it inside WKWebView, the engine Tauri uses
// on macOS). Spawns the aircraft at a fixed place and time, lets the autopilot
// hold heading and altitude, waits for the scenery to settle, then records
// frame statistics, GPU resource counts and tile-streaming activity.

import { applySelection } from '../flight'
import { perfMonitor } from '../scene/perfMonitor'
import { useWorldStatus } from '../scene/worldStatus'
import { Flags, S } from '../sim/protocol'
import { sim } from '../sim/simClient'
import { useApp, type Settings } from '../state/store'

interface Scenario {
  lat: number
  lon: number
  heading: number
  aglFt: number
  speedKt?: number
  /** Local solar hour. */
  hour: number
  /** Seconds to wait for tiles to settle before recording (0: record while streaming). */
  settle: number
  record: number
  camera?: 'chase' | 'cockpit'
  /** Heading change (deg) commanded when recording starts, so the aircraft banks against the sky. */
  turn?: number
}

export const SCENARIOS: Record<string, Scenario> = {
  ocean: { lat: 37.55, lon: -123.25, heading: 270, aglFt: 3000, hour: 13, settle: 25, record: 20 },
  mountains: { lat: 46.62, lon: 7.85, heading: 140, aglFt: 4000, hour: 11, settle: 30, record: 20 },
  city: { lat: 40.70, lon: -74.02, heading: 25, aglFt: 2500, hour: 14, settle: 30, record: 20 },
  night: { lat: 40.70, lon: -74.02, heading: 25, aglFt: 2500, hour: 23, settle: 30, record: 20 },
  sunset: { lat: 37.70, lon: -122.55, heading: 260, aglFt: 3000, hour: 16.95, settle: 25, record: 20 },
  highspeed: { lat: 46.30, lon: 7.40, heading: 60, aglFt: 3500, speedKt: 340, hour: 12, settle: 4, record: 20 },
  turn: { lat: 37.55, lon: -123.25, heading: 270, aglFt: 3000, hour: 13, settle: 25, record: 20, turn: 120 },
  cockpit: { lat: 46.62, lon: 7.85, heading: 140, aglFt: 4000, hour: 11, settle: 30, record: 20, camera: 'cockpit' },
  // Long, fast and flat (Kansas), so tiles stream and unload continuously for the whole run.
  soak: { lat: 38.5, lon: -99.5, heading: 90, aglFt: 2500, speedKt: 340, hour: 12, settle: 4, record: 150 },
}

type Post = (msg: Record<string, unknown>) => void
const handler = (window as unknown as { webkit?: { messageHandlers?: { bench?: { postMessage: Post } } } }).webkit?.messageHandlers?.bench
const post: Post = (msg) => {
  handler?.postMessage(msg)
  if (!handler) console.info('[bench]', msg)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function tileStats() {
  const world = useWorldStatus.getState().world
  if (!world) return null
  let bytes = 0
  let visible = 0
  let downloading = 0
  let parsing = 0
  for (const { tiles } of world.layers) {
    const t = tiles as unknown as { lruCache: { cachedBytes?: number }; stats?: { visible?: number; downloading?: number; parsing?: number }; visibleTiles?: Set<unknown> }
    bytes += t.lruCache.cachedBytes ?? 0
    visible += t.visibleTiles?.size ?? t.stats?.visible ?? 0
    downloading += t.stats?.downloading ?? 0
    parsing += t.stats?.parsing ?? 0
  }
  return { cacheMB: bytes / 1048576, visible, downloading, parsing, progress: world.loadProgress }
}

function requestCounts() {
  const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
  const urls = new Set<string>()
  for (const e of entries) urls.add(e.name)
  return { requests: entries.length, unique: urls.size }
}

async function run(name: string) {
  const scenario = SCENARIOS[name]
  if (!scenario) throw new Error(`Unknown benchmark scenario "${name}"`)
  const params = new URLSearchParams(location.search)
  perfMonitor.gpuSync = params.has('gpusync')
  performance.setResourceTimingBufferSize?.(200000)

  const patch: Partial<Settings> = {
    provider: 'open',
    openImagery: 'esri',
    quality: (params.get('quality') as Settings['quality']) ?? 'high',
    renderScale: 1,
    adaptiveResolution: params.get('adaptive') !== '0',
    clouds: true,
    cloudCoverage: 0.35,
    shadows: true,
    realTime: false,
    timeOfDay: scenario.hour,
    liveWeather: false,
    volume: 0,
    callouts: false,
    showFps: false,
    turbulence: 0,
    windSpeedKt: 5,
  }
  if (params.get('glass') === '0') {
    const style = document.createElement('style')
    style.textContent = '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}'
    document.head.appendChild(style)
  }
  await sim.ready
  const app = useApp.getState()
  app.updateSettings(patch)
  app.setAircraft('b737')
  app.setSpawn({ kind: 'coords', label: name, lat: scenario.lat, lon: scenario.lon, mode: 'air', aglFt: scenario.aglFt, heading: scenario.heading, elevationFt: null })
  applySelection({ paused: false })
  if (scenario.speedKt) {
    sim.command({ type: 'spawn', lat: scenario.lat, lon: scenario.lon, heading: scenario.heading, mode: 'air', agl_ft: scenario.aglFt, speed_kt: scenario.speedKt, ground_elevation_ft: null })
  }
  app.setCamera(scenario.camera ?? 'chase')
  app.setPhase('flying')
  post({ type: 'log', text: `spawned ${name}` })

  // Wait for the sim to place the aircraft above the streamed ground, then hold it there.
  const t0 = performance.now()
  while ((sim.latest[S.FLAGS] & Flags.AWAITING_GROUND) && performance.now() - t0 < 20000) await sleep(200)
  const altitudeFt = sim.latest[S.HEIGHT] / 0.3048
  sim.command({ type: 'autopilot', engaged: true, heading_hold: true, altitude_hold: true, autothrottle: true, heading: scenario.heading, altitude_ft: Math.round(altitudeFt), speed_kt: scenario.speedKt ?? 250 })

  // Settle: scenery fully refined for 2 s, or the time limit.
  const settleStart = performance.now()
  let stableSince = 0
  while (performance.now() - settleStart < scenario.settle * 1000) {
    const t = tileStats()
    if (t && t.progress >= 0.995) {
      stableSince ||= performance.now()
      if (performance.now() - stableSince > 2000) break
    } else {
      stableSince = 0
    }
    await sleep(250)
  }
  const settledIn = (performance.now() - settleStart) / 1000

  const requestsBefore = requestCounts()
  if (scenario.turn) sim.command({ type: 'autopilot', heading_delta: scenario.turn })
  // Hitch log: the slowest frames, with what the tile streamer was doing at the time.
  const hitches: { t: number; ms: number; downloading: number; parsing: number; textures: number }[] = []
  let lastFrame = 0
  let recording = true
  const recordT0 = performance.now()
  const watch = (now: number) => {
    if (!recording) return
    if (lastFrame) {
      const ms = now - lastFrame
      if (ms > 25) {
        const t = tileStats()
        hitches.push({ t: Math.round(now - recordT0), ms: Math.round(ms), downloading: t?.downloading ?? 0, parsing: t?.parsing ?? 0, textures: perfMonitor.latest?.textures ?? 0 })
      }
    }
    lastFrame = now
    requestAnimationFrame(watch)
  }
  requestAnimationFrame(watch)
  perfMonitor.reset()
  const memory: { t: number; textures: number; geometries: number; cacheMB: number; cloudLevel?: number | string }[] = []
  const recordStart = performance.now()
  let snapshotTaken = false
  const passSums: Record<string, number> = {}
  let passSamples = 0
  while (performance.now() - recordStart < scenario.record * 1000) {
    await sleep(1000)
    const s = perfMonitor.latest
    const t = tileStats()
    if (s?.passes) {
      passSamples++
      for (const [k, v] of Object.entries(s.passes)) passSums[k] = (passSums[k] ?? 0) + v
    }
    memory.push({ t: Math.round((performance.now() - recordStart) / 1000), textures: s?.textures ?? 0, geometries: s?.geometries ?? 0, cacheMB: t?.cacheMB ?? 0, cloudLevel: perfMonitor.notes.cloudLevel })
    // Mid-turn screenshot for the turning scenario only; a WebKit snapshot stalls a frame
    // for ~190 ms, so every other scenario captures after the measurement window.
    if (scenario.turn && !snapshotTaken && performance.now() - recordStart > 4000) {
      snapshotTaken = true
      post({ type: 'snapshot', name })
    }
  }
  recording = false
  const summary = perfMonitor.stats.summary()
  if (!snapshotTaken) post({ type: 'snapshot', name })
  hitches.sort((a, b) => b.ms - a.ms)
  const requestsAfter = requestCounts()
  const latest = perfMonitor.latest
  post({
    type: 'result',
    name,
    result: {
      scenario: name,
      settings: { quality: patch.quality, adaptive: patch.adaptiveResolution, gpuSync: perfMonitor.gpuSync },
      settledIn,
      ...summary,
      width: latest?.width,
      height: latest?.height,
      dpr: latest?.dpr,
      cssWidth: innerWidth,
      cssHeight: innerHeight,
      devicePixelRatio,
      programs: latest?.programs,
      textures: latest?.textures,
      geometries: latest?.geometries,
      gpuWait: latest?.gpuWait,
      passes: passSamples ? Object.fromEntries(Object.entries(passSums).map(([k, v]) => [k, Math.round(v / passSamples * 100) / 100])) : null,
      tiles: tileStats(),
      notes: { ...perfMonitor.notes },
      requests: requestsAfter.requests - requestsBefore.requests,
      repeatRequests: (requestsAfter.requests - requestsAfter.unique) - (requestsBefore.requests - requestsBefore.unique),
      memory,
      hitches: hitches.slice(0, 15),
      altitudeFt: Math.round(sim.latest[S.HEIGHT] / 0.3048),
      aglFt: Math.round(sim.latest[S.AGL_FT]),
      crashed: useApp.getState().crashed,
    },
  })
  post({ type: 'done' })
}

const name = new URLSearchParams(location.search).get('bench')
if (name) {
  run(name).catch((err: unknown) => {
    post({ type: 'error', text: String(err instanceof Error ? err.stack ?? err.message : err) })
    post({ type: 'done' })
  })
}
