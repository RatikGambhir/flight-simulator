import { useEffect, useState } from 'react'
import { liveryOptions, type LiveryId } from '../aircraft/liveries'
import { applySelection } from '../flight'
import { useApp } from '../state/store'
import { useAircraftList } from './useAircraftList'

const thumbnailKey = (id: string, livery: LiveryId) => `${id}/${livery}`

export function AircraftSelect({ onClose }: { onClose: () => void }) {
  const list = useAircraftList()
  const aircraftId = useApp((s) => s.aircraftId)
  const liveries = useApp((s) => s.liveries)
  const setLivery = useApp((s) => s.setLivery)
  const setAircraft = useApp((s) => s.setAircraft)
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!list.length) return
    let active = true
    let stop: (() => void) | undefined
    void import('./thumbnails').then(({ loadAircraftThumbnails }) => {
      if (active) {
        const previews = list.map(({ id }) => {
          const livery = liveries[id] ?? 'default'
          return { id, livery, key: thumbnailKey(id, livery) }
        })
        stop = loadAircraftThumbnails(previews, (key, src) => {
          setThumbnails((current) => current[key] === src ? current : { ...current, [key]: src })
        })
      }
    }).catch((error) => console.warn('Aircraft previews unavailable', error))
    return () => {
      active = false
      stop?.()
    }
  }, [list, liveries])

  const choose = (id: string) => {
    const { spawn, setSpawn } = useApp.getState()
    if (id !== 'sr71' && spawn.kind === 'coords' && spawn.cruise) setSpawn({ ...spawn, cruise: false })
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
          {list.map((a) => {
            const blackbird = a.id === 'sr71'
            const selected = a.id === aircraftId
            const livery = liveries[a.id] ?? 'default'
            const preview = thumbnails[thumbnailKey(a.id, livery)]
            return (
              <div key={a.id} className={`aircraft-card ${selected ? 'on' : ''}`}>
                <button type="button" className="aircraft-choice" aria-pressed={selected} onClick={() => choose(a.id)}>
                  <div className="preview">
                    {preview ? <img src={preview} alt="" /> : null}
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
                      <span>{blackbird ? 'Mach 3.2' : `${a.v_cruise_kt} kt`}</span>
                      <span>Ceiling</span>
                      <span>{a.service_ceiling_note}</span>
                      <span>Length / span</span>
                      <span>{a.length_m.toFixed(1)} / {a.wingspan_m.toFixed(1)} m</span>
                      <span>Engines</span>
                      <span>
                        {a.engine_count} × {blackbird ? 'J58 turbojet' : a.engine === 'propeller' ? 'piston/prop' : a.afterburner_thrust_n > 0 ? 'afterburning turbofan' : 'turbofan'}
                      </span>
                      <span>Rotate / approach</span>
                      <span>{a.v_rotate_kt} / {a.v_approach_kt} kt</span>
                    </div>
                  </div>
                </button>
                <label className="aircraft-livery">
                  <span>Livery</span>
                  <select aria-label={`Livery for ${a.name}`} value={livery}
                    onChange={(event) => setLivery(a.id, event.target.value as LiveryId)}>
                    {liveryOptions(a.id).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                  </select>
                </label>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
