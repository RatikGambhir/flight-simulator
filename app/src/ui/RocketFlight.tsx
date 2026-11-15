import { useEffect, useState, type FormEvent } from 'react'
import { X15_LAUNCH, X15_MAX_ALT_FT, X15_MAX_MACH } from '../flight'
import { Flags, S, type AircraftSpec, type RocketFlightState } from '../sim/protocol'
import { sim } from '../sim/simClient'
import { useApp } from '../state/store'

type Fields = Record<keyof RocketFlightState, string>

export function rocketFields(state: RocketFlightState): Fields {
  return { altitude_ft: String(state.altitude_ft), mach: state.mach.toFixed(2), heading: String(state.heading) }
}

export function readRocketFields(fields: Fields): RocketFlightState | null {
  const { altitude_ft, mach, heading } = fields
  const altitude = Number(altitude_ft)
  const speed = Number(mach)
  const bearing = Number(heading)
  if (altitude_ft === '' || mach === '' || heading === ''
    || !Number.isInteger(altitude) || altitude < 0 || altitude > X15_MAX_ALT_FT
    || !Number.isFinite(speed) || speed < 0.1 || speed > X15_MAX_MACH
    || !Number.isInteger(bearing) || bearing < 0 || bearing > 360) return null
  return { altitude_ft: altitude, mach: speed, heading: bearing }
}

export function RocketFlightFields({ fields, setFields, hud = false }: { fields: Fields; setFields: (fields: Fields) => void; hud?: boolean }) {
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
      <input className={inputClass} type="number" min={0} max={X15_MAX_ALT_FT} required value={fields.altitude_ft}
        onChange={(event) => edit('altitude_ft', event.target.value)} />
    </label>
    <label className={fieldClass}>
      <span className={labelClass}>Speed (Mach)</span>
      <input className={inputClass} type="number" min={0.1} max={X15_MAX_MACH} step="any" required value={fields.mach}
        onChange={(event) => edit('mach', event.target.value)} />
    </label>
  </>
}

export function RocketFlightPresets({ fields, setFields }: { fields: Fields; setFields: (fields: Fields) => void }) {
  return <div className="row rocket-presets">
    <button type="button" className="btn" onClick={() => setFields({ ...rocketFields(X15_LAUNCH), heading: fields.heading })}>
      Air launch · 45,000 ft
    </button>
    <button type="button" className="btn" onClick={() => setFields({ ...fields, altitude_ft: String(X15_MAX_ALT_FT) })}>
      Record altitude · 354,200 ft
    </button>
  </div>
}

export function RocketFlight({ spec }: { spec: AircraftSpec }) {
  const covered = useApp((s) => s.pauseMenu || s.routeOpen || s.skipToOpen || s.helpOverlay || Boolean(s.crashed))
  const [fields, setFields] = useState(() => rocketFields(X15_LAUNCH))
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let generation = -1
    const sync = () => {
      const s = sim.latest
      const current = sim.snapshotsReceived > 0 && s[S.AIRCRAFT_INDEX] === spec.index
      const available = current && (s[S.FLAGS] & (Flags.AWAITING_GROUND | Flags.CRASHED)) === 0
      setReady(available)
      if (!available || generation === s[S.GENERATION]) return
      generation = s[S.GENERATION]
      setFields(rocketFields({
        heading: Math.round(s[S.HEADING]) % 360,
        altitude_ft: Math.min(X15_MAX_ALT_FT, Math.max(0, Math.round(s[S.ALT_MSL_FT]))),
        mach: Math.min(X15_MAX_MACH, Math.max(0.1, s[S.MACH])),
      }))
    }
    sync()
    const timer = window.setInterval(sync, 100)
    return () => window.clearInterval(timer)
  }, [spec.index])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const state = readRocketFields(fields)
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
      <RocketFlightFields fields={fields} setFields={setFields} hud />
      <button className="btn primary" type="submit" disabled={!readRocketFields(fields)}>Set flight state</button>
      <RocketFlightPresets fields={fields} setFields={setFields} />
    </fieldset>
  </form>
}
