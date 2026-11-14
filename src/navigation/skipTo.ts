import { destinationPoint, navigationTo, type GeoPoint } from './route'

export const METERS_PER_MILE = 1609.344
export const MIN_SKIP_MILES = 1
export const MAX_SKIP_MILES = 10000

/** Place on the destination-to-aircraft great circle, then compute the inbound
 * bearing at the new location (not simply the reciprocal at the airport). */
export function skipToPosition(current: GeoPoint, destination: GeoPoint, miles: number, currentHeading = 0) {
  if (!Number.isFinite(miles) || miles < MIN_SKIP_MILES || miles > MAX_SKIP_MILES) {
    throw new Error(`Enter a distance from ${MIN_SKIP_MILES} to ${MAX_SKIP_MILES.toLocaleString('en-US')} miles.`)
  }
  if (![current.lat, current.lon, destination.lat, destination.lon, currentHeading].every(Number.isFinite)) {
    throw new Error('Your current position is not ready yet. Try again in a moment.')
  }
  const outbound = navigationTo(destination, current)
  const bearing = outbound.distanceNm < 0.01 ? currentHeading + 180 : outbound.bearing
  const point = destinationPoint(destination, bearing, miles * METERS_PER_MILE)
  // The simulation clamps latitudes at 89.9°; reject instead of silently moving
  // the requested point and changing the remaining distance.
  if (Math.abs(point.lat) > 89.9) throw new Error('That point is too close to a pole. Try a slightly different distance.')
  return { ...point, heading: navigationTo(point, destination).bearing }
}

export interface SkipTransition {
  fade: (stage: 'out' | 'in') => void
  wait: (ms: number) => Promise<void>
  spawn: () => void
  ready: () => boolean
}

/** Keep the relocation behind an opaque screen until its own snapshot and
 * terrain placement are ready. All waits must reject when the owner unmounts. */
export async function runSkipTransition(transition: SkipTransition) {
  transition.fade('out')
  await transition.wait(500)
  transition.spawn()
  let elapsed = 0
  do {
    await transition.wait(100)
    elapsed += 100
    if (transition.ready() && elapsed >= 700) {
      transition.fade('in')
      await transition.wait(500)
      return
    }
  } while (elapsed < 15000)
  throw new Error('The flight could not finish loading. Please try again.')
}
