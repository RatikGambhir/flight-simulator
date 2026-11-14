import { useEffect, useRef, useState } from 'react'
import { MAX_SKIP_MILES, METERS_PER_MILE, MIN_SKIP_MILES, runSkipTransition, skipToPosition } from '../navigation/skipTo'
import { navigationTo } from '../navigation/route'
import { Flags, S } from '../sim/protocol'
import { sim } from '../sim/simClient'
import { useApp } from '../state/store'

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

/** Native modal traps focus and sits above every HUD/scene overlay. */
export function SkipTo() {
  const destination = useApp((s) => s.destination)
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const controller = useRef<AbortController | null>(null)
  const busy = useRef(false)
  const [miles, setMiles] = useState('100')
  const [error, setError] = useState('')
  const [stage, setStage] = useState<'edit' | 'out' | 'in'>('edit')
  const [position] = useState(() => ({ lat: sim.latest[S.LAT], lon: sim.latest[S.LON] }))
  const priorPaused = useRef(!!((sim.latest[S.FLAGS] | 0) & Flags.PAUSED))
  const close = () => { if (!busy.current) useApp.getState().setSkipToOpen(false) }

  useEffect(() => {
    const abort = new AbortController()
    controller.current = abort
    const previousFocus = document.activeElement as HTMLElement | null
    const element = dialog.current!
    element.showModal()
    sim.command({ type: 'set_paused', paused: true })
    input.current?.select()
    return () => {
      abort.abort()
      element.close()
      if (useApp.getState().phase === 'flying') sim.command({ type: 'set_paused', paused: priorPaused.current })
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])

  const confirm = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy.current || !destination) return
    const signal = controller.current!.signal
    const distance = Number(miles)
    try {
      if (!sim.snapshotsReceived) throw new Error('Your flight is still loading. Try again in a moment.')
      const target = skipToPosition(position, destination.airport, distance, sim.latest[S.HEADING])
      busy.current = true
      setError('')
      const generation = sim.latest[S.GENERATION]
      // Use the sim's normal trimmed air spawn, which resolves local terrain
      // before releasing the aircraft. Ground/takeoff speeds are never reused.
      const agl = Math.max(distance < 15 ? 1500 : 5000, Math.min(12000, sim.latest[S.AGL_FT]))
      await runSkipTransition({
        fade: setStage,
        wait: (ms) => delay(ms, signal),
        spawn: () => {
          useApp.getState().setCrashed(null)
          sim.command({ type: 'spawn', ...target, mode: 'air', agl_ft: agl, speed_kt: null, ground_elevation_ft: null, keep_autopilot: true })
        },
        ready: () => {
          const s = sim.latest
          return s[S.GENERATION] !== generation && sim.render.generation === s[S.GENERATION]
            && !(s[S.FLAGS] & (Flags.AWAITING_GROUND | Flags.ON_GROUND | Flags.CRASHED))
            && navigationTo({ lat: s[S.LAT], lon: s[S.LON] }, target).distanceNm < 0.05
        },
      })
      if (signal.aborted) return
      useApp.getState().setSkipToOpen(false)
      useApp.getState().toast(`${distance.toLocaleString()} miles from ${destination.airport.ident} — heading toward your destination`, 'good')
    } catch (err) {
      if (signal.aborted) return
      busy.current = false
      setStage('edit')
      setError(err instanceof Error ? err.message : 'Could not skip to that distance.')
      requestAnimationFrame(() => input.current?.focus())
    }
  }

  const remaining = destination ? navigationTo(position, destination.airport).distanceNm * 1852 / METERS_PER_MILE : 0
  return (
    <dialog ref={dialog} className={`skip-dialog ${stage === 'edit' ? 'editing' : 'transitioning'}`} aria-labelledby="skip-title"
      onCancel={(e) => { e.preventDefault(); close() }}>
      {stage === 'edit' ? <form className="modal glass skip-card" onSubmit={confirm} noValidate>
        <span className="skip-eyebrow">FAST FORWARD YOUR FLIGHT</span>
        <h2 id="skip-title">Skip to</h2>
        {destination ? <>
          <p className="muted">✈ {destination.airport.name} <b>({destination.airport.ident})</b></p>
          <label htmlFor="skip-miles">Miles from destination</label>
          <div className="skip-distance"><input ref={input} id="skip-miles" className="input" type="number" inputMode="decimal" min={MIN_SKIP_MILES} max={MAX_SKIP_MILES} step="any" autoFocus value={miles}
            aria-describedby="skip-hint skip-error" aria-invalid={!!error} onChange={(e) => { setMiles(e.target.value); setError('') }} /><span>mi</span></div>
          <p id="skip-hint" className="muted">Currently {remaining.toLocaleString(undefined, { maximumFractionDigits: 1 })} miles away. You’ll reappear airborne at the distance you choose, flying toward the airport.</p>
          <p className="faint">Uses ordinary miles (mi). The flight compass shows nautical miles (NM).</p>
        </> : <p className="muted">Choose a destination airport on the route map before skipping ahead.</p>}
        <p id="skip-error" role="alert" className="skip-error">{error}</p>
        <div className="row"><button className="btn ghost" type="button" onClick={close}>Cancel</button><div className="spacer" />
          {destination ? <button className="btn primary" type="submit">Okay</button> : <button className="btn primary" type="button" onClick={() => { close(); useApp.getState().setRouteOpen(true) }}>Choose destination</button>}
        </div>
      </form> : <span id="skip-title" className="sr-only">Skipping to {miles} miles from destination</span>}
      <div className={`skip-blackout ${stage === 'out' ? 'opaque' : ''}`} aria-hidden="true" />
    </dialog>
  )
}
