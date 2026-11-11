import { BINDINGS } from '../input/controls'

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
  return (
    <div className={`sheet glass ${full ? 'full' : ''}`}>
      <div className="sheet-header">
        <h2>Flight controls</h2>
        <span className="muted">Identical for every aircraft. Gamepads (standard layout) work too.</span>
        <div className="spacer" />
        <button className="btn primary" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="sheet-body">
        <ControlsTable />
        <div className="notice info" style={{ marginTop: 18 }}>
          <b>Your first takeoff:</b> press <span className="kbd">⇧R</span> for full throttle, keep straight with <span className="kbd">Q</span>/<span className="kbd">E</span>,
          and at the rotate speed shown on the aircraft card gently hold <span className="kbd">S</span> to lift the nose. Once climbing, raise the gear with{' '}
          <span className="kbd">G</span> and flaps with <span className="kbd">[</span>. Press <span className="kbd">Z</span> to let the autopilot hold your heading, altitude and speed.
          <br />
          <b>Landing:</b> start from “Final approach”, keep the runway centred, reduce power with <span className="kbd">F</span> just above the runway, flare gently with{' '}
          <span className="kbd">S</span> and hold <span className="kbd">Space</span> to brake.
        </div>
      </div>
    </div>
  )
}
