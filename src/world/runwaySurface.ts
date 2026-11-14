import { Vector3 } from 'three'
import type { AirportDetail, Runway } from '../sim/protocol'
import { enuBasis, geodeticToEcef } from './frame'

const FT = 0.3048
export const RUNWAY_CLEARANCE = 14

export interface RunwaySurface {
  start: Vector3
  forward: Vector3
  right: Vector3
  up: Vector3
  length: number
  width: number
}

/** Runway coordinates come from the airport database, independently of the streamed mesh. */
export function runwaySurface(runway: Runway, detail: AirportDetail): RunwaySurface | null {
  const [near, far] = runway.ends
  const width = runway.width_ft * FT
  const a = geodeticToEcef(near.lat, near.lon, (near.elevation_ft ?? detail.airport.elevation_ft) * FT + detail.geoid_m)
  const b = geodeticToEcef(far.lat, far.lon, (far.elevation_ft ?? detail.airport.elevation_ft) * FT + detail.geoid_m)
  const forward = b.sub(a)
  const length = forward.length()
  if (!(width > 0 && length >= 50 && length <= 8000)) return null
  forward.divideScalar(length)
  const { u } = enuBasis((near.lat + far.lat) * 0.5, near.lon)
  const right = forward.clone().cross(u).normalize()
  const up = right.clone().cross(forward).normalize()
  return { start: a, forward, right, up, length, width }
}

export function runwayClearsPoint(surface: RunwaySurface, point: Vector3, scratch: Vector3) {
  const relative = scratch.subVectors(point, surface.start)
  const along = relative.dot(surface.forward)
  const height = relative.dot(surface.up)
  return along >= 0 && along <= surface.length &&
    Math.abs(relative.dot(surface.right)) <= surface.width * 0.5 &&
    height >= -0.15 && height <= RUNWAY_CLEARANCE
}
