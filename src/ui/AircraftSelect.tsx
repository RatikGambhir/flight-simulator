import { useEffect, useState } from 'react'
import { applySelection } from '../flight'
import { useApp } from '../state/store'
import { useAircraftList } from './useAircraftList'

export function AircraftSelect({ onClose }: { onClose: () => void }) {
  const list = useAircraftList()
  const aircraftId = useApp((s) => s.aircraftId)
  const setAircraft = useApp((s) => s.setAircraft)
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!list.length) return
    let active = true
    let stop: (() => void) | undefined
    void import('./thumbnails').then(({ loadAircraftThumbnails }) => {
      if (active) {
        stop = loadAircraftThumbnails(list.map((aircraft) => aircraft.id), (id, src) => {
          setThumbnails((current) => ({ ...current, [id]: src }))
        })
      }
    }).catch((error) => console.warn('Aircraft previews unavailable', error))
    return () => {
      active = false
      stop?.()
    }
  }, [list])

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
              <div className="preview">
                {thumbnails[a.id] ? <img src={thumbnails[a.id]} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
              </div>
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
                    {a.engine_count} × {a.engine === 'propeller' ? 'piston/prop' : a.afterburner_thrust_n > 0 ? 'afterburning turbofan' : 'turbofan'}
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
