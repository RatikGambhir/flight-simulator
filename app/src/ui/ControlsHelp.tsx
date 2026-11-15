import { BINDINGS } from '../input/controls'
import { useApp } from '../state/store'

export function ControlsTable() {
  return (
    <div className="help-table">
      {BINDINGS.map((g) => (
        <div key={g.group}>
          <h3>{g.group}</h3>
          {g.items.map((b) => (
            <div className="help-row" key={b.keys}>
              <span>{b.action}</span>
              <span className="kbd">{b.keys}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

export function ControlsHelp({ onClose, full }: { onClose: () => void; full?: boolean }) {
  const rocket = useApp((s) => s.aircraftId === 'x15')
  return (
    <div className={`sheet glass ${full ? 'full' : ''}`}>
      <div className="sheet-header">
        <h2>Flight controls</h2>
        <span className="muted">Standard gamepads work too.</span>
        <div className="spacer" />
        <button className="btn primary" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="sheet-body">
        <ControlsTable />
        <div className="notice info" style={{ marginTop: 18 }}>
          {rocket ? <>
            <b>X-15 air launch.</b> Start at 45,000 ft, then press <span className="kbd">⇧R</span> to power up the XLR99.
            The XLR99 has unlimited fuel. Use <span className="kbd">⇧F</span> to cut power and coast, and <span className="kbd">G</span> to lower the gear for a glide landing.
            <br />
            <b>Runway start.</b> In Departure, select an airport and choose On runway. For a manual takeoff, use full power and rotate at 250 kt. Raise the gear after liftoff.
            <br />
            <b>Fly climb.</b> Enter an altitude and use Fly climb to guide the rocket ascent on your current heading. Place now sets your altitude, Mach and true heading instantly.
          </> : <>
          <b>Your first takeoff:</b> press <span className="kbd">⇧R</span> for full throttle, keep straight with <span className="kbd">Q</span>/<span className="kbd">E</span>,
          and at the rotate speed shown on the aircraft card gently hold <span className="kbd">S</span> to lift the nose. Once climbing, raise the gear with{' '}
          <span className="kbd">G</span> and flaps with <span className="kbd">[</span>.
          <br />
          <b>Autopilot:</b> press <span className="kbd">Z</span> at any moment, on the ground or in the air. With a destination chosen (<span className="kbd">M</span>) it
          takes off, flies the route, lands on a runway suited to the wind and brings the aircraft to a stop; without one it holds your heading, altitude and
          speed. Press <span className="kbd">Z</span> again, or move the controls firmly, to take over.
          <br />
          <b>Landing:</b> start from “Final approach”, keep the runway centred, reduce power with <span className="kbd">F</span> just above the runway, flare gently with{' '}
          <span className="kbd">S</span> and hold <span className="kbd">Space</span> to brake.
          </>}
        </div>
      </div>
    </div>
  )
}
