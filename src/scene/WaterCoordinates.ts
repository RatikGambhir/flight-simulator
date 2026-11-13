import { Matrix4, Vector3 } from 'three'

interface LocalFrame {
  origin: Vector3
  worldFromEcef: Matrix4
  ecefFromWorld: Matrix4
}

// A local tangent plane is only valid near its origin. In particular, the
// initial Chicago plane is almost edge-on to the sea at Tokyo Haneda.
const MAX_ANCHOR_DISTANCE = 250_000

/** Stable metre-scale wave coordinates, refreshed after a distant flight change. */
export class WaterCoordinates {
  readonly matrix = new Matrix4()
  private readonly anchorFromEcef = new Matrix4()
  private readonly anchorOrigin = new Vector3(Infinity, Infinity, Infinity)

  update(frame: LocalFrame) {
    if (this.anchorOrigin.distanceToSquared(frame.origin) > MAX_ANCHOR_DISTANCE ** 2) {
      this.anchorOrigin.copy(frame.origin)
      this.anchorFromEcef.copy(frame.worldFromEcef)
    }
    // Compute the cancellation of Earth-sized translations on the CPU in
    // double precision. Ordinary 3 km rebases keep exactly the same waves.
    this.matrix.multiplyMatrices(this.anchorFromEcef, frame.ecefFromWorld)
  }
}
