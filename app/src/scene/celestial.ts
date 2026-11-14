import { Body, GeoVector, KM_PER_AU } from 'astronomy-engine'
import { getECIToECEFRotationMatrix, getMoonFixedToECIRotationMatrix } from '@takram/three-atmosphere'
import { MathUtils, Matrix4, Quaternion, Vector3 } from 'three'

const AU_METRES = KM_PER_AU * 1000
const MOON_RADIUS = 1737400

/** Manual solar time keeps today's calendar date at the aircraft's longitude. */
export function sceneDate(realTime: boolean, hour: number, lon: number, now = new Date()) {
  if (realTime) return new Date(now)
  const solarToday = new Date(now.getTime() + lon * 240000)
  return new Date(Date.UTC(solarToday.getUTCFullYear(), solarToday.getUTCMonth(), solarToday.getUTCDate()) +
    (hour - lon / 15) * 3600000)
}

/** Observer-relative ephemeris in Earth-fixed coordinates, including lunar parallax. */
export class CelestialState {
  readonly inertialToECEF = new Matrix4()
  readonly moonFixedFromECEF = new Matrix4()
  readonly sunDirection = new Vector3()
  readonly moonDirection = new Vector3()
  readonly moonSunDirection = new Vector3()
  moonAngularRadius = 0.0045
  illuminatedFraction = 0
  private readonly sunPosition = new Vector3()
  private readonly moonPosition = new Vector3()

  update(date: Date, observerECEF: Vector3) {
    getECIToECEFRotationMatrix(date, this.inertialToECEF)
    const sun = GeoVector(Body.Sun, date, true)
    const moon = GeoVector(Body.Moon, date, false)
    this.sunPosition.set(sun.x, sun.y, sun.z).multiplyScalar(AU_METRES).applyMatrix4(this.inertialToECEF)
    this.moonPosition.set(moon.x, moon.y, moon.z).multiplyScalar(AU_METRES).applyMatrix4(this.inertialToECEF)
    this.sunDirection.subVectors(this.sunPosition, observerECEF).normalize()
    this.moonDirection.subVectors(this.moonPosition, observerECEF)
    this.moonAngularRadius = Math.asin(MOON_RADIUS / this.moonDirection.length())
    this.moonDirection.normalize()
    this.moonSunDirection.subVectors(this.sunPosition, this.moonPosition).normalize()
    this.illuminatedFraction = MathUtils.clamp((1 - this.moonDirection.dot(this.moonSunDirection)) * 0.5, 0, 1)
    // Body-fixed lunar longitudes include the Moon's spin/libration, then the
    // renderer's view naturally supplies the observer's apparent tilt.
    getMoonFixedToECIRotationMatrix(date, this.moonFixedFromECEF)
    this.moonFixedFromECEF.premultiply(this.inertialToECEF).transpose()
  }
}

/** Dark-adapted visibility: continuous through civil, nautical and astronomical twilight. */
export function starIntensity(sunElevationSin: number, moonLight: number) {
  const twilight = 1 - MathUtils.smoothstep(sunElevationSin, Math.sin(-18 * Math.PI / 180), Math.sin(-2 * Math.PI / 180))
  return 32 * twilight * twilight * (1 - 0.65 * MathUtils.clamp(moonLight, 0, 1))
}

/** Catalog coordinates are inertial; the scene is a moving local tangent frame. */
export function starRotation(inertialToECEF: Matrix4, worldFromECEF: Quaternion, out: Quaternion) {
  return out.setFromRotationMatrix(inertialToECEF).premultiply(worldFromECEF)
}
