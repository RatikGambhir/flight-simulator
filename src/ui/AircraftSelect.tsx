import { useEffect, useState } from 'react'
import { applySelection } from '../flight'
import { useApp } from '../state/store'
import { aircraftThumbnail } from './thumbnails'
import { useAircraftList } from './useAircraftList'

function Thumb({ id }: { id: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    // Defer so the sheet paints first.
    const t = setTimeout(() => setSrc(aircraftThumbnail(id)), 30)
    return () => clearTimeout(t)
  }, [id])
  return <div className="preview">{src ? <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : null}</div>
}

export function AircraftSelect({ onClose }: { onClose: () => void }) {
  const list = useAircraftList()
  const aircraftId = useApp((s) => s.aircraftId)
  const setAircraft = useApp((s) => s.setAircraft)

  const choose = (id: string) => {
    setAircraft(id)
    applySelection({ paused: true })
  }

  return (
    <div className="sheet glass">
      <div className="sheet-header">
        <h2>Choose your aircraft</h2>
        <span className="muted">Same simple controls for every aircraft — heavier jets just respond more slowly.</span>
        <div className="spacer" />
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
      <div className="sheet-body">
        <div className="aircraft-grid">
          {list.map((a) => (
            <button key={a.id} className={`aircraft-card ${a.id === aircraftId ? 'on' : ''}`} onClick={() => choose(a.id)}>
              <Thumb id={a.id} />
              <div className="info">
                <h3>{a.name}</h3>
                <div className="muted" style={{ fontSize: 12 }}>
                  {a.manufacturer_style} · {a.category}
                </div>
                <p className="muted" style={{ fontSize: 12, lineHeight: 1.45, margin: '8px 0 0' }}>
                  {a.description}
                </p>
                <div className="stats">
                  <span>Cruise</span>
                  <span>{a.v_cruise_kt} kt</span>
                  <span>Ceiling</span>
                  <span>{a.service_ceiling_note}</span>
                  <span>Wingspan</span>
                  <span>{a.wingspan_m.toFixed(1)} m</span>
                  <span>Engines</span>
                  <span>
                    {a.engine_count} × {a.engine === 'jet' ? 'turbofan' : 'piston/prop'}
                  </span>
                  <span>Rotate / approach</span>
                  <span>
                    {a.v_rotate_kt} / {a.v_approach_kt} kt
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
