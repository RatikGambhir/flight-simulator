import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ApModes, Flags, KT_TO_MPH, S, type AircraftSpec, type FlightTargets } from '../sim/protocol'
import { sim } from '../sim/simClient'
import { useApp } from '../state/store'

type Fields = { heading: string; altitude: string; speed: string; unit: FlightTargets['speed']['unit'] }

function readTargets(spec: AircraftSpec) {
  const s = sim.latest
  const flags = s[S.FLAGS] | 0
  const engaged = (flags & Flags.AP_ENGAGED) !== 0
  const selected = engaged && (s[S.AP_MODES] & ApModes.SELECTED) !== 0
  const onGround = (flags & Flags.ON_GROUND) !== 0
  const modes = s[S.AP_MODES] | 0
  const mph = selected && (modes & ApModes.MPH) !== 0
  const mach = spec.id === 'sr71' && (selected ? (modes & ApModes.MACH) !== 0 : s[S.MACH] >= 1.2)
  const heading = selected ? s[S.AP_SELECTED_HEADING] : s[S.HEADING]
  const altitude = selected ? s[S.AP_SELECTED_ALT_FT] : s[S.ALT_MSL_FT] + (onGround ? 5000 : 0)
  const speed = selected ? s[S.AP_SELECTED_SPEED] : mach ? s[S.MACH] : onGround ? spec.v_cruise_kt : s[S.IAS_KT]
  const fields: Fields = {
    heading: String(Math.round(heading) % 360 || 360).padStart(3, '0'),
    altitude: String(Math.round(Math.min(spec.max_alt_ft, Math.max(0, altitude)))),
    speed: mach ? Math.min(3.2, speed).toFixed(2) : String(Math.round(mph ? speed : Math.min(spec.v_max_kt - 10, speed))),
    unit: mph ? 'ground_mph' : mach ? 'mach' : 'knots',
  }
  return {
    fields, selected,
    ready: sim.snapshotsReceived > 0 && (flags & (Flags.AWAITING_GROUND | Flags.CRASHED)) === 0,
    generation: s[S.GENERATION],
  }
}

export function AutopilotTargets({ spec }: { spec: AircraftSpec }) {
  const [live, setLive] = useState(() => readTargets(spec))
  const [draft, setDraft] = useState<Partial<Fields>>({})
  const pending = useRef<FlightTargets | null>(null)
  const covered = useApp((s) => s.pauseMenu || s.routeOpen || s.skipToOpen || s.helpOverlay || Boolean(s.crashed))
  const fields = { ...live.fields, ...draft }
  const blackbird = spec.id === 'sr71'

  useEffect(() => {
    let generation = sim.latest[S.GENERATION]
    const sync = () => {
      const next = readTargets(spec)
      const sent = pending.current
      const altitude = Number(next.fields.altitude)
      const acceptedAltitude = sent && (Math.abs(altitude - sent.altitude_ft) < 0.51
        || (blackbird && sent.altitude_ft > spec.cruise_alt_ft && altitude >= spec.cruise_alt_ft && altitude < sent.altitude_ft))
      const accepted = sent && next.selected && sent.speed.unit === next.fields.unit
        && acceptedAltitude
        && Math.abs(Number(next.fields.speed) - sent.speed.value) < (sent.speed.unit === 'mach' ? 0.006 : 0.51)
        && (Number(next.fields.heading) % 360) === (Math.round(sent.heading) % 360)
      if (accepted || next.generation !== generation) {
        pending.current = null
        generation = next.generation
        setDraft({})
      }
      setLive((prev) => prev.ready === next.ready && prev.selected === next.selected
        && prev.generation === next.generation && prev.fields.heading === next.fields.heading
        && prev.fields.altitude === next.fields.altitude && prev.fields.speed === next.fields.speed
        && prev.fields.unit === next.fields.unit ? prev : next)
    }
    sync()
    const timer = window.setInterval(sync, 250)
    return () => window.clearInterval(timer)
  }, [spec, blackbird])

  function edit(patch: Partial<Fields>) {
    pending.current = null
    setDraft((prev) => ({ ...prev, ...patch }))
  }

  function fly(targets: FlightTargets) {
    pending.current = targets
    sim.command({ type: 'fly_targets', ...targets })
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    fly({ heading: Number(fields.heading), altitude_ft: Number(fields.altitude), speed: { unit: fields.unit, value: Number(fields.speed) } })
  }

  if (covered) return null
  return (
    <form className="hud-targets" data-flight-targets aria-label="Autopilot flight targets" onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && event.target instanceof HTMLElement && event.target.matches('input, select')) {
          event.stopPropagation()
          event.target.blur()
        }
      }}>
      <fieldset disabled={!live.ready}>
        <label className="hud-target-field">
          <span className="hud-unit">Heading °</span>
          <input type="number" min={0} max={360} step={1} required value={fields.heading}
            onChange={(event) => edit({ heading: event.target.value })} />
        </label>
        <label className="hud-target-field">
          <span className="hud-unit">Altitude ft</span>
          <input type="number" min={0} max={spec.max_alt_ft} step={1} required value={fields.altitude}
            onChange={(event) => edit({ altitude: event.target.value })} />
        </label>
        <div className="hud-target-field">
          <label className="hud-unit" htmlFor="hud-selected-speed">Speed</label>
          <div className="hud-target-speed">
            <input id="hud-selected-speed" type="number" min={fields.unit === 'mach' ? 0.1 : 1}
              max={fields.unit === 'mach' ? 3.2 : fields.unit === 'knots' ? spec.v_max_kt - 10 : undefined}
              step={fields.unit === 'mach' ? 0.01 : 1} required value={fields.speed}
              onChange={(event) => edit({ speed: event.target.value })} />
            <select aria-label="Speed unit" value={fields.unit} onChange={(event) => {
              const unit = event.target.value as Fields['unit']
              const s = sim.latest
              const groundKt = (s[S.FLAGS] & Flags.ON_GROUND) ? spec.v_cruise_kt : s[S.GS_KT]
              const speed = unit === 'mach' ? '3.20' : unit === 'ground_mph' ? String(Math.max(1, Math.round(groundKt * KT_TO_MPH))) : String(spec.v_cruise_kt)
              edit({ unit, speed })
            }}>
              <option value="knots" title="Equivalent airspeed in knots">KEAS</option>
              <option value="ground_mph" title="Ground speed in miles per hour">MPH GS</option>
              {blackbird && <option value="mach">Mach</option>}
            </select>
          </div>
        </div>
        <div className="hud-target-actions">
          <button className="btn primary" type="submit">{live.selected ? 'Update' : 'Engage'}</button>
          {live.selected && <button className="btn" type="button" onClick={(event) => {
            sim.command({ type: 'autopilot', engaged: false })
            event.currentTarget.blur()
          }}>Disconnect</button>}
        </div>
        {blackbird && <button type="button" className="btn hud-cruise-preset"
          onClick={() => {
            // A preset stays usable when the pilot was midway through editing the heading.
            const heading = fields.heading !== '' && Number(fields.heading) >= 0 && Number(fields.heading) <= 360
              ? Number(fields.heading) : Number(live.fields.heading)
            fly({ heading, altitude_ft: spec.cruise_alt_ft, speed: { unit: 'mach', value: 3.2 } })
          }}>
          Fly Mach 3.2 at 85,000 ft
        </button>}
      </fieldset>
    </form>
  )
}
