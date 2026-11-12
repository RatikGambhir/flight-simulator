import { useEffect, useRef, useState } from 'react'
import { relocate, restartFlight, returnToMenu } from '../flight'
import { Flags, S } from '../sim/protocol'
import { sim } from '../sim/simClient'
import { CAMERA_MODES, useApp } from '../state/store'
import { useWorldStatus } from '../scene/worldStatus'
import { PERF_FORCED, perfMonitor, type PerfSnapshot } from '../scene/perfMonitor'
import { ControlsHelp } from './ControlsHelp'
import { Hud } from './Hud'
import { LocationSelect } from './LocationSelect'
import { Settings } from './Settings'
import { useAircraftList } from './useAircraftList'
import { RoutePlanner } from './RoutePlanner'
import { SkipTo } from './SkipTo'

type GuideStep = { key: string; text: string }

/**
 * Step-by-step takeoff coach shown after starting on the ground. It reads the
 * live state (4 Hz) and advances as each step is done, then gets out of the way.
 */
function TakeoffGuide() {
  const list = useAircraftList()
  const invert = useApp((s) => s.settings.invertPitch)
  const [step, setStep] = useState<GuideStep | null>(null)
  const done = useRef(false)
  const gen = useRef(-1)
  useEffect(() => {
    const id = setInterval(() => {
      const s = sim.latest
      const flags = s[S.FLAGS] | 0
      if (s[S.GENERATION] !== gen.current) {
        gen.current = s[S.GENERATION]
        // Coach every flight that starts on the ground.
        done.current = (flags & Flags.ON_GROUND) === 0
      }
      const spec = list[s[S.AIRCRAFT_INDEX] | 0]
      // The autopilot flies the takeoff itself; coaching would only get in the way.
      if (flags & Flags.AP_ENGAGED) done.current = true
      if (done.current || !spec || flags & (Flags.AWAITING_GROUND | Flags.CRASHED)) {
        setStep((p) => (p === null ? p : null))
        return
      }
      const onGround = (flags & Flags.ON_GROUND) !== 0
      const ias = s[S.IAS_KT]
      const vr = spec.v_rotate_kt
      const pull = invert ? '↑' : 'S / ↓'
      let next: GuideStep
      if (onGround && flags & Flags.PARKING_BRAKE) next = { key: 'N', text: 'Release the parking brake' }
      else if (onGround && s[S.THROTTLE] < 0.9) next = { key: '⇧R', text: 'Full throttle to start the takeoff roll' }
      else if (onGround && ias < vr - 8) next = { key: 'J / E', text: `Keep it straight. Rotate at ${Math.round(vr)} kt (now ${Math.round(ias)})` }
      else if (onGround) next = { key: pull, text: `Rotate: hold ${pull} to lift the nose about 10°, then release` }
      else if (s[S.AGL_FT] < 150 && s[S.VS_FPM] > 0) next = { key: '', text: 'Positive climb — let it climb away' }
      else if (spec.retractable_gear && s[S.GEAR] > 0.5) next = { key: 'G', text: 'Gear up' }
      else if ((s[S.FLAPS_INDEX] | 0) > 0 && s[S.AGL_FT] < 1000) next = { key: '', text: 'Climb to 1,000 ft, then raise the flaps' }
      else if ((s[S.FLAPS_INDEX] | 0) > 0) next = { key: '[', text: 'Flaps up, one notch at a time as speed builds' }
      else {
        done.current = true
        next = { key: 'Z', text: 'Airborne! Press Z and the autopilot flies you to your destination, or fly it yourself' }
        setTimeout(() => setStep(null), 6000)
      }
      setStep((p) => (p && p.key === next.key && p.text === next.text ? p : next))
    }, 250)
    return () => clearInterval(id)
  }, [list, invert])
  if (!step) return null
  return (
    <div className="takeoff-guide glass">
      <span className="hud-unit">TAKEOFF</span>
      {step.key ? <kbd>{step.key}</kbd> : null}
      <span>{step.text}</span>
    </div>
  )
}

function CameraBar() {
  const camera = useApp((s) => s.camera)
  const setCamera = useApp((s) => s.setCamera)
  return (
    <div className="camera-bar glass">
      {CAMERA_MODES.map((c) => (
        <button key={c.id} className={camera === c.id ? 'on' : ''} onClick={() => setCamera(c.id)} title={`Key ${c.key}`}>
          {c.label}
        </button>
      ))}
    </div>
  )
}

function Toasts() {
  const toasts = useApp((s) => s.toasts)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast glass ${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  )
}

/** Shows scenery streaming progress, and the "placing aircraft" wait after a spawn. */
function LoadingIndicator() {
  const progress = useWorldStatus((s) => s.progress)
  const error = useWorldStatus((s) => s.error)
  const [awaiting, setAwaiting] = useState(true)
  const behind = useRef(false)
  useEffect(() => {
    const id = setInterval(() => setAwaiting(((sim.latest[S.FLAGS] | 0) & Flags.AWAITING_GROUND) !== 0), 250)
    return () => clearInterval(id)
  }, [])
  if (error) {
    return (
      <div className="loading glass" style={{ color: 'var(--warn)' }}>
        Scenery error: {error}
      </div>
    )
  }
  // In flight there are always a few tiles in transit; only surface the banner
  // when streaming has really fallen behind, and keep it up until it recovers.
  if (progress < 0.5) behind.current = true
  else if (progress > 0.9) behind.current = false
  if (!awaiting && !behind.current) return null
  return (
    <div className="loading glass">
      <div className="spinner" />
      <span>{awaiting ? 'Loading scenery and placing your aircraft…' : 'Streaming scenery'}</span>
      <div className="progress">
        <i style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
    </div>
  )
}

export function Attribution() {
  const attributions = useWorldStatus((s) => s.attributions)
  const provider = useApp((s) => s.settings.provider)
  return (
    <div className="attribution">
      {provider === 'google' ? <b style={{ fontFamily: 'Arial, sans-serif', letterSpacing: '0.02em' }}>Google</b> : null}
      {attributions.map((a, i) => (a.image ? <img key={i} src={a.image} alt="" /> : <span key={i}>{a.text}</span>))}
    </div>
  )
}

function Fps() {
  const [stats, setStats] = useState<PerfSnapshot | null>(perfMonitor.latest)
  useEffect(() => perfMonitor.subscribe(setStats), [])
  if (!stats) return null
  return (
    <div className="fps">
      <div>{stats.fps.toFixed(0)} FPS · 1% low {stats.low1.toFixed(0)} · {stats.width} × {stats.height} @{stats.dpr.toFixed(2)}x</div>
      <div>frame p50 {stats.p50.toFixed(1)} · p95 {stats.p95.toFixed(1)} · p99 {stats.p99.toFixed(1)} ms · CPU {stats.cpuMean.toFixed(1)} ms</div>
      <div>{Math.round(stats.calls)} draws · {(stats.triangles / 1e6).toFixed(2)}M tris · {stats.textures} tex · {stats.geometries} geo · {stats.programs} programs{stats.heapMB !== null ? ` · ${stats.heapMB.toFixed(0)} MB heap` : ''}{perfMonitor.notes.cloudLevel !== undefined ? ` · clouds L${perfMonitor.notes.cloudLevel} (${perfMonitor.notes.cloudResolution})` : ''}</div>
    </div>
  )
}

function PauseMenu() {
  const [view, setView] = useState<'main' | 'location' | 'settings' | 'controls'>('main')
  const spawn = useApp((s) => s.spawn)
  const setPauseMenu = useApp((s) => s.setPauseMenu)
  const resume = () => {
    setPauseMenu(false)
    sim.command({ type: 'set_paused', paused: false })
  }
  if (view === 'location') {
    return <LocationSelect initial={spawn} confirmLabel="Fly there" onConfirm={(s) => relocate(s)} onClose={() => setView('main')} />
  }
  if (view === 'settings') return <Settings full onClose={() => setView('main')} />
  if (view === 'controls') return <ControlsHelp full onClose={() => setView('main')} />
  return (
    <div className="overlay">
      <div className="modal glass">
        <h2>Paused</h2>
        <button className="btn primary big" onClick={resume}>
          Resume flight
        </button>
        <button className="btn" onClick={() => setView('location')}>
          Change location…
        </button>
        <button className="btn" onClick={restartFlight}>
          Restart from departure
        </button>
        <button className="btn" onClick={() => setView('settings')}>
          Settings
        </button>
        <button className="btn" onClick={() => setView('controls')}>
          Controls
        </button>
        <button className="btn ghost" onClick={returnToMenu}>
          Main menu (change aircraft)
        </button>
      </div>
    </div>
  )
}

function CrashOverlay({ reason }: { reason: string }) {
  return (
    <div className="overlay">
      <div className="modal glass">
        <h2>Crashed</h2>
        <div className="muted">{reason}</div>
        <button className="btn primary big" onClick={restartFlight}>
          Try again
        </button>
        <button className="btn" onClick={() => useApp.getState().setPauseMenu(true)}>
          Choose another location
        </button>
        <button className="btn ghost" onClick={returnToMenu}>
          Main menu
        </button>
      </div>
    </div>
  )
}

export function FlightChrome() {
  const skipToOpen = useApp((s) => s.skipToOpen)
  const routeOpen = useApp((s) => s.routeOpen)
  const destination = useApp((s) => s.destination)
  const markerVisible = useApp((s) => s.destinationMarkerVisible)
  const hudVisible = useApp((s) => s.hudVisible)
  const pauseMenu = useApp((s) => s.pauseMenu)
  const crashed = useApp((s) => s.crashed)
  const help = useApp((s) => s.helpOverlay)
  const showFps = useApp((s) => s.settings.showFps)
  return (
    <>
      {hudVisible ? (
        <>
          <Hud />
          <CameraBar />
        </>
      ) : null}
      <Toasts />
      {!pauseMenu && !crashed ? <div className="navigation-actions glass">
        <button className="btn ghost" onClick={() => useApp.getState().setRouteOpen(!routeOpen)}>Route map <kbd>M</kbd></button>
        <button className="btn ghost" onClick={() => useApp.getState().setSkipToOpen(true)}>Skip to <kbd>Q</kbd></button>
        <button className="btn ghost" disabled={!destination} aria-pressed={markerVisible} onClick={() => useApp.getState().toggleDestinationMarker()}>Airport marker {markerVisible ? 'on' : 'off'} <kbd>⇧ ~</kbd></button>
      </div> : null}
      <LoadingIndicator />
      {hudVisible && !pauseMenu ? <TakeoffGuide /> : null}
      {showFps || PERF_FORCED ? <Fps /> : null}
      {help ? <ControlsHelp full onClose={() => useApp.getState().setHelpOverlay(false)} /> : null}
      {crashed && !pauseMenu ? <CrashOverlay reason={crashed} /> : null}
      {pauseMenu ? <PauseMenu /> : null}
      {routeOpen && !pauseMenu ? <RoutePlanner full onClose={() => useApp.getState().setRouteOpen(false)} /> : null}
      {skipToOpen ? <SkipTo /> : null}
    </>
  )
}
