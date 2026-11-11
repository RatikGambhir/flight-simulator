import { useEffect, useRef, useState } from 'react'
import { relocate, restartFlight, returnToMenu } from '../flight'
import { Flags, S } from '../sim/protocol'
import { sim } from '../sim/simClient'
import { CAMERA_MODES, useApp } from '../state/store'
import { useWorldStatus } from '../scene/worldStatus'
import { ControlsHelp } from './ControlsHelp'
import { Hud } from './Hud'
import { LocationSelect } from './LocationSelect'
import { Settings } from './Settings'

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
  if (!awaiting && progress >= 0.999) return null
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
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let frames = 0
    let last = performance.now()
    let raf = 0
    const loop = () => {
      raf = requestAnimationFrame(loop)
      frames++
      const now = performance.now()
      if (now - last > 500) {
        if (ref.current) ref.current.textContent = `${Math.round((frames * 1000) / (now - last))} fps`
        frames = 0
        last = now
      }
    }
    loop()
    return () => cancelAnimationFrame(raf)
  }, [])
  return <div className="fps" ref={ref} />
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
      <LoadingIndicator />
      {showFps ? <Fps /> : null}
      {help ? <ControlsHelp full onClose={() => useApp.getState().setHelpOverlay(false)} /> : null}
      {crashed && !pauseMenu ? <CrashOverlay reason={crashed} /> : null}
      {pauseMenu ? <PauseMenu /> : null}
    </>
  )
}
