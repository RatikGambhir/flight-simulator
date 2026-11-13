// Scripted flight benchmark. Loaded only with `?bench=<scenario>` (see
// scripts/bench.mjs, which drives it inside WKWebView, the engine Tauri uses
// on macOS). Spawns the aircraft at a fixed place and time, lets the autopilot
// hold heading and altitude, waits for the scenery to settle, then records
// frame statistics, GPU resource counts and tile-streaming activity.

import { addAfterEffect } from '@react-three/fiber'
import { Vector3 } from 'three'
import { applySelection } from '../flight'
import { perfMonitor, TUNING } from '../scene/perfMonitor'
import { useWorldStatus } from '../scene/worldStatus'
import { Flags, S } from '../sim/protocol'
import { sim } from '../sim/simClient'
import { providerReady, useApp, type Settings } from '../state/store'
import { frame } from '../world/frame'

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
  /** Cloud cover (0-1); a broken deck by default. */
  coverage?: number
  /** Re-anchor the floating origin 2 km away midway through the stability readback. */
  rebase?: boolean
  /** Step the cloud level (with `--tune=level:N`) midway through the stability readback. */
  relevel?: number
  /** Aircraft id (the 737 by default). */
  aircraft?: string
  /** Start parked on this runway instead of in the air. */
  runway?: { airport: string; name: string; runway: string }
}

export const SCENARIOS: Record<string, Scenario> = {
  haneda: { lat: 35.59, lon: 139.77, heading: 162, aglFt: 700, speedKt: 172, hour: 13, settle: 25, record: 12, coverage: 0 },
  // The reported sunset departure: fast flight through coastal cloud, and the
  // same view beneath an overcast where a black horizon band was visible.
  cloudmotion: { lat: 32.76, lon: -117.38, heading: 275, aglFt: 4000, speedKt: 600, hour: 16.5, settle: 25, record: 12, coverage: 0.5 },
  cloudedge: { lat: 32.76, lon: -117.33, heading: 275, aglFt: 4000, speedKt: 600, hour: 16.5, settle: 4, record: 12, coverage: 0.35 },
  undersunset: { lat: 32.76, lon: -117.38, heading: 275, aglFt: 500, hour: 16.9, settle: 25, record: 12, coverage: 0.8 },
  ocean: { lat: 37.55, lon: -123.25, heading: 270, aglFt: 3000, hour: 13, settle: 25, record: 20 },
  mountains: { lat: 46.62, lon: 7.85, heading: 140, aglFt: 4000, hour: 11, settle: 30, record: 20 },
  city: { lat: 40.70, lon: -74.02, heading: 25, aglFt: 2500, hour: 14, settle: 30, record: 20 },
  night: { lat: 40.70, lon: -74.02, heading: 25, aglFt: 2500, hour: 23, settle: 30, record: 20 },
  sunset: { lat: 37.70, lon: -122.55, heading: 260, aglFt: 3000, hour: 16.95, settle: 25, record: 20 },
  sunset11000: { lat: 37.70, lon: -122.55, heading: 260, aglFt: 11000, hour: 16.95, settle: 25, record: 12 },
  sunset25000: { lat: 37.70, lon: -122.55, heading: 260, aglFt: 25000, hour: 16.95, settle: 25, record: 12 },
  water: { lat: 37.55, lon: -123.25, heading: 270, aglFt: 1500, hour: 13, settle: 25, record: 12, coverage: 0 },
  highspeed: { lat: 46.30, lon: 7.40, heading: 60, aglFt: 3500, speedKt: 340, hour: 12, settle: 4, record: 20 },
  turn: { lat: 37.55, lon: -123.25, heading: 270, aglFt: 3000, hour: 13, settle: 25, record: 20, turn: 120 },
  cockpit: { lat: 46.62, lon: 7.85, heading: 140, aglFt: 4000, hour: 11, settle: 30, record: 20, camera: 'cockpit' },
  // An overcast at low sun, flown in the cloud base and inside the deck. The aircraft and the
  // ground are seen through a few hundred metres of cloud: the worst case for the cloud resolve.
  cloudbase: { lat: 41.977, lon: -87.95, heading: 280, aglFt: 1800, hour: 15.6, settle: 25, record: 20, coverage: 0.7 },
  incloud: { lat: 41.977, lon: -87.95, heading: 280, aglFt: 2800, hour: 15.6, settle: 25, record: 20, coverage: 0.7 },
  // The same overcast from a parked aircraft: nothing moves, so any change between frames is
  // the renderer's own instability (the horizon cloud edge "shaking").
  // ...and with the world origin moved under it: the cloud history has to survive the rebase.
  rebase: { lat: 41.98, lon: -87.9, heading: 280, aglFt: 0, hour: 15.6, settle: 25, record: 6, coverage: 0.7, rebase: true, runway: { airport: 'KORD', name: "Chicago O'Hare International Airport", runway: '28R' } },
  // ...and with the adaptive cloud level changing under it (run with --tune=level:3).
  relevel: { lat: 41.98, lon: -87.9, heading: 280, aglFt: 0, hour: 15.6, settle: 25, record: 6, coverage: 0.7, relevel: 2, runway: { airport: 'KORD', name: "Chicago O'Hare International Airport", runway: '28R' } },
  parked: { lat: 41.98, lon: -87.9, heading: 280, aglFt: 0, hour: 15.6, settle: 25, record: 12, coverage: 0.7, runway: { airport: 'KORD', name: "Chicago O'Hare International Airport", runway: '28R' } },
  cloudnight: { lat: 41.98, lon: -87.9, heading: 270, aglFt: 0, hour: 20.57, settle: 25, record: 12, coverage: 0.5, runway: { airport: 'KORD', name: "Chicago O'Hare International Airport", runway: '28R' } },
  // The same parked view through the day: overhead sun, low sun, and the sun on the horizon.
  cloudnoon: { lat: 41.98, lon: -87.9, heading: 270, aglFt: 0, hour: 12, settle: 25, record: 8, coverage: 0.5, runway: { airport: 'KORD', name: "Chicago O'Hare International Airport", runway: '28R' } },
  cloudlowsun: { lat: 41.98, lon: -87.9, heading: 270, aglFt: 0, hour: 15.6, settle: 25, record: 8, coverage: 0.5, runway: { airport: 'KORD', name: "Chicago O'Hare International Airport", runway: '28R' } },
  // Golden hour (sun ~5 deg up), then the sun on the horizon, then civil dusk (~3 deg below).
  cloudgolden: { lat: 41.98, lon: -87.9, heading: 270, aglFt: 0, hour: 16.37, settle: 25, record: 6, coverage: 0.5, runway: { airport: 'KORD', name: "Chicago O'Hare International Airport", runway: '28R' } },
  clouddusk: { lat: 41.98, lon: -87.9, heading: 270, aglFt: 0, hour: 17.17, settle: 25, record: 6, coverage: 0.5, runway: { airport: 'KORD', name: "Chicago O'Hare International Airport", runway: '28R' } },
  // The same evening from above the deck, looking along it towards the sun.
  cloudtopssunset: { lat: 41.97, lon: -88.06, heading: 250, aglFt: 9000, speedKt: 300, hour: 16.75, settle: 4, record: 6, coverage: 0.5 },
  cloudsunset: { lat: 41.98, lon: -87.9, heading: 270, aglFt: 0, hour: 16.75, settle: 25, record: 8, coverage: 0.5, runway: { airport: 'KORD', name: "Chicago O'Hare International Airport", runway: '28R' } },
  // Among the cumulus by day, turning, so the reconstruction is judged with the camera moving.
  clouddaymotion: { lat: 41.96, lon: -87.89, heading: 270, aglFt: 3500, speedKt: 220, hour: 10.5, settle: 20, record: 10, coverage: 0.5, turn: 30 },
  // Cruise above scattered cumulus over the sea, from the cockpit, towards a mid-height sun:
  // the whole deck is seen from above, far away and at a grazing angle, moving slowly.
  cruise: { lat: 46.78, lon: 151.0, heading: 226, aglFt: 35000, speedKt: 290, hour: 13.5, settle: 6, record: 10, coverage: 0.35, camera: 'cockpit' },
  // The Airbus flight decks: the A380 at cruise, the A320 parked at dusk.
  cruisea380: { lat: 46.78, lon: 151.0, heading: 226, aglFt: 35000, speedKt: 290, hour: 13.5, settle: 6, record: 10, coverage: 0.35, camera: 'cockpit', aircraft: 'a380' },
  parkeda320: { lat: 41.98, lon: -87.9, heading: 270, aglFt: 0, hour: 16.4, settle: 25, record: 8, coverage: 0.5, camera: 'cockpit', aircraft: 'a320', runway: { airport: 'KORD', name: "Chicago O'Hare International Airport", runway: '28R' } },
  cruisechase: { lat: 46.78, lon: 151.0, heading: 226, aglFt: 35000, speedKt: 290, hour: 13.5, settle: 6, record: 10, coverage: 0.35 },
  cloudnightmotion: { lat: 41.96, lon: -87.89, heading: 270, aglFt: 900, speedKt: 180, hour: 20.57, settle: 20, record: 12, coverage: 0.5, turn: 20 },
  cloudtopsnight: { lat: 41.97, lon: -88.06, heading: 308, aglFt: 4300, speedKt: 340, hour: 21.08, settle: 4, record: 12, coverage: 0.4 },
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

/**
 * How much the presented image changes between consecutive frames, read back from three
 * 8-pixel columns of the canvas. `flicker` is the mean change in 8-bit luma. `edgeJitter` is
 * how far (framebuffer pixels, RMS) the strongest horizontal edge of each column moves from
 * one frame to the next: with a static camera that is the cloud horizon wobbling.
 * `flickerPeak` is the worst single frame, which is where a discarded cloud history shows.
 * The readback stalls the GPU, so this runs after the frame-rate window.
 */
function imageStability(frames = 64, midway?: () => void) {
  return new Promise<{ flicker: number; flickerPeak: number; edgeJitter: number; edgeContrast: number; frames: number[] } | null>((resolve) => {
    const canvas = document.querySelector<HTMLCanvasElement>('.flight-canvas canvas')
    const gl = canvas?.getContext('webgl2')
    if (!canvas || !gl) return resolve(null)
    const width = 8
    const captureFrames = new URLSearchParams(location.search).has('frames')
    const shot = captureFrames ? document.createElement('canvas') : null
    if (shot) { shot.width = 960; shot.height = Math.round(960 * canvas.height / canvas.width) }
    const columns = [0.2, 0.4, 0.8]
    let previous: Float32Array[] | null = null
    let previousEdge: number[] | null = null
    let count = 0
    const series: number[] = []
    let flicker = 0
    let peak = 0
    let jitter = 0
    let contrast = 0
    const stop = addAfterEffect(() => {
      const h = gl.drawingBufferHeight
      const bound = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
      if (bound) gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      const pixels = new Uint8Array(width * h * 4)
      const rows = columns.map((fx) => {
        gl.readPixels(Math.round(gl.drawingBufferWidth * fx), 0, width, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
        const luma = new Float32Array(h)
        for (let y = 0; y < h; y++) {
          let sum = 0
          for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4
            sum += 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]
          }
          luma[y] = sum / width
        }
        return luma
      })
      if (bound) gl.bindFramebuffer(gl.FRAMEBUFFER, bound)
      // Optional motion review, after the FPS measurement window. Capture the
      // presented frame before WebKit discards the drawing buffer.
      if (shot && count % 4 === 0) {
        shot.getContext('2d')!.drawImage(canvas, 0, 0, shot.width, shot.height)
        post({ type: 'frame', name: `${name}-${String(count).padStart(3, '0')}`, data: shot.toDataURL().split(',')[1] })
      }
      // Strongest edge over a 6-row baseline, refined to a gradient-weighted centroid.
      const edges = rows.map((luma, c) => {
        let best = 0
        let at = 3
        // Follow the edge found in the first frame, so the measure cannot hop between edges.
        const from = previousEdge ? Math.max(3, Math.round(previousEdge[c]) - 40) : 3
        const to = previousEdge ? Math.min(h - 3, Math.round(previousEdge[c]) + 40) : h - 3
        for (let y = from; y < to; y++) {
          const g = Math.abs(luma[y + 3] - luma[y - 3])
          if (g > best) { best = g; at = y }
        }
        let weight = 0
        let centre = 0
        for (let y = Math.max(1, at - 8); y < Math.min(h - 1, at + 9); y++) {
          const g = Math.abs(luma[y + 1] - luma[y - 1])
          weight += g
          centre += g * y
        }
        contrast += best
        return weight > 0 ? centre / weight : at
      })
      if (previous && previousEdge) {
        let frameChange = 0
        for (let c = 0; c < rows.length; c++) {
          let sum = 0
          for (let y = 0; y < h; y++) sum += Math.abs(rows[c][y] - previous[c][y])
          flicker += sum / h
          frameChange += sum / h / rows.length
          jitter += (edges[c] - previousEdge[c]) ** 2
        }
        peak = Math.max(peak, frameChange)
        series.push(Math.round(frameChange * 100) / 100)
      }
      previous = rows
      previousEdge = edges
      if (count === frames >> 1) midway?.()
      if (++count > frames) {
        stop()
        const n = frames * columns.length
        resolve({ frames: series, flicker: flicker / n, flickerPeak: peak, edgeJitter: Math.sqrt(jitter / n), edgeContrast: contrast / ((frames + 1) * columns.length) })
      }
    })
  })
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
    // `&provider=google|cesium` uses the key configured for the build (VITE_GOOGLE_MAPS_API_KEY
    // / VITE_CESIUM_ION_TOKEN in .env.local); the bench never handles key values itself.
    provider: (params.get('provider') as Settings['provider'] | null) ?? 'open',
    openImagery: 'esri',
    quality: (params.get('quality') as Settings['quality']) ?? 'high',
    renderScale: 1,
    adaptiveResolution: params.get('adaptive') !== '0',
    clouds: true,
    cloudCoverage: scenario.coverage ?? 0.35,
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
  if (patch.provider !== 'open' && !providerReady({ ...useApp.getState().settings, ...patch })) {
    throw new Error(`No ${patch.provider} key in this build: add it to .env.local and rebuild`)
  }
  const app = useApp.getState()
  app.updateSettings(patch)
  app.setAircraft(scenario.aircraft ?? 'b737')
  if (scenario.runway) app.setSpawn({ kind: 'runway', airport: scenario.runway.airport, airportName: scenario.runway.name, runway: scenario.runway.runway, mode: 'takeoff' })
  else app.setSpawn({ kind: 'coords', label: name, lat: scenario.lat, lon: scenario.lon, mode: 'air', aglFt: scenario.aglFt, heading: scenario.heading, elevationFt: null })
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
  if (!scenario.runway) sim.command({ type: 'autopilot', engaged: true, heading_hold: true, altitude_hold: true, autothrottle: true, heading: scenario.heading, altitude_ft: Math.round(altitudeFt), speed_kt: scenario.speedKt ?? 250 })

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
  const stability = await imageStability(64, scenario.rebase ? () => {
    const ecef = frame.worldToEcef(new Vector3(1400, 0, 1400), new Vector3())
    frame.setOrigin(ecef.x, ecef.y, ecef.z)
  } : scenario.relevel !== undefined ? () => {
    const tuned = TUNING.find(([path]) => path[0] === 'level')
    if (!tuned) throw new Error('The relevel scenario needs --tune=level:N')
    tuned[1] = Number(params.get('relevel') ?? scenario.relevel)
    // The scene reads the tuned level when it renders: any settings change re-renders it.
    useApp.getState().updateSettings({ showFps: true })
  } : undefined)
  if (!snapshotTaken) post({ type: 'snapshot', name })
  hitches.sort((a, b) => b.ms - a.ms)
  const requestsAfter = requestCounts()
  const latest = perfMonitor.latest
  post({
    type: 'result',
    name,
    result: {
      scenario: name,
      settings: { provider: patch.provider, quality: patch.quality, adaptive: patch.adaptiveResolution, gpuSync: perfMonitor.gpuSync },
      settledIn,
      ...summary,
      stability,
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
