import { useEffect, useState } from 'react'
import { Flags, S } from '../sim/protocol'
import { phaseName } from '../sim/autopilotStatus'
import { sim } from '../sim/simClient'
import { SHUTTLE_SITES, shuttleSite, type ShuttleSite } from '../sim/shuttleSites'
import { useApp, type SpawnChoice } from '../state/store'

export function endeavourDeparture(orbit: boolean, site: ShuttleSite = 'houston'): SpawnChoice {
  const location = SHUTTLE_SITES.find((s) => s.id === site) ?? SHUTTLE_SITES[0]
  return { kind: 'shuttle', label: orbit ? 'Endeavour · ISS rendezvous' : location.name,
    lat: location.lat, lon: location.lon, heading: 45, elevationFt: null, orbit, site }
}

export function ShuttleDeparture({ onConfirm, onClose, confirmLabel }: {
  onConfirm: (spawn: SpawnChoice) => void; onClose: () => void; confirmLabel: string
}) {
  const spawn = useApp((s) => s.spawn)
  const [site, setSite] = useState<ShuttleSite>(spawn.kind === 'shuttle' ? spawn.site : 'houston')
  const [daylight, setDaylight] = useState(true)
  const confirm = (orbit: boolean) => {
    if (daylight) useApp.getState().updateSettings({ realTime: false, timeOfDay: 12, advanceSkyTime: false })
    onConfirm(endeavourDeparture(orbit, site))
  }
  return <div className="sheet glass">
    <div className="sheet-header"><h2>Endeavour flight path</h2><div className="spacer" /><button className="btn" onClick={onClose}>Close</button></div>
    <div className="sheet-body shuttle-departure">
      <span className="chip good">OV-105 · 25 missions</span>
      <h3>Launch → orbit → ISS → runway</h3>
      <label>Launch location <select aria-label="Launch location" value={site} onChange={(e) => setSite(e.target.value as ShuttleSite)}>
        {SHUTTLE_SITES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select></label>
      <p>{SHUTTLE_SITES.find((s) => s.id === site)?.detail}. Real terrain and imagery stream around the launch site using your scenery provider.</p>
      <label className="row"><input type="checkbox" checked={daylight} onChange={(e) => setDaylight(e.target.checked)} />Daylight launch · local noon</label>
      <p>Lift off with the orange external tank and two solid rocket boosters. The boosters separate at T+2:05. After orbital insertion, release the tank and take control of Endeavour.</p>
      <p>The guided ascent and transfer are condensed into 8½ simulated minutes. Choose 4× or 8× in flight to get there sooner.</p>
      <div className="row"><button className="btn primary" onClick={() => confirm(false)}>{confirmLabel} · Launch pad</button>
        <button className="btn" onClick={() => confirm(true)}>Start beside the ISS</button></div>
      <p className="muted">Houston is home to Mission Control. Its launch pad here is fictional; historical Shuttle launches took place at Kennedy. Japan and India are alternate simulated Shuttle departures.</p>
      <p>At roughly 420 km, gravity is still about 8.6 m/s². You feel weightless because Endeavour and the ISS are falling around Earth together. Thrust changes your orbit; releasing the controls preserves your velocity.</p>
      <p className="muted">The ISS follows a simulated 51.6° mission orbit, with a rendezvous opportunity after ascent. Use the assisted return to skip re-entry and let the autopilot land on wheels at a long paved runway. Docking is not included.</p>
      <p className="muted">Endeavour retired to the California Science Center in Los Angeles, California. This flight is a simulation of the orbiter in service.</p>
    </div>
  </div>
}

const PHASES = ['', 'Ready on launch pad', 'Liftoff · solid boosters + main engines', 'Boosters clear · main engines', 'Orbit reached · release external tank', 'Orbital free flight', 'Runway flight · landing assist']

export function ShuttleControls() {
  const destination = useApp((s) => s.destination)
  const covered = useApp((s) => s.pauseMenu || s.routeOpen || s.skipToOpen || s.helpOverlay || Boolean(s.crashed))
  const [state, setState] = useState({ phase: 0, time: 0, range: 0, gravity: 0, paused: true, rate: 1, apPhase: 0, ap: false, site: 0 })
  useEffect(() => {
    const sync = () => {
      const s = sim.latest
      // Round to what the panel shows, and keep the old state when nothing visible changed.
      const range = Math.hypot(s[S.ISS_X] - s[S.ECEF_X], s[S.ISS_Y] - s[S.ECEF_Y], s[S.ISS_Z] - s[S.ECEF_Z])
      const next = { phase: s[S.SHUTTLE_PHASE], time: Math.floor(s[S.MISSION_TIME]), gravity: Math.round(s[S.LOCAL_GRAVITY] * 100) / 100,
        range: range < 1000 ? Math.round(range) : Math.round(range / 100) * 100,
        paused: Boolean(s[S.FLAGS] & (Flags.PAUSED | Flags.CRASHED | Flags.AWAITING_GROUND)), rate: s[S.TIME_SCALE], apPhase: s[S.AP_PHASE], ap: Boolean(s[S.FLAGS] & Flags.AP_ENGAGED), site: s[S.SHUTTLE_SITE] }
      setState((prev) => (Object.keys(next) as (keyof typeof next)[]).every((k) => prev[k] === next[k]) ? prev : next)
    }
    sync()
    const timer = window.setInterval(sync, 200)
    return () => window.clearInterval(timer)
  }, [])
  if (covered) return null
  const runwayFlight = state.phase === 6
  const landingAirport = destination?.airport.ident ?? 'KTTS'
  return <div className="shuttle-controls" data-flight-targets aria-label="Endeavour mission controls">
    <div className="row"><b>ENDEAVOUR · OV-105</b><span className="spacer" /><span>{runwayFlight ? landingAirport : `T+${Math.floor(state.time / 60)}:${String(Math.floor(state.time % 60)).padStart(2, '0')}`}</span></div>
    <output aria-live="polite">{runwayFlight ? state.paused ? 'Loading runway scenery…' : state.ap ? `AUTOLAND · ${phaseName(state.apPhase)}` : 'Manual runway flight · Z to engage autopilot' : PHASES[state.phase] ?? 'Preparing mission…'}</output>
    {state.phase === 1 ? <div className="row hud-unit"><span>{shuttleSite(state.site).name}</span><button className="btn" onClick={() => useApp.getState().updateSettings({ realTime: false, timeOfDay: 12, advanceSkyTime: false })}>Daylight view</button></div> : null}
    <div className="row">
      {state.phase === 1 ? <button className="btn primary" disabled={state.paused} onClick={() => sim.command({ type: 'launch_shuttle' })}>Launch · L</button> : null}
      {state.phase > 1 && state.phase < 5 ? <button className="btn primary" disabled={state.phase !== 4 || state.paused} onClick={() => sim.command({ type: 'separate_shuttle' })}>Release tank · B</button> : null}
      <label className="hud-unit">Mission speed <select aria-label="Mission speed" value={state.rate} onChange={(e) => {
        const scale = Number(e.target.value)
        useApp.getState().updateSettings({ timeScale: scale })
        sim.command({ type: 'set_time_scale', scale })
      }}>{[0.25, 0.5, 1, 2, 4, 8].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}</select></label>
    </div>
    {!runwayFlight ? <div className="row">
      <button className="btn" onClick={() => useApp.getState().setRouteOpen(true)}>Landing airport · {landingAirport}</button>
      <button className="btn primary" disabled={state.phase !== 5 || state.paused} onClick={() => sim.command({ type: 'land_shuttle', airport: landingAirport })}>Skip re-entry & autoland</button>
    </div> : <div className="hud-unit">Landing gear and wheel brakes are automatic · Z to disengage / re-engage</div>}
    {!runwayFlight ? <div className="hud-unit">ISS {state.range < 1000 ? `${Math.round(state.range)} m` : `${(state.range / 1000).toFixed(1)} km`} · Gravity {state.gravity.toFixed(2)} m/s²</div> : null}
    <div className="hud-unit">{runwayFlight ? 'W/S pitch · A/D roll · J/E steer · G gear · Space brakes' : state.phase === 5 ? 'R/F thrust · ⇧F cut · W/S pitch · A/D roll · J/E yaw · X reverse · U/O lateral · I/K vertical' : 'Guided ascent · boosters separate automatically at 2:05 · insertion at 8:30'}</div>
    <div className="faint">{runwayFlight ? 'Forgiving landing assist supplies extra thrust for approach and go-arounds.' : 'ISS mission orbit · free fall creates weightlessness · Earth, Moon and Sun shown at physical scale'}</div>
  </div>
}
