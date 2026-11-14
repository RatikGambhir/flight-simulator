// The runway the landing guide is pointing at, shared with the HUD so the
// compass can show which heading lines the aircraft up with it.

import { navigationTo, type GeoPoint } from './route'

export interface LandingRunway {
  ident: string
  /** Landing threshold and the far end of the runway. */
  near: GeoPoint
  far: GeoPoint
  lengthM: number
}

/** Set by the landing guide while it has a runway; null otherwise. */
export const landingRunway: { current: LandingRunway | null } = { current: null }

const RAD = Math.PI / 180
const M_PER_DEG = 111_320

/**
 * Heading to fly to end up on the runway's extended centreline, pointing down
 * the runway. Off to one side it aims at a point further along the centreline
 * (never cutting in at more than 45 degrees while there is room, and always
 * joining before the threshold); on the centreline it is the runway heading.
 */
export function lineupHeading(from: GeoPoint, runway: LandingRunway) {
  const course = navigationTo(runway.near, runway.far).bearing
  const dE = (((from.lon - runway.near.lon + 540) % 360) - 180) * M_PER_DEG * Math.cos(runway.near.lat * RAD)
  const dN = (from.lat - runway.near.lat) * M_PER_DEG
  const sin = Math.sin(course * RAD)
  const cos = Math.cos(course * RAD)
  /** Distance past the threshold along the runway (negative on approach). */
  const along = dE * sin + dN * cos
  /** Distance right of the centreline, looking down the runway. */
  const offsetM = dE * cos - dN * sin
  const ahead = Math.max(Math.abs(offsetM), Math.abs(along) * 0.25, 1500)
  // Well off to the side, join the centreline with some final approach left
  // rather than cutting across the threshold.
  const side = Math.abs(offsetM)
  const join = side < 150 ? along + ahead : Math.min(along + ahead, -Math.min(side * 0.6, 6000))
  const reach = join - along
  const e = reach * sin - offsetM * cos
  const n = reach * cos + offsetM * sin
  const heading = (Math.atan2(e, n) / RAD + 360) % 360
  return { heading, course, offsetM, distanceNm: Math.hypot(dE, dN) / 1852 }
}
