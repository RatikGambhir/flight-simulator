// Floating-origin reference frame.
//
// The scene ("world") is a local East-Up-South tangent frame anchored at an
// origin on/near the aircraft: X = east, Y = up, Z = south (so -Z is north,
// matching three.js' forward axis). All geometry is placed by converting from
// ECEF (f64) into this frame on the CPU in double precision, so the GPU only
// ever sees small coordinates and Earth-scale float32 jitter is avoided.
// When the aircraft strays too far from the origin we rebase.

import { Matrix4, Quaternion, Vector3 } from 'three'

export const WGS84_A = 6378137.0
export const WGS84_F = 1 / 298.257223563
export const WGS84_E2 = WGS84_F * (2 - WGS84_F)
const DEG = Math.PI / 180

export function geodeticToEcef(latDeg: number, lonDeg: number, h: number, out = new Vector3()) {
  const lat = latDeg * DEG
  const lon = lonDeg * DEG
  const sl = Math.sin(lat)
  const cl = Math.cos(lat)
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sl * sl)
  return out.set((n + h) * cl * Math.cos(lon), (n + h) * cl * Math.sin(lon), (n * (1 - WGS84_E2) + h) * sl)
}

export function ecefToGeodetic(x: number, y: number, z: number): { lat: number; lon: number; height: number } {
  const b = WGS84_A * (1 - WGS84_F)
  const ep2 = WGS84_E2 / (1 - WGS84_E2)
  const lon = Math.atan2(y, x)
  const r = Math.hypot(x, y)
  let beta = Math.atan2(z * WGS84_A, r * b)
  let lat = 0
  for (let i = 0; i < 3; i++) {
    const sb = Math.sin(beta)
    const cb = Math.cos(beta)
    lat = Math.atan2(z + ep2 * b * sb * sb * sb, r - WGS84_E2 * WGS84_A * cb * cb * cb)
    beta = Math.atan2((1 - WGS84_F) * Math.sin(lat), Math.cos(lat))
  }
  const sl = Math.sin(lat)
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sl * sl)
  const height = Math.abs(Math.cos(lat)) > 1e-10 ? r / Math.cos(lat) - n : Math.abs(z) / Math.abs(sl) - n * (1 - WGS84_E2)
  return { lat: lat / DEG, lon: lon / DEG, height }
}

/** East, North, Up unit vectors (ECEF) at a geodetic location. */
export function enuBasis(latDeg: number, lonDeg: number, e = new Vector3(), n = new Vector3(), u = new Vector3()) {
  const lat = latDeg * DEG
  const lon = lonDeg * DEG
  const sl = Math.sin(lat)
  const cl = Math.cos(lat)
  const so = Math.sin(lon)
  const co = Math.cos(lon)
  e.set(-so, co, 0)
  n.set(-sl * co, -sl * so, cl)
  u.set(cl * co, cl * so, sl)
  return { e, n, u }
}

const _e = new Vector3()
const _n = new Vector3()
const _u = new Vector3()
const _v = new Vector3()

/** Converts the model axes (x right, y up, z back) to sim body axes (x fwd, y left, z up). */
export const BODY_FROM_MODEL = new Quaternion().setFromRotationMatrix(
  new Matrix4().makeBasis(new Vector3(0, -1, 0), new Vector3(0, 0, 1), new Vector3(-1, 0, 0)),
)

type RebaseListener = (worldFromOld: Matrix4) => void

class WorldFrame {
  /** ECEF position of the world origin. */
  readonly origin = new Vector3(1, 0, 0)
  readonly originLat = { lat: 0, lon: 0 }
  /** world -> ECEF (rotation + translation). Passed to the atmosphere as worldToECEFMatrix. */
  readonly ecefFromWorld = new Matrix4()
  /** ECEF -> world. Applied to the 3D tiles groups. */
  readonly worldFromEcef = new Matrix4()
  /** Rotation part of worldFromEcef. */
  readonly worldFromEcefRot = new Quaternion()
  version = 0
  private listeners = new Set<RebaseListener>()

  /** Re-anchors the world origin at an ECEF position (rebasing all world-space state). */
  setOrigin(x: number, y: number, z: number) {
    const oldEcefFromWorld = this.ecefFromWorld.clone()
    const hadOrigin = this.version > 0
    const g = ecefToGeodetic(x, y, z)
    this.originLat.lat = g.lat
    this.originLat.lon = g.lon
    enuBasis(g.lat, g.lon, _e, _n, _u)
    this.origin.set(x, y, z)
    this.ecefFromWorld.makeBasis(_e, _u, _n.clone().negate()).setPosition(this.origin)
    this.worldFromEcef.copy(this.ecefFromWorld).invert()
    this.worldFromEcefRot.setFromRotationMatrix(this.worldFromEcef)
    this.version++
    if (hadOrigin) {
      const worldFromOld = this.worldFromEcef.clone().multiply(oldEcefFromWorld)
      this.listeners.forEach((l) => l(worldFromOld))
    }
  }

  onRebase(l: RebaseListener) {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }

  /** ECEF -> world position, computed relative to the origin in double precision. */
  ecefToWorld(x: number, y: number, z: number, out = new Vector3()) {
    _v.set(x - this.origin.x, y - this.origin.y, z - this.origin.z)
    return out.copy(_v).applyQuaternion(this.worldFromEcefRot)
  }

  worldToEcef(p: Vector3, out = new Vector3()) {
    return out.copy(p).applyMatrix4(this.ecefFromWorld)
  }

  /** Local "up" (ellipsoid normal) at a world position, in world coordinates. */
  upAt(p: Vector3, out = new Vector3()) {
    this.worldToEcef(p, _v)
    const g = ecefToGeodetic(_v.x, _v.y, _v.z)
    enuBasis(g.lat, g.lon, _e, _n, _u)
    return out.copy(_u).applyQuaternion(this.worldFromEcefRot)
  }

  /** ENU basis at a lat/lon expressed in world coordinates. */
  enuInWorld(latDeg: number, lonDeg: number, e: Vector3, n: Vector3, u: Vector3) {
    enuBasis(latDeg, lonDeg, e, n, u)
    e.applyQuaternion(this.worldFromEcefRot)
    n.applyQuaternion(this.worldFromEcefRot)
    u.applyQuaternion(this.worldFromEcefRot)
  }
}

export const frame = new WorldFrame()
frame.setOrigin(...(geodeticToEcef(41.98, -87.9, 200).toArray() as [number, number, number]))
