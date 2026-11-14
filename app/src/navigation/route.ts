export interface GeoPoint { lat: number; lon: number }
const RAD = Math.PI / 180
const EARTH_NM = 6371008.8 / 1852

/** Signed shortest turn, including the north/antimeridian wrap. */
export function angleDelta(target: number, heading: number) {
  return ((target - heading) % 360 + 540) % 360 - 180
}

export function navigationTo(from: GeoPoint, to: GeoPoint) {
  const a = from.lat * RAD, b = to.lat * RAD
  const dl = angleDelta(to.lon, from.lon) * RAD
  const h = Math.sin((b - a) / 2) ** 2 + Math.cos(a) * Math.cos(b) * Math.sin(dl / 2) ** 2
  const distanceNm = 2 * EARTH_NM * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))))
  const bearing = (Math.atan2(Math.sin(dl) * Math.cos(b), Math.cos(a) * Math.sin(b) - Math.sin(a) * Math.cos(b) * Math.cos(dl)) / RAD + 360) % 360
  return { distanceNm, bearing }
}

/** Sample a direct great-circle route; unwrap longitude so Pacific routes stay local. */
export function routePoints(from: GeoPoint, to: GeoPoint, steps = 128): GeoPoint[] {
  const { bearing, distanceNm } = navigationTo(from, to)
  const a = from.lat * RAD, lon = from.lon * RAD, heading = bearing * RAD
  const points: GeoPoint[] = []
  let previous = from.lon
  for (let i = 0; i <= steps; i++) {
    const d = distanceNm / EARTH_NM * i / steps
    const lat = Math.asin(Math.max(-1, Math.min(1, Math.sin(a) * Math.cos(d) + Math.cos(a) * Math.sin(d) * Math.cos(heading))))
    const rawLon = (lon + Math.atan2(Math.sin(heading) * Math.sin(d) * Math.cos(a), Math.cos(d) - Math.sin(a) * Math.sin(lat))) / RAD
    const next = i === steps ? to : { lat: lat / RAD, lon: rawLon }
    previous += angleDelta(next.lon, previous)
    points.push({ lat: next.lat, lon: previous })
  }
  return points
}

/** Point reached from `from` along an initial great-circle bearing (degrees) after `meters`. */
export function destinationPoint(from: GeoPoint, bearingDeg: number, meters: number): GeoPoint {
  const d = meters / 6371008.8
  const a = from.lat * RAD, lon = from.lon * RAD, b = bearingDeg * RAD
  const lat = Math.asin(Math.max(-1, Math.min(1, Math.sin(a) * Math.cos(d) + Math.cos(a) * Math.sin(d) * Math.cos(b))))
  const lon2 = lon + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(a), Math.cos(d) - Math.sin(a) * Math.sin(lat))
  return { lat: lat / RAD, lon: ((lon2 / RAD + 540) % 360) - 180 }
}
