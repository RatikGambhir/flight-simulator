import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { sim } from '../sim/simClient'
import type { Airport, AirportDetail, RunwaySpawnKind, SearchResult, SpawnMode } from '../sim/protocol'
import type { SpawnChoice } from '../state/store'

const FEATURED: { label: string; query: string }[] = [
  { label: "Chicago O'Hare", query: 'KORD' },
  { label: 'New York JFK', query: 'KJFK' },
  { label: 'Tokyo Haneda', query: 'RJTT' },
  { label: 'Zurich', query: 'LSZH' },
  { label: 'San Francisco', query: 'KSFO' },
  { label: 'London Heathrow', query: 'EGLL' },
  { label: 'Dubai', query: 'OMDB' },
  { label: 'Sydney', query: 'YSSY' },
  { label: 'Matterhorn', query: 'Matterhorn' },
  { label: 'Grand Canyon', query: 'Grand Canyon' },
  { label: 'Manhattan', query: 'Lower Manhattan' },
  { label: 'Rio de Janeiro', query: 'Christ the Redeemer' },
]

const ICON: Record<string, string> = { airport: '✈︎', city: '◉', landmark: '★' }

interface MapAirport {
  ident: string
  name: string
  lat: number
  lon: number
}

let mapAirportsCache: MapAirport[] | null = null

function WorldMap({ selected, onPick }: { selected: { lat: number; lon: number } | null; onPick: (lat: number, lon: number) => void }) {
  const [land, setLand] = useState<string | null>(null)
  const [airports, setAirports] = useState<MapAirport[]>(mapAirportsCache ?? [])
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    let alive = true
    // The coastline path is ~0.5 MB; load it only when the map is shown.
    import('../assets/world-land.json').then((m) => alive && setLand((m.default as { path: string }).path))
    if (!mapAirportsCache) {
      sim.query<[string, string, number, number][]>({ type: 'map_airports', include_medium: false }).then((rows) => {
        mapAirportsCache = rows.map(([ident, name, lat, lon]) => ({ ident, name, lat, lon }))
        if (alive) setAirports(mapAirportsCache)
      })
    }
    return () => {
      alive = false
    }
  }, [])
  const dots = useMemo(
    () => airports.map((a) => `M${(a.lon + 180).toFixed(2)} ${(90 - a.lat).toFixed(2)}h0.01`).join(''),
    [airports],
  )
  const click = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = ref.current!.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * 360 - 180
    const y = 90 - ((e.clientY - r.top) / r.height) * 180
    onPick(y, x)
  }
  return (
    <div className="worldmap">
      <svg ref={ref} viewBox="0 0 360 180" preserveAspectRatio="none" onClick={click}>
        <defs>
          <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#0b2236" />
            <stop offset="1" stopColor="#081827" />
          </linearGradient>
        </defs>
        <rect width="360" height="180" fill="url(#sea)" />
        {[30, 60, 90, 120, 150].map((y) => (
          <line key={y} x1="0" x2="360" y1={y} y2={y} stroke="rgba(255,255,255,0.05)" strokeWidth="0.3" />
        ))}
        {[60, 120, 180, 240, 300].map((x) => (
          <line key={x} y1="0" y2="180" x1={x} x2={x} stroke="rgba(255,255,255,0.05)" strokeWidth="0.3" />
        ))}
        {land ? <path d={land} fill="#23384d" stroke="#3b5a78" strokeWidth="0.15" /> : null}
        <path d={dots} stroke="#7cf0c5" strokeOpacity="0.55" strokeWidth="0.9" strokeLinecap="round" />
        {selected ? (
          <g transform={`translate(${selected.lon + 180} ${90 - selected.lat})`}>
            <circle r="3.2" fill="none" stroke="#4da3ff" strokeWidth="0.6" />
            <circle r="0.9" fill="#4da3ff" />
          </g>
        ) : null}
      </svg>
    </div>
  )
}

function ResultIcon({ kind }: { kind: string }) {
  return <div className="icon">{ICON[kind] ?? '•'}</div>
}

export function LocationSelect({ initial, onConfirm, onClose, confirmLabel }: { initial: SpawnChoice; onConfirm: (s: SpawnChoice) => void; onClose: () => void; confirmLabel: string }) {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [results, setResults] = useState<SearchResult[]>([])
  const [nearby, setNearby] = useState<SearchResult[] | null>(null)
  const [selected, setSelected] = useState<SearchResult | null>(null)
  const [detail, setDetail] = useState<AirportDetail | null>(null)
  const [runway, setRunway] = useState<string | null>(initial.kind === 'runway' ? initial.runway : null)
  const [rwMode, setRwMode] = useState<RunwaySpawnKind>(initial.kind === 'runway' ? initial.mode : 'takeoff')
  const [placeMode, setPlaceMode] = useState<SpawnMode>('air')
  const [agl, setAgl] = useState(2500)
  const [heading, setHeading] = useState(0)
  const [lat, setLat] = useState(initial.kind === 'coords' ? initial.lat.toFixed(5) : '')
  const [lon, setLon] = useState(initial.kind === 'coords' ? initial.lon.toFixed(5) : '')
  const [online, setOnline] = useState<SearchResult[]>([])

  // Initial selection reflects the current spawn.
  useEffect(() => {
    if (initial.kind === 'runway') {
      sim.query<SearchResult[]>({ type: 'search', query: initial.airport, limit: 1 }).then((r) => r[0] && select(r[0], initial.runway))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const q = deferredQuery.trim()
    if (q.length < 2) {
      setResults([])
      setOnline([])
      return
    }
    let alive = true
    sim.query<SearchResult[]>({ type: 'search', query: q, limit: 40 }).then((r) => alive && setResults(r))
    return () => {
      alive = false
    }
  }, [deferredQuery])

  const select = (r: SearchResult, preferRunway: string | null = null) => {
    setSelected(r)
    setDetail(null)
    if (r.kind === 'airport' && r.code) {
      const ident = r.code.split(' / ')[0]
      sim.query<AirportDetail | null>({ type: 'airport', ident }).then((d) => {
        setDetail(d)
        if (d) {
          const all = d.runways.flatMap((rw) => rw.ends.map((e) => e.ident))
          setRunway(preferRunway && all.includes(preferRunway) ? preferRunway : null)
        }
      })
    } else {
      setAgl(r.suggested_agl_ft)
      setHeading(r.suggested_heading)
      setPlaceMode('air')
    }
    setLat(r.lat.toFixed(5))
    setLon(r.lon.toFixed(5))
  }

  // Online geocoding (OpenStreetMap Nominatim) for anything not in the bundled database.
  const searchOnline = async () => {
    const q = query.trim()
    if (!q) return
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&q=${encodeURIComponent(q)}`, {
        headers: { Accept: 'application/json' },
      })
      const rows = (await res.json()) as { display_name: string; lat: string; lon: string; type: string }[]
      setOnline(
        rows.map((x) => ({
          kind: 'city' as const,
          title: x.display_name.split(',')[0],
          subtitle: x.display_name.split(',').slice(1, 4).join(',').trim(),
          code: null,
          lat: Number(x.lat),
          lon: Number(x.lon),
          elevation_ft: null,
          suggested_agl_ft: 2500,
          suggested_heading: 0,
          score: 0,
        })),
      )
    } catch {
      setOnline([])
    }
  }

  const pickOnMap = (la: number, lo: number) => {
    setLat(la.toFixed(5))
    setLon(lo.toFixed(5))
    setSelected({ kind: 'city', title: 'Map location', subtitle: `${la.toFixed(3)}, ${lo.toFixed(3)}`, code: null, lat: la, lon: lo, elevation_ft: null, suggested_agl_ft: 3000, suggested_heading: 0, score: 0 })
    setDetail(null)
    sim.query<{ distance_km: number; airport: Airport }[]>({ type: 'nearest_airports', lat: la, lon: lo, radius_km: 150, limit: 12 }).then((rows) =>
      setNearby(
        rows.map(({ distance_km, airport: a }) => ({
          kind: 'airport' as const,
          title: a.name,
          subtitle: `${a.city ? a.city + ' · ' : ''}${distance_km.toFixed(0)} km away`,
          code: a.iata ? `${a.ident} / ${a.iata}` : a.ident,
          lat: a.lat,
          lon: a.lon,
          elevation_ft: a.elevation_ft,
          suggested_agl_ft: 1500,
          suggested_heading: 0,
          score: 0,
        })),
      ),
    )
  }

  const confirm = () => {
    if (selected?.kind === 'airport' && detail) {
      onConfirm({ kind: 'runway', airport: detail.airport.ident, airportName: detail.airport.name, runway, mode: rwMode })
      return
    }
    const la = Number(lat)
    const lo = Number(lon)
    if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return
    onConfirm({
      kind: 'coords',
      label: selected?.title ?? `${la.toFixed(3)}, ${lo.toFixed(3)}`,
      lat: la,
      lon: lo,
      mode: placeMode,
      aglFt: agl,
      heading,
      elevationFt: selected?.elevation_ft ?? null,
    })
  }

  const list = query.trim().length >= 2 ? [...results, ...online] : (nearby ?? [])
  const coordsValid = Number.isFinite(Number(lat)) && Number.isFinite(Number(lon)) && lat !== '' && lon !== ''
  const mapSel = coordsValid ? { lat: Number(lat), lon: Number(lon) } : null

  return (
    <div className="sheet glass">
      <div className="sheet-header">
        <h2>Where to?</h2>
        <span className="muted">Search 9,600+ airports, 7,300 cities and famous landmarks — or click anywhere on the map.</span>
        <div className="spacer" />
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={confirm} disabled={!selected && !coordsValid}>
          {confirmLabel}
        </button>
      </div>
      <div className="sheet-body" style={{ overflow: 'hidden' }}>
        <div className="loc-layout">
          <div className="loc-col">
            <input
              className="input"
              autoFocus
              placeholder="Airport code, city, landmark…  (e.g. KORD, Tokyo, Matterhorn)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && results.length === 0 && searchOnline()}
            />
            {query.trim().length < 2 && !nearby ? (
              <div className="featured">
                {FEATURED.map((f) => (
                  <button key={f.query} className="btn" style={{ padding: '6px 10px', fontSize: 12 }} onClick={() => setQuery(f.query)}>
                    {f.label}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="results">
              {list.map((r, i) => (
                <button key={`${r.kind}-${r.title}-${i}`} className={`result ${selected === r ? 'on' : ''}`} onClick={() => select(r)}>
                  <ResultIcon kind={r.kind} />
                  <div style={{ minWidth: 0 }}>
                    <div className="t">
                      {r.title} {r.code ? <span className="faint">· {r.code}</span> : null}
                    </div>
                    <div className="st">{r.subtitle}</div>
                  </div>
                </button>
              ))}
              {query.trim().length >= 2 ? (
                <button className="btn ghost" style={{ marginTop: 6 }} onClick={searchOnline}>
                  Search online (OpenStreetMap)…
                </button>
              ) : null}
            </div>
          </div>
          <div className="loc-col scroll">
            <WorldMap selected={mapSel} onPick={pickOnMap} />
            {selected?.kind === 'airport' && detail ? (
              <div className="detail glass">
                <div className="row">
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 16 }}>{detail.airport.name}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {detail.airport.ident}
                      {detail.airport.iata ? ` / ${detail.airport.iata}` : ''} · {detail.airport.city}, {detail.airport.country} · Elevation {Math.round(detail.airport.elevation_ft)} ft
                    </div>
                  </div>
                  <div className="spacer" />
                  <div className="segmented">
                    <button className={rwMode === 'takeoff' ? 'on' : ''} onClick={() => setRwMode('takeoff')}>
                      On runway
                    </button>
                    <button className={rwMode === 'approach' ? 'on' : ''} onClick={() => setRwMode('approach')}>
                      Final approach
                    </button>
                  </div>
                </div>
                <div className="label" style={{ marginTop: 12 }}>
                  Runway (true heading · length)
                </div>
                <div className="runways">
                  <button className={`btn ${runway === null ? 'selected' : ''}`} onClick={() => setRunway(null)}>
                    Auto (longest)
                  </button>
                  {detail.runways.flatMap((rw) =>
                    rw.ends.map((e) => (
                      <button key={e.ident + rw.length_ft} className={`btn ${runway === e.ident ? 'selected' : ''}`} onClick={() => setRunway(e.ident)}>
                        <b>{e.ident}</b>
                        <span className="faint">
                          {Math.round(e.heading_deg)}° · {Math.round(rw.length_ft).toLocaleString()} ft
                        </span>
                      </button>
                    )),
                  )}
                </div>
              </div>
            ) : (
              <div className="detail glass">
                <div className="row" style={{ marginBottom: 12 }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 16 }}>{selected?.title ?? 'Coordinates'}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {selected?.subtitle ?? 'Enter latitude and longitude in decimal degrees'}
                    </div>
                  </div>
                  <div className="spacer" />
                  <div className="segmented">
                    <button className={placeMode === 'air' ? 'on' : ''} onClick={() => setPlaceMode('air')}>
                      In flight
                    </button>
                    <button className={placeMode === 'ground' ? 'on' : ''} onClick={() => setPlaceMode('ground')}>
                      On ground
                    </button>
                  </div>
                </div>
                <div className="coords-grid">
                  <div className="field">
                    <label>Latitude</label>
                    <input className="input" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="41.8781" />
                  </div>
                  <div className="field">
                    <label>Longitude</label>
                    <input className="input" value={lon} onChange={(e) => setLon(e.target.value)} placeholder="-87.6298" />
                  </div>
                  <div className="field">
                    <label>Height above ground: {agl.toLocaleString()} ft</label>
                    <input type="range" min={500} max={20000} step={100} value={agl} disabled={placeMode === 'ground'} onChange={(e) => setAgl(Number(e.target.value))} />
                  </div>
                  <div className="field">
                    <label>Heading: {heading}°</label>
                    <input type="range" min={0} max={359} step={1} value={heading} onChange={(e) => setHeading(Number(e.target.value))} />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
