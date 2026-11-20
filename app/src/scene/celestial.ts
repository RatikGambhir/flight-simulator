import { Body, GeoVector, KM_PER_AU, Refraction } from 'astronomy-engine'
import { getECIToECEFRotationMatrix, getMoonFixedToECIRotationMatrix } from '@takram/three-atmosphere'
import { MathUtils, Matrix3, Matrix4, Quaternion, Vector3, Vector4 } from 'three'
import { WGS84_A, WGS84_F } from '../world/frame'

const AU_METRES = KM_PER_AU * 1000
const MOON_RADIUS = 1737400
export const EARTH_POLAR_RATIO = 1 - WGS84_F

/** Convert a local solar date and hour to UTC, defaulting to today's local date. */
export function sceneDate(realTime: boolean, hour: number, lon: number, now = new Date(), day = '') {
  if (realTime) return new Date(now)
  const solarToday = new Date(now.getTime() + lon * 240000)
  const selectedDay = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : NaN
  const midnight = Number.isFinite(selectedDay) ? selectedDay : solarToday.setUTCHours(0, 0, 0, 0)
  return new Date(midnight + (hour - lon / 15) * 3600000)
}

interface SceneClockSettings {
  realTime: boolean
  timeOfDay: number
  skyDate: string
  advanceSkyTime: boolean
}

/** The simulation snapshot clock measures unscaled elapsed seconds. */
export class SceneClock {
  private settings: SceneClockSettings | undefined
  private lastSeconds = 0
  private simulatedUtc = 0

  tick(settings: SceneClockSettings, lon: number, seconds: number, rate: number, now?: Date) {
    const prev = this.settings
    const changed = !prev || prev.realTime !== settings.realTime || prev.skyDate !== settings.skyDate ||
      prev.timeOfDay !== settings.timeOfDay || prev.advanceSkyTime !== settings.advanceSkyTime
    if (!settings.realTime && settings.advanceSkyTime) {
      if (changed) this.simulatedUtc = sceneDate(false, settings.timeOfDay, lon, now, settings.skyDate).getTime()
      else this.simulatedUtc += Math.max(0, seconds - this.lastSeconds) * rate * 1000
    }
    this.settings = settings
    this.lastSeconds = seconds
    return changed
  }

  date(settings: SceneClockSettings, lon: number, now = new Date()) {
    return !settings.realTime && settings.advanceSkyTime
      ? new Date(this.simulatedUtc)
      : sceneDate(settings.realTime, settings.timeOfDay, lon, now, settings.skyDate)
  }
}

/** Observer-relative ephemeris in Earth-fixed coordinates, including lunar parallax. */
export class CelestialState {
  readonly inertialToECEF = new Matrix4()
  readonly moonFixedFromECEF = new Matrix4()
  readonly sunDirection = new Vector3()
  readonly moonDirection = new Vector3()
  readonly moonSunDirection = new Vector3()
  sunAngularRadius = 0.00465
  moonAngularRadius = 0.0045
  illuminatedFraction = 0
  geoidHeight = 0
  private sampledUtc = NaN
  private readonly sunPosition = new Vector3()
  private readonly moonPosition = new Vector3()

  update(date: Date, observerECEF: Vector3) {
    const utc = date.getTime()
    if (utc !== this.sampledUtc) {
      this.sampledUtc = utc
      getECIToECEFRotationMatrix(date, this.inertialToECEF)
      const sun = GeoVector(Body.Sun, date, true)
      const moon = GeoVector(Body.Moon, date, false)
      this.sunPosition.set(sun.x, sun.y, sun.z).multiplyScalar(AU_METRES).applyMatrix4(this.inertialToECEF)
      this.moonPosition.set(moon.x, moon.y, moon.z).multiplyScalar(AU_METRES).applyMatrix4(this.inertialToECEF)
      this.moonSunDirection.subVectors(this.sunPosition, this.moonPosition).normalize()
      // The body's spin and libration are shared by every observer.
      getMoonFixedToECIRotationMatrix(date, this.moonFixedFromECEF)
      this.moonFixedFromECEF.premultiply(this.inertialToECEF).transpose()
    }
    this.sunDirection.subVectors(this.sunPosition, observerECEF)
    this.sunAngularRadius = Math.asin(695_700_000 / this.sunDirection.length())
    this.sunDirection.normalize()
    this.moonDirection.subVectors(this.moonPosition, observerECEF)
    this.moonAngularRadius = Math.asin(MOON_RADIUS / this.moonDirection.length())
    this.moonDirection.normalize()
    this.illuminatedFraction = MathUtils.clamp((1 - this.moonDirection.dot(this.moonSunDirection)) * 0.5, 0, 1)
  }

  observeMoon(observerECEF: Vector3, view: LunarView) {
    view.update(this.moonPosition, observerECEF, this.geoidHeight)
  }

  get ready() {
    return Number.isFinite(this.sampledUtc)
  }
}

/** Camera-local parallax, refraction and Earth occultation, in ECEF axes. */
export class LunarView {
  readonly direction = new Vector3()
  readonly apparentDirection = new Vector3()
  readonly rayFromApparent = new Matrix3()
  readonly horizon = new Vector4()
  readonly up = new Vector3()
  angularRadius = 0
  private readonly scaledObserver = new Vector3()
  private readonly right = new Vector3()
  private readonly vertical = new Vector3()
  private readonly basis = new Matrix3()

  update(moonECEF: Vector3, observerECEF: Vector3, geoidHeight = 0) {
    this.direction.subVectors(moonECEF, observerECEF)
    const distance = this.direction.length()
    this.direction.divideScalar(distance)
    this.angularRadius = Math.asin(MOON_RADIUS / distance)
    this.apparentDirection.copy(this.direction)
    this.rayFromApparent.identity()

    // Scaling the ellipsoid to a unit sphere gives the full curved horizon,
    // including azimuth-dependent dip. Compute the tangent threshold in f64.
    const up = this.up.copy(observerECEF)
    up.z /= EARTH_POLAR_RATIO * EARTH_POLAR_RATIO
    up.normalize()
    const eye = this.scaledObserver.copy(observerECEF).addScaledVector(up, -geoidHeight).divideScalar(WGS84_A)
    eye.z /= EARTH_POLAR_RATIO
    const radius = eye.length()
    eye.divideScalar(radius)
    const dip = -Math.sqrt(Math.max(0, 1 - 1 / (radius * radius)))
    this.horizon.set(eye.x, eye.y, eye.z, dip)

    const height = Math.max(0, (radius - 1) * WGS84_A)
    const altitude = MathUtils.radToDeg(Math.asin(MathUtils.clamp(this.direction.dot(up), -1, 1)))
    if (height > 60_000 || altitude < MathUtils.radToDeg(Math.asin(dip)) - 1 || altitude >= 89) return
    // Standard-air refraction with an altitude-dependent density correction.
    // The differential bending across the disk flattens it near moonrise.
    const density = Math.exp(-height / 8500)
    const lift = density * Refraction('normal', altitude)
    const halfDiameter = MathUtils.radToDeg(this.angularRadius)
    const verticalScale = 1 + density * (Refraction('normal', altitude + halfDiameter) -
      Refraction('normal', altitude - halfDiameter)) / (2 * halfDiameter)
    const right = this.right.crossVectors(up, this.direction).normalize()
    this.apparentDirection.applyAxisAngle(right, -MathUtils.degToRad(lift))
    const vertical = this.vertical.crossVectors(this.direction, right)
    this.rayFromApparent.set(
      right.x, vertical.x / verticalScale, this.direction.x,
      right.y, vertical.y / verticalScale, this.direction.y,
      right.z, vertical.z / verticalScale, this.direction.z,
    )
    vertical.crossVectors(this.apparentDirection, right)
    this.basis.set(
      right.x, right.y, right.z,
      vertical.x, vertical.y, vertical.z,
      this.apparentDirection.x, this.apparentDirection.y, this.apparentDirection.z,
    )
    this.rayFromApparent.multiply(this.basis)
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
