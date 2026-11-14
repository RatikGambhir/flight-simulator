import { useDeferredValue, useEffect, useState } from 'react'
import { navigationTo, type GeoPoint } from '../navigation/route'
import { S, type AirportDetail, type SearchResult } from '../sim/protocol'
import { sim } from '../sim/simClient'
import { useApp } from '../state/store'
import { RouteMap } from './RouteMap'

export function RoutePlanner({ onClose, full = false }: { onClose: () => void; full?: boolean }) {
  const spawn = useApp((s) => s.spawn)
  const destination = useApp((s) => s.destination)
  const flying = useApp((s) => s.phase === 'flying')
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query.trim())
  const [results, setResults] = useState<SearchResult[]>([])
  const [ident, setIdent] = useState(destination?.airport.ident ?? '')
  const [selected, setSelected] = useState(destination)
  const [departure, setDeparture] = useState<GeoPoint | null>(null)
  const [aircraft, setAircraft] = useState<(GeoPoint & { heading: number }) | undefined>()
  const [error, setError] = useState('')
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    let alive = true
    setDeparture(null)
    if (spawn.kind === 'coords') setDeparture(spawn)
    else sim.query<AirportDetail | null>({ type: 'airport', ident: spawn.airport }).then((d) => {
      if (alive) {
        setDeparture(d?.airport ?? null)
        if (!d) setError('Departure airport could not be loaded.')
      }
    }).catch(() => { if (alive) setError('Could not load the departure map.') })
    return () => { alive = false }
  }, [spawn])

  useEffect(() => {
    if (!flying) return
    const update = () => {
      if (sim.snapshotsReceived) setAircraft({ lat: sim.latest[S.LAT], lon: sim.latest[S.LON], heading: sim.latest[S.HEADING] })
    }
    update()
    const timer = setInterval(update, 250)
    return () => clearInterval(timer)
  }, [flying])

  useEffect(() => {
    let alive = true
    setResults([])
    setSearching(deferred.length >= 2)
    if (deferred.length < 2) return
    setError('')
    sim.query<SearchResult[]>({ type: 'search', query: deferred, limit: 100 }).then((rows) => {
      if (alive) { setResults(rows.filter((r) => r.kind === 'airport')); setSearching(false) }
    }).catch(() => { if (alive) { setError('Airport search failed. Try again.'); setSearching(false) } })
    return () => { alive = false }
  }, [deferred])

  useEffect(() => {
    let alive = true
    setSelected(null)
    if (!ident) return
    setError('')
    sim.query<AirportDetail | null>({ type: 'airport', ident }).then((d) => {
      if (alive) { setSelected(d); if (!d) setError('Airport details are unavailable. Choose another airport.') }
    }).catch(() => { if (alive) setError('Could not load this airport. Try another selection.') })
    return () => { alive = false }
  }, [ident])

  const target = selected?.airport
  const origin = aircraft ?? departure
  const nav = origin && target ? navigationTo(origin, target) : null
  return (
    <section className={`sheet glass route-planner ${full ? 'full' : ''}`} aria-label="Destination and route">
      <div className="sheet-header"><h2>Destination & route</h2><div className="spacer" /><button className="btn ghost" onClick={onClose}>Close</button></div>
      <div className="sheet-body">
        <label className="route-search-label" htmlFor="destination-search">Find an airport</label>
        <input id="destination-search" className="input" autoFocus placeholder="Airport name, city or code…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {query.length < 2 ? <div className="featured">{['KJFK', 'KLAX', 'EGLL', 'RJTT', 'KMDW', 'OMDB'].map((code) => <button key={code} className="btn" onClick={() => setQuery(code)}>{code}</button>)}</div> : null}
        {searching ? <p className="muted">Searching airports…</p> : null}
        {deferred.length >= 2 && !searching && !results.length && !error ? <p className="muted">No airports found. Try an airport code or a different city.</p> : null}
        {error ? <p role="alert" className="notice">{error}</p> : null}
        <div className="route-results">{results.map((r) => {
          const code = r.code?.split(' / ')[0]
          return code ? <button key={code} className={`result ${ident === code ? 'on' : ''}`} onClick={() => setIdent(code)}><div className="icon">✈</div><div><div className="t">{r.title}</div><div className="st">{r.code} · {r.subtitle}</div></div></button> : null
        })}</div>
        {ident && !selected && !error ? <p className="muted">Loading airport…</p> : null}
        {target ? <>
          <h3>✈ {target.name}</h3>
          <p>{spawn.kind === 'runway' ? spawn.airport : spawn.label} → {target.ident}</p>
          <p className="muted">{target.ident} · {target.lat.toFixed(4)}°, {target.lon.toFixed(4)}° · Elevation {Math.round(target.elevation_ft).toLocaleString()} ft</p>
          {departure ? <RouteMap from={departure} to={target} aircraft={aircraft} /> : null}
          {nav ? <div className="route-stats"><b>{nav.distanceNm.toFixed(1)} NM {flying ? 'remaining' : 'direct'}</b><span>{String(Math.round(nav.bearing) % 360).padStart(3, '0')}° true {flying ? 'bearing' : 'initial course'}</span></div> : null}
          <p className="muted">Direct great-circle route. In flight, press M for this map and Shift + ~ for the airport marker.</p>
          <button className="btn primary" onClick={() => { useApp.getState().setDestination(selected); onClose() }}>Set destination</button>
        </> : <p className="muted">Choose an arrival airport to preview your route. You can also fly freely without a destination.</p>}
        {destination ? <button className="btn ghost" onClick={() => { useApp.getState().setDestination(null); onClose() }}>Clear destination</button> : null}
      </div>
    </section>
  )
}
