import { useEffect, useMemo, useState } from 'react'
import { angleDelta, routePoints, type GeoPoint } from '../navigation/route'

export function RouteMap({ from, to, aircraft }: { from: GeoPoint; to: GeoPoint; aircraft?: GeoPoint & { heading: number } }) {
  const [land, setLand] = useState('')
  useEffect(() => {
    let alive = true
    import('../assets/world-land.json').then((m) => { if (alive) setLand(m.default.path) })
    return () => { alive = false }
  }, [])
  const map = useMemo(() => {
    const points = routePoints(from, to)
    const xs = points.map((p) => p.lon + 180), ys = points.map((p) => 90 - p.lat)
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2
    const width = Math.max(0.6, (Math.max(...xs) - Math.min(...xs)) * 1.3, (Math.max(...ys) - Math.min(...ys)) * 2.6)
    return { points, cx, cy, width, path: points.map((p, i) => `${i ? 'L' : 'M'}${p.lon + 180},${90 - p.lat}`).join(' ') }
  }, [from, to])
  const scale = map.width / 800
  const end = map.points[map.points.length - 1]
  const liveLon = aircraft ? map.cx - 180 + angleDelta(aircraft.lon, map.cx - 180) : 0
  return (
    <div className="route-map">
      <svg viewBox={`${map.cx - map.width / 2} ${map.cy - map.width / 4} ${map.width} ${map.width / 2}`} role="img" aria-label="Direct flight route from departure to destination">
        <rect x={map.cx - map.width / 2} y={map.cy - map.width / 4} width={map.width} height={map.width / 2} fill="#091c2c" />
        {[-720, -360, 0, 360, 720].map((shift) => <path key={shift} transform={`translate(${shift} 0)`} d={land} fill="#233e4c" stroke="#496271" strokeWidth={scale * 0.6} />)}
        <path d={map.path} fill="none" stroke="#7cf0c5" strokeWidth={scale * 2.5} strokeDasharray={`${scale * 7} ${scale * 5}`} />
        <circle cx={from.lon + 180} cy={90 - from.lat} r={scale * 5} fill="#fff" />
        <g transform={`translate(${end.lon + 180} ${90 - end.lat}) scale(${scale})`}><circle r="13" fill="#091c2c" stroke="#7cf0c5" strokeWidth="2" /><text textAnchor="middle" dy="5" fill="#7cf0c5" fontSize="17">✈</text></g>
        {aircraft ? <g transform={`translate(${liveLon + 180} ${90 - aircraft.lat}) rotate(${aircraft.heading}) scale(${scale})`}><path d="M0 -10 L6 8 L0 4 L-6 8 Z" fill="#4da3ff" stroke="white" strokeWidth="1.5" /></g> : null}
      </svg>
      <div className="route-legend"><span>● Departure</span><span>✈ Destination</span>{aircraft ? <span>▲ Your aircraft</span> : null}</div>
    </div>
  )
}
