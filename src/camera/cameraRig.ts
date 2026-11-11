// Camera modes. All positions are derived from the aircraft each frame (or,
// for the flyby, from an ECEF anchor) so floating-origin rebases are free.
//
// Realism touches:
//  * Exterior cameras sit rigidly behind a smoothed heading, so the aircraft
//    stays steady on screen regardless of frame-time jitter. A soft spring
//    driven by the felt g-load lets the aircraft "move" in the frame as it
//    pulls up, accelerates or hits turbulence.
//  * In the cockpit the pilot's head is a damped spring pushed by the same
//    accelerations, with runway rumble on the ground.

import { MathUtils, Matrix3, Quaternion, Vector3, type Matrix4, type PerspectiveCamera } from 'three'
import type { CameraMode } from '../state/store'
import { frame } from '../world/frame'

const _up = new Vector3()
const _fwd = new Vector3()
const _right = new Vector3()
const _v = new Vector3()
const _w = new Vector3()
const _axis = new Vector3()
const _dir = new Vector3()
const _sf = new Vector3()
const _q = new Quaternion()
const _target = new Vector3()
const _rot = new Matrix3()

export interface AircraftPose {
  position: Vector3
  quaternion: Quaternion
  /** World velocity (m/s). */
  velocity: Vector3
  length: number
  span: number
  eye: Vector3
  wingTip: Vector3
  /** Felt specific force in model axes (x right, y up, z back), in g. */
  specificForce: Vector3
  /** Height of the aircraft's reference point above the ground (m). */
  heightAboveGround: number
  onGround: boolean
  groundSpeed: number
}

/** Critically-damped-ish spring on a vector (semi-implicit Euler). */
class Spring {
  readonly x = new Vector3()
  readonly v = new Vector3()
  constructor(
    private omega: number,
    private zeta: number,
  ) {}

  update(target: Vector3, dt: number, limit: number) {
    const w = this.omega
    const h = Math.min(dt, 1 / 30)
    // a = w²(target - x) - 2ζw v
    _w.copy(target).sub(this.x).multiplyScalar(w * w).addScaledVector(this.v, -2 * this.zeta * w)
    this.v.addScaledVector(_w, h)
    this.x.addScaledVector(this.v, h)
    if (this.x.length() > limit) this.x.setLength(limit)
  }

  reset() {
    this.x.set(0, 0, 0)
    this.v.set(0, 0, 0)
  }
}

/** Smooth pseudo-random signal in [-1, 1] from a few incommensurate sines. */
function wobble(t: number, seed: number) {
  return (
    Math.sin(t * 31.7 + seed) * 0.5 +
    Math.sin(t * 47.3 + seed * 2.1) * 0.3 +
    Math.sin(t * 73.9 + seed * 3.7) * 0.2
  )
}

export class CameraRig {
  mode: CameraMode = 'chase'
  /** Orbit angles (rad) for exterior modes and look angles for the cockpit. */
  yaw = 0
  pitch = 0.16
  lookYaw = 0
  lookPitch = -0.2
  zoom = 1
  private smoothedPos = new Vector3()
  private smoothedFwd = new Vector3(0, 0, -1)
  private initialized = false
  private flybyEcef: Vector3 | null = null
  private flybyHave = false
  private cineShot = 0
  private cineTimer = 0
  private lastMode: CameraMode = 'chase'
  private dragging = false
  private cockpitFov = 68
  private time = 0
  /** Slowly-tracking g-load; shake responds only to the bumps around it. */
  private nzSlow = 1
  /** Exterior camera lag behind the aircraft's acceleration (world, m). */
  private lag = new Spring(3.2, 0.75)
  /** Pilot head offset in model space (m). */
  private head = new Spring(9, 0.6)

  constructor(private camera: PerspectiveCamera) {
    frame.onRebase((worldFromOld: Matrix4) => {
      if (this.initialized) this.smoothedPos.applyMatrix4(worldFromOld)
      // Direction-like state only rotates.
      _rot.setFromMatrix4(worldFromOld)
      this.smoothedFwd.applyMatrix3(_rot).normalize()
      this.lag.x.applyMatrix3(_rot)
      this.lag.v.applyMatrix3(_rot)
    })
  }

  setMode(mode: CameraMode) {
    if (mode === this.mode) return
    this.mode = mode
    if (mode === 'cockpit') {
      this.lookYaw = 0
      this.lookPitch = -0.2
    }
    if (mode === 'flyby') this.flybyHave = false
    if (mode === 'cinematic') {
      this.cineTimer = 0
      this.cineShot = (this.cineShot + 1) % 5
    }
    this.lag.reset()
    this.head.reset()
  }

  resetView() {
    this.yaw = 0
    this.pitch = 0.16
    this.lookYaw = 0
    this.lookPitch = -0.2
    this.zoom = 1
    this.cockpitFov = 68
  }

  /** Mouse drag deltas in pixels. */
  drag(dx: number, dy: number) {
    this.dragging = true
    if (this.mode === 'cockpit' || this.mode === 'wing') {
      this.lookYaw = MathUtils.clamp(this.lookYaw - dx * 0.004, -2.6, 2.6)
      this.lookPitch = MathUtils.clamp(this.lookPitch - dy * 0.004, -1.2, 1.2)
    } else {
      this.yaw -= dx * 0.005
      // Drag down to look from above, up to look from below.
      this.pitch = MathUtils.clamp(this.pitch + dy * 0.004, -0.6, 1.45)
    }
  }

  endDrag() {
    this.dragging = false
  }

  wheel(delta: number) {
    if (this.mode === 'cockpit') {
      this.cockpitFov = MathUtils.clamp(this.cockpitFov + delta * 0.03, 25, 90)
      return
    }
    this.zoom = MathUtils.clamp(this.zoom * Math.exp(delta * 0.0012), 0.25, 12)
  }

  /** Called when the aircraft is re-spawned. */
  snap() {
    this.initialized = false
    this.flybyHave = false
    this.lag.reset()
    this.head.reset()
  }

  update(pose: AircraftPose, dt: number) {
    const cam = this.camera
    this.time += dt
    this.nzSlow += (pose.specificForce.y - this.nzSlow) * (1 - Math.exp(-dt * 1.5))
    frame.upAt(pose.position, _up)
    _fwd.set(0, 0, -1).applyQuaternion(pose.quaternion)
    const modeChanged = this.mode !== this.lastMode
    this.lastMode = this.mode

    // Field of view and near plane (only touch the projection when they change).
    const targetFov = this.mode === 'cockpit' ? this.cockpitFov : this.mode === 'flyby' ? 40 : 58
    const near = this.mode === 'cockpit' ? 0.03 : 0.3
    let fov = cam.fov
    if (Math.abs(fov - targetFov) > 0.01) fov = modeChanged || this.mode === 'cockpit' ? targetFov : MathUtils.lerp(fov, targetFov, Math.min(1, dt * 3))
    if (fov !== cam.fov || near !== cam.near) {
      cam.fov = fov
      cam.near = near
      cam.updateProjectionMatrix()
    }

    switch (this.mode) {
      case 'cockpit':
        this.cockpitView(pose, dt)
        break
      case 'wing':
        this.wingView(pose)
        break
      case 'free':
        this.freeView(pose, modeChanged)
        break
      case 'cinematic':
        this.cinematicView(pose, dt)
        break
      case 'flyby':
        this.flybyView(pose)
        break
      default:
        this.chaseView(pose, dt)
    }
    if (this.mode !== 'cockpit') this.keepAboveGround(pose)
    cam.updateMatrixWorld()
  }

  /** Never let an exterior camera dip below the ground under the aircraft. */
  private keepAboveGround(p: AircraftPose) {
    const cam = this.camera
    const rel = _v.copy(cam.position).sub(p.position).dot(_up)
    const above = p.heightAboveGround + rel
    const min = 1.2
    if (above < min) {
      cam.position.addScaledVector(_up, min - above)
      if (this.mode === 'chase' || this.mode === 'free' || this.mode === 'cinematic') {
        cam.lookAt(_target.copy(p.position).addScaledVector(_up, p.length * 0.06))
      }
    }
  }

  /** Felt acceleration beyond 1 g in world space (g units), for camera springs. */
  private extraG(p: AircraftPose, out: Vector3) {
    out.copy(p.specificForce).applyQuaternion(p.quaternion)
    return out.addScaledVector(_up, -1)
  }

  private orbitDirection(base: Vector3, out: Vector3) {
    // Start from `base` (unit, horizontal), swing around the vertical by yaw,
    // then raise toward the vertical by pitch.
    out.copy(base).applyAxisAngle(_up, this.yaw)
    _axis.copy(out).cross(_up).normalize()
    return out.applyAxisAngle(_axis, this.pitch)
  }

  private chaseView(p: AircraftPose, dt: number) {
    // Follow the heading smoothly (ignoring roll) so the horizon stays calm.
    const flatFwd = _v.copy(_fwd).addScaledVector(_up, -_fwd.dot(_up))
    if (flatFwd.lengthSq() < 1e-6) flatFwd.copy(this.smoothedFwd)
    flatFwd.normalize()
    if (!this.initialized) {
      this.smoothedFwd.copy(flatFwd)
      this.lag.reset()
      this.initialized = true
    } else {
      this.smoothedFwd.lerp(flatFwd, 1 - Math.exp(-dt * 2.2)).normalize()
    }
    const dist = (p.length * 1.25 + 14) * this.zoom
    this.orbitDirection(_dir.copy(this.smoothedFwd).negate(), _dir)
    // The camera trails the aircraft's acceleration a little (up to ~6 m).
    this.lag.update(this.extraG(p, _sf).multiplyScalar(-2.2 * Math.min(1.5, this.zoom)), dt, 6)
    const desired = _target.copy(p.position).addScaledVector(_dir, dist).add(this.lag.x)
    this.smoothedPos.copy(desired)
    this.camera.position.copy(desired)
    this.camera.up.copy(_up)
    this.camera.lookAt(_v.copy(p.position).addScaledVector(_up, p.length * 0.06))
    this.applyShake(p, 0.0012)
  }

  private cockpitView(p: AircraftPose, dt: number) {
    this.initialized = false
    const cam = this.camera
    // Head pushed opposite the felt acceleration beyond 1 g (model space), ~4 cm per g.
    _sf.copy(p.specificForce)
    _sf.y -= 1
    _sf.multiplyScalar(-0.04)
    _sf.y *= 0.8
    this.head.update(_sf, dt, 0.1)
    cam.position.copy(p.eye).add(this.head.x).applyQuaternion(p.quaternion).add(p.position)
    // Body orientation, then head look (yaw about body up, pitch about head right).
    cam.quaternion.copy(p.quaternion)
    cam.rotateY(this.lookYaw)
    cam.rotateX(this.lookPitch)
    cam.up.set(0, 1, 0).applyQuaternion(p.quaternion)
    this.applyShake(p, 0.003)
  }

  /** Small rotational shake: runway rumble and buffeting. */
  private applyShake(p: AircraftPose, scale: number) {
    let amp = 0
    if (p.onGround) amp += Math.min(1, p.groundSpeed / 70) * 0.8 + (p.groundSpeed > 1 ? 0.1 : 0)
    // High-frequency part of the g-load (turbulence, touchdown).
    const bump = Math.abs(p.specificForce.y - this.nzSlow)
    amp += Math.min(1.5, bump * 1.2)
    if (amp < 1e-3) return
    const t = this.time
    _q.setFromAxisAngle(_v.set(1, 0, 0), wobble(t, 0.3) * amp * scale)
    this.camera.quaternion.multiply(_q)
    _q.setFromAxisAngle(_v.set(0, 1, 0), wobble(t, 1.9) * amp * scale * 0.6)
    this.camera.quaternion.multiply(_q)
  }

  private wingView(p: AircraftPose) {
    this.initialized = false
    const cam = this.camera
    // Above the fuselage side, looking out over the right wing toward the tip.
    _v.set(p.wingTip.x * 0.18, p.span * 0.035 + 1.4, p.wingTip.z - 1.5)
    cam.position.copy(_v).applyQuaternion(p.quaternion).add(p.position)
    _w.copy(p.wingTip)
    _w.y -= 0.5
    _w.z += 2.5
    _w.applyQuaternion(p.quaternion).add(p.position)
    cam.up.set(0, 1, 0).applyQuaternion(p.quaternion)
    cam.lookAt(_w)
    cam.rotateY(this.lookYaw)
    cam.rotateX(this.lookPitch)
  }

  private freeView(p: AircraftPose, entered: boolean) {
    this.initialized = false
    if (entered) {
      this.yaw = 0.8
      this.pitch = 0.3
    }
    // World-fixed orbit around the aircraft (does not rotate with it).
    const dist = (p.length * 1.6 + 20) * this.zoom
    const north = _v.set(0, 0, -1)
    north.addScaledVector(_up, -north.dot(_up)).normalize()
    this.orbitDirection(north, _dir)
    this.camera.position.copy(p.position).addScaledVector(_dir, dist)
    this.camera.up.copy(_up)
    this.camera.lookAt(p.position)
  }

  private cinematicView(p: AircraftPose, dt: number) {
    this.cineTimer += dt
    if (this.cineTimer > 9 && !this.dragging) {
      this.cineTimer = 0
      this.cineShot = (this.cineShot + 1) % 5
      this.initialized = false
    }
    const L = p.length
    const t = this.cineTimer
    // Shots in aircraft-heading space: [right, up, back] offsets + slow drift.
    let rx = 0
    let ry = 0
    let rb = 0
    switch (this.cineShot) {
      case 0:
        rx = L * 0.9 + t * 0.4
        ry = L * 0.12
        rb = -L * 0.6 + t * 1.2
        break
      case 1:
        rx = -L * 0.7
        ry = L * 0.35
        rb = L * 1.4 - t * 0.6
        break
      case 2:
        rx = L * 0.15
        ry = L * 1.6 + t * 0.2
        rb = L * 0.4
        break
      case 3:
        rx = -L * 1.1
        ry = L * 0.05
        rb = -L * 0.25
        break
      default:
        rx = L * 0.35
        ry = L * 0.08
        rb = L * 1.0 + t * 0.3
    }
    const flatFwd = _v.copy(_fwd).addScaledVector(_up, -_fwd.dot(_up)).normalize()
    if (!this.initialized) this.smoothedFwd.copy(flatFwd)
    else this.smoothedFwd.lerp(flatFwd, 1 - Math.exp(-dt * 1.2)).normalize()
    _right.copy(this.smoothedFwd).cross(_up).normalize()
    // Offsets are relative to the aircraft, so smoothing them never makes it jitter.
    const desired = _target.set(0, 0, 0).addScaledVector(_right, rx).addScaledVector(_up, ry).addScaledVector(this.smoothedFwd, -rb)
    if (!this.initialized) {
      this.smoothedPos.copy(desired)
      this.initialized = true
    } else this.smoothedPos.lerp(desired, 1 - Math.exp(-dt * 3))
    this.camera.position.copy(p.position).add(this.smoothedPos)
    this.camera.up.copy(_up)
    this.camera.lookAt(p.position)
  }

  private flybyView(p: AircraftPose) {
    this.initialized = false
    const speed = p.velocity.length()
    const heading = speed > 3 ? _dir.copy(p.velocity).normalize() : _dir.copy(_fwd)
    let needNew = !this.flybyHave
    if (!needNew && this.flybyEcef) {
      const rel = frame.ecefToWorld(this.flybyEcef.x, this.flybyEcef.y, this.flybyEcef.z, _v).sub(p.position)
      const ahead = rel.dot(heading)
      needNew = ahead < -Math.max(120, speed * 3) || rel.length() > 4000
    }
    if (needNew) {
      _right.copy(heading).cross(_up).normalize()
      const lead = Math.max(150, speed * 7)
      _w.copy(p.position)
        .addScaledVector(heading, lead)
        .addScaledVector(_right, p.span * 0.9 + 15)
        .addScaledVector(_up, p.length * 0.25 + 4)
      this.flybyEcef = frame.worldToEcef(_w, this.flybyEcef ?? new Vector3())
      this.flybyHave = true
    }
    const fe = this.flybyEcef!
    frame.ecefToWorld(fe.x, fe.y, fe.z, this.camera.position)
    this.camera.up.copy(_up)
    this.camera.lookAt(p.position)
  }
}
