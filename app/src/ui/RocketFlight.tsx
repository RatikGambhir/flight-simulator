import { useEffect, useState, type FormEvent } from 'react'
import { X15_LAUNCH } from '../flight'
import { Flags, S, type AircraftSpec, type RocketFlightState } from '../sim/protocol'
import { sim } from '../sim/simClient'
import { useApp } from '../state/store'

type Fields = Record<keyof RocketFlightState, string>

export function rocketFields(state: RocketFlightState): Fields {
  return { altitude_ft: String(state.altitude_ft), mach: state.mach.toFixed(2), heading: String(state.heading) }
}

/** Placement limits come from the simulation's aircraft spec. */
export function rocketMaxMach(spec: AircraftSpec) {
  return spec.max_mach ?? 1
}

/** The altitude field as whole feet within the aircraft's range, or null. */
function readAltitude(fields: Fields, spec: AircraftSpec): number | null {
  const altitude = Number(fields.altitude_ft)
  return fields.altitude_ft !== '' && Number.isInteger(altitude) && altitude >= 0 && altitude <= spec.max_alt_ft ? altitude : null
}

export function readRocketFields(fields: Fields, spec: AircraftSpec): RocketFlightState | null {
  const altitude = readAltitude(fields, spec)
  const speed = Number(fields.mach)
  const bearing = Number(fields.heading)
  if (altitude === null || fields.mach === '' || fields.heading === ''
    || !Number.isFinite(speed) || speed < 0.1 || speed > rocketMaxMach(spec)
    || !Number.isInteger(bearing) || bearing < 0 || bearing > 360) return null
  return { altitude_ft: altitude, mach: speed, heading: bearing }
}

export function RocketFlightFields({ spec, fields, setFields, hud = false }: { spec: AircraftSpec; fields: Fields; setFields: (fields: Fields) => void; hud?: boolean }) {
  const edit = (key: keyof Fields, value: string) => setFields({ ...fields, [key]: value })
  const fieldClass = hud ? 'hud-target-field' : 'field'
  const inputClass = hud ? undefined : 'input'
  const labelClass = hud ? 'hud-unit' : undefined
  return <>
    <label className={fieldClass}>
      <span className={labelClass}>Heading ° true</span>
      <input className={inputClass} type="number" min={0} max={360} required value={fields.heading}
        onChange={(event) => edit('heading', event.target.value)} />
    </label>
    <label className={fieldClass}>
      <span className={labelClass}>Altitude ft MSL</span>
      <input className={inputClass} type="number" min={0} max={spec.max_alt_ft} required value={fields.altitude_ft}
        onChange={(event) => edit('altitude_ft', event.target.value)} />
    </label>
    <label className={fieldClass}>
      <span className={labelClass}>Speed (Mach)</span>
      <input className={inputClass} type="number" min={0.1} max={rocketMaxMach(spec)} step="any" required value={fields.mach}
        onChange={(event) => edit('mach', event.target.value)} />
    </label>
  </>
}

export function RocketFlightPresets({ spec, fields, setFields }: { spec: AircraftSpec; fields: Fields; setFields: (fields: Fields) => void }) {
  return <div className="row rocket-presets">
    <button type="button" className="btn" onClick={() => setFields({ ...rocketFields(X15_LAUNCH), heading: fields.heading })}>
      Air launch · 45,000 ft
    </button>
    <button type="button" className="btn" onClick={() => setFields({ ...fields, altitude_ft: String(spec.max_alt_ft) })}>
      Record altitude · {spec.max_alt_ft.toLocaleString('en-US')} ft
    </button>
  </div>
}

export function RocketFlight({ spec }: { spec: AircraftSpec }) {
  const covered = useApp((s) => s.pauseMenu || s.routeOpen || s.skipToOpen || s.helpOverlay || Boolean(s.crashed))
  const [fields, setFields] = useState(() => rocketFields(X15_LAUNCH))
  const [ready, setReady] = useState(false)
  const [guidance, setGuidance] = useState('')

  useEffect(() => {
    let generation = -1
    const sync = () => {
      const s = sim.latest
      const current = sim.snapshotsReceived > 0 && s[S.AIRCRAFT_INDEX] === spec.index
      const available = current && (s[S.FLAGS] & (Flags.AWAITING_GROUND | Flags.CRASHED)) === 0
      setReady(available)
      const guided = available && (s[S.FLAGS] & Flags.AP_ENGAGED) !== 0
      const phase = !(s[S.FLAGS] & Flags.ROCKET_CLIMB) ? 'Holding' : s[S.AP_ALT_FT] < s[S.ALT_MSL_FT] ? 'Descending to' : 'Climbing to'
      setGuidance(guided ? `${phase} ${Math.round(s[S.AP_ALT_FT]).toLocaleString('en-US')} ft` : '')
      if (!available || generation === s[S.GENERATION]) return
      generation = s[S.GENERATION]
      setFields(rocketFields({
        heading: Math.round(s[S.HEADING]) % 360,
        altitude_ft: Math.min(spec.max_alt_ft, Math.max(0, Math.round(s[S.ALT_MSL_FT]))),
        mach: Math.min(rocketMaxMach(spec), Math.max(0.1, s[S.MACH])),
      }))
    }
    sync()
    // Same cadence as the standard autopilot panel; the HUD's frame loop draws the gauges.
    const timer = window.setInterval(sync, 250)
    return () => window.clearInterval(timer)
  }, [spec])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const altitude = readAltitude(fields, spec)
    if (!ready || guidance || altitude === null) return
    sim.command({ type: 'climb_rocket', altitude_ft: altitude })
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }

  function place() {
    const state = readRocketFields(fields, spec)
    if (!ready || !state) return
    const s = sim.latest
    sim.command({ type: 'spawn_rocket', lat: s[S.LAT], lon: s[S.LON], ...state })
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }

  if (covered) return null
  return <form className="hud-targets rocket-flight" data-flight-targets aria-label="X-15 flight state" onSubmit={submit}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && event.target instanceof HTMLInputElement) {
        event.stopPropagation()
        event.target.blur()
      }
    }}>
    <fieldset disabled={!ready}>
      <RocketFlightFields spec={spec} fields={fields} setFields={setFields} hud />
      <div className="hud-target-actions">
        {guidance ? <button className="btn primary" type="button" onClick={() => sim.command({ type: 'cancel_rocket_climb' })}>Disengage AP</button>
          : <button className="btn primary" type="submit" formNoValidate title="Climb or descend to the selected altitude and hold it on your current heading">Fly climb</button>}
        <button className="btn" type="button" disabled={!readRocketFields(fields, spec)} onClick={place}
          title="Place the aircraft immediately at this altitude, speed and heading">Place now</button>
      </div>
      <RocketFlightPresets spec={spec} fields={fields} setFields={setFields} />
      {guidance && <output className="hud-unit rocket-status" aria-live="polite">{guidance}</output>}
    </fieldset>
  </form>
}
