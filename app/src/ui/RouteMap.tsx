import { useEffect, useMemo, useState } from 'react'
import { angleDelta, routePoints, type GeoPoint } from '../navigation/route'

type LabelKind = 'ocean' | 'sea' | 'country' | 'state' | 'lake'

interface WorldMap {
  /** Relative integer paths on a 0.1 degree grid (lakes 0.05), x = lon + 180, y = 90 - lat. */
  countries: string
  states: string
  lakes: string
  /** [name, x, y, kind, zoom at which the name appears]. */
  labels: [string, number, number, LabelKind, number][]
}

/** Nominal map width in pixels; text and markers are sized against it. */
const MAP_PX = 800
const WATER = '#0b2233'

/** Label styling and placement priority (lower wins a collision). */
const STYLE: Record<LabelKind, { size: number; fill: string; italic?: boolean; caps?: boolean; spacing: number; order: number }> = {
  ocean: { size: 13, fill: '#5f8fae', italic: true, spacing: 0.18, order: 0 },
  country: { size: 11, fill: '#e3edf2', caps: true, spacing: 0.08, order: 1 },
  sea: { size: 10, fill: '#5f8fae', italic: true, spacing: 0.08, order: 2 },
  state: { size: 8.5, fill: '#9db3bf', spacing: 0.02, order: 3 },
  lake: { size: 8, fill: '#6f9fbd', italic: true, spacing: 0.02, order: 4 },
}

interface PlacedLabel {
  key: string
  text: string
  x: number
  y: number
  kind: LabelKind
}

/** Names that fit at this zoom, highest priority first, skipping any that would overlap. */
function placeLabels(labels: WorldMap['labels'], view: { x: number; y: number; w: number; h: number }, scale: number, zoom: number): PlacedLabel[] {
  const candidates = labels
    .filter(([, , , kind, min]) => min <= zoom + (kind === 'state' ? 0.2 : 0.6))
    .sort((a, b) => STYLE[a[3]].order - STYLE[b[3]].order || a[4] - b[4])
  const boxes: [number, number, number, number][] = []
  const placed: PlacedLabel[] = []
  for (const [name, lx, ly, kind] of candidates) {
    // The map repeats east and west; use the copy nearest the middle of the view.
    const x = lx + Math.round((view.x + view.w / 2 - lx) / 360) * 360
    const style = STYLE[kind]
    const text = style.caps ? name.toUpperCase() : name
    const halfW = (text.length * style.size * (0.56 + style.spacing) * scale) / 2 + 3 * scale
    const halfH = (style.size * scale) / 2 + 2 * scale
    if (x - halfW < view.x || x + halfW > view.x + view.w || ly - halfH < view.y || ly + halfH > view.y + view.h) continue
    if (boxes.some(([x0, y0, x1, y1]) => x - halfW < x1 && x + halfW > x0 && ly - halfH < y1 && ly + halfH > y0)) continue
    // Large countries and oceans carry several anchors; name each once per stretch of map.
    if (placed.some((p) => p.text === text && Math.hypot(p.x - x, p.y - ly) < view.w * 0.35)) continue
    boxes.push([x - halfW, ly - halfH, x + halfW, ly + halfH])
    placed.push({ key: `${kind}:${name}:${lx}:${ly}`, text, x, y: ly, kind })
  }
  return placed
}

export function RouteMap({ from, to, aircraft }: { from: GeoPoint; to: GeoPoint; aircraft?: GeoPoint & { heading: number } }) {
  const [world, setWorld] = useState<WorldMap | null>(null)
  useEffect(() => {
    let alive = true
    import('../assets/world-map.json').then((m) => { if (alive) setWorld(m.default as unknown as WorldMap) })
    return () => { alive = false }
  }, [])
  const map = useMemo(() => {
    const points = routePoints(from, to)
    const xs = points.map((p) => p.lon + 180), ys = points.map((p) => 90 - p.lat)
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2
    const width = Math.max(0.6, (Math.max(...xs) - Math.min(...xs)) * 1.3, (Math.max(...ys) - Math.min(...ys)) * 2.6)
    const view = { x: cx - width / 2, y: cy - width / 4, w: width, h: width / 2 }
    return { points, cx, width, view, path: points.map((p, i) => `${i ? 'L' : 'M'}${p.lon + 180},${90 - p.lat}`).join(' ') }
  }, [from, to])
  const scale = map.width / MAP_PX
  const view = map.view
  // The web-map zoom level that shows this many degrees across the map (256 px tiles).
  const zoom = Math.log2((360 / map.width) * (MAP_PX / 256))
  const labels = useMemo(() => (world ? placeLabels(world.labels, map.view, map.width / MAP_PX, zoom) : []), [world, map, zoom])
  const end = map.points[map.points.length - 1]
  const liveLon = aircraft ? map.cx - 180 + angleDelta(aircraft.lon, map.cx - 180) : 0
  const shifts = [-720, -360, 0, 360, 720].filter((s) => view.x < s + 360 && view.x + view.w > s)
  return (
    <div className="route-map">
      <svg viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} role="img" aria-label="Map of the direct flight route from departure to destination">
        <rect x={view.x} y={view.y} width={view.w} height={view.h} fill={WATER} />
        {world
          ? shifts.map((shift) => (
            <g key={shift} transform={`translate(${shift} 0)`}>
              <path d={world.countries} transform="scale(0.1)" fill="#21394a" stroke="none" />
              <path d={world.states} transform="scale(0.1)" fill="none" stroke="#4b6475" strokeWidth={0.6} strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
              <path d={world.countries} transform="scale(0.1)" fill="none" stroke="#7d97a6" strokeWidth={0.9} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
              <path d={world.lakes} transform="scale(0.05)" fill={WATER} stroke="#5f7d8e" strokeWidth={0.6} vectorEffect="non-scaling-stroke" />
            </g>
          ))
          : null}
        <g fontFamily="Inter, system-ui, sans-serif" textAnchor="middle" dominantBaseline="central" stroke={WATER} strokeWidth={2.5 * scale} paintOrder="stroke" strokeLinejoin="round" pointerEvents="none">
          {labels.map((l) => {
            const style = STYLE[l.kind]
            return (
              <text key={l.key} x={l.x} y={l.y} fill={style.fill} fontSize={style.size * scale} fontStyle={style.italic ? 'italic' : undefined}
                fontWeight={l.kind === 'country' ? 600 : 400} letterSpacing={style.spacing * style.size * scale}>{l.text}</text>
            )
          })}
        </g>
        <path d={map.path} fill="none" stroke="#7cf0c5" strokeWidth={scale * 2.5} strokeDasharray={`${scale * 7} ${scale * 5}`} />
        <circle cx={from.lon + 180} cy={90 - from.lat} r={scale * 5} fill="#fff" />
        <g transform={`translate(${end.lon + 180} ${90 - end.lat}) scale(${scale})`}><circle r="13" fill="#091c2c" stroke="#7cf0c5" strokeWidth="2" /><text textAnchor="middle" dy="5" fill="#7cf0c5" fontSize="17">✈</text></g>
        {aircraft ? <g transform={`translate(${liveLon + 180} ${90 - aircraft.lat}) rotate(${aircraft.heading}) scale(${scale})`}><path d="M0 -10 L6 8 L0 4 L-6 8 Z" fill="#4da3ff" stroke="white" strokeWidth="1.5" /></g> : null}
      </svg>
      <div className="route-legend"><span>● Departure</span><span>✈ Destination</span>{aircraft ? <span>▲ Your aircraft</span> : null}</div>
    </div>
  )
}
