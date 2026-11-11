// Camera modes. All positions are derived from the aircraft each frame (or,
// for the flyby, from an ECEF anchor) so floating-origin rebases are free.

import { MathUtils, Quaternion, Vector3, type PerspectiveCamera } from 'three'
import type { CameraMode } from '../state/store'
import { frame } from '../world/frame'

const _up = new Vector3()
const _fwd = new Vector3()
const _right = new Vector3()
const _v = new Vector3()
const _q = new Quaternion()
const _target = new Vector3()

export interface AircraftPose {
  position: Vector3
  quaternion: Quaternion
  /** World velocity (m/s). */
  velocity: Vector3
  length: number
  span: number
  eye: Vector3
  wingTip: Vector3
}

export class CameraRig {
  mode: CameraMode = 'chase'
  /** Orbit angles (rad) for exterior modes and look angles for the cockpit. */
  yaw = 0
  pitch = 0.18
  lookYaw = 0
  lookPitch = -0.14
  zoom = 1
  private smoothedPos = new Vector3()
  private smoothedFwd = new Vector3(0, 0, -1)
  private initialized = false
  private flybyEcef: Vector3 | null = null
  private cineShot = 0
  private cineTimer = 0
  private freeOffset = new Vector3()
  private lastMode: CameraMode = 'chase'
  private dragging = false

  constructor(private camera: PerspectiveCamera) {
    frame.onRebase((worldFromOld) => {
      if (this.initialized) this.smoothedPos.applyMatrix4(worldFromOld)
    })
  }

  setMode(mode: CameraMode) {
    if (mode === this.mode) return
    this.mode = mode
    if (mode === 'cockpit') {
      this.lookYaw = 0
      this.lookPitch = -0.14
    }
    if (mode === 'flyby') this.flybyEcef = null
    if (mode === 'cinematic') {
      this.cineTimer = 0
      this.cineShot = (this.cineShot + 1) % 5
    }
  }

  resetView() {
    this.yaw = 0
    this.pitch = 0.18
    this.lookYaw = 0
    this.lookPitch = -0.14
    this.zoom = 1
  }

  /** Mouse drag deltas in pixels. */
  drag(dx: number, dy: number) {
    this.dragging = true
    if (this.mode === 'cockpit' || this.mode === 'wing') {
      this.lookYaw = MathUtils.clamp(this.lookYaw - dx * 0.004, -2.6, 2.6)
      this.lookPitch = MathUtils.clamp(this.lookPitch - dy * 0.004, -1.2, 1.2)
    } else {
      this.yaw -= dx * 0.005
      this.pitch = MathUtils.clamp(this.pitch + dy * 0.004, -0.45, 1.45)
    }
  }

  endDrag() {
    this.dragging = false
  }

  wheel(delta: number) {
    if (this.mode === 'cockpit') {
      this.camera.fov = MathUtils.clamp(this.camera.fov + delta * 0.03, 25, 90)
      this.camera.updateProjectionMatrix()
      return
    }
    this.zoom = MathUtils.clamp(this.zoom * Math.exp(delta * 0.0012), 0.25, 12)
  }

  /** Called when the aircraft is re-spawned. */
  snap() {
    this.initialized = false
    this.flybyEcef = null
  }

  update(pose: AircraftPose, dt: number) {
    const cam = this.camera
    frame.upAt(pose.position, _up)
    _fwd.set(0, 0, -1).applyQuaternion(pose.quaternion)
    const modeChanged = this.mode !== this.lastMode
    this.lastMode = this.mode
    const targetFov = this.mode === 'cockpit' ? 68 : this.mode === 'flyby' ? 40 : 58
    if (Math.abs(cam.fov - targetFov) > 0.01 && (modeChanged || this.mode !== 'cockpit')) {
      cam.fov = modeChanged ? targetFov : MathUtils.lerp(cam.fov, targetFov, Math.min(1, dt * 3))
      cam.updateProjectionMatrix()
    }
    cam.near = this.mode === 'cockpit' ? 0.03 : 0.3
    cam.updateProjectionMatrix()

    switch (this.mode) {
      case 'cockpit':
        this.cockpitView(pose)
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
    cam.updateMatrixWorld()
  }

  private chaseView(p: AircraftPose, dt: number) {
    // Follow the heading smoothly (ignoring roll) so the horizon stays calm.
    const flatFwd = _v.copy(_fwd).sub(_up.clone().multiplyScalar(_fwd.dot(_up)))
    if (flatFwd.lengthSq() < 1e-6) flatFwd.set(0, 0, -1)
    flatFwd.normalize()
    if (!this.initialized) {
      this.smoothedFwd.copy(flatFwd)
    } else {
      this.smoothedFwd.lerp(flatFwd, 1 - Math.exp(-dt * 2.5)).normalize()
    }
    const dist = (p.length * 1.25 + 14) * this.zoom
    _right.copy(this.smoothedFwd).cross(_up).normalize()
    const dir = this.smoothedFwd.clone().multiplyScalar(-1)
    dir.applyAxisAngle(_up, this.yaw)
    const axis = dir.clone().cross(_up).normalize()
    dir.applyAxisAngle(axis, -this.pitch)
    const desired = _target.copy(p.position).addScaledVector(dir, dist)
    if (!this.initialized) {
      this.smoothedPos.copy(desired)
      this.initialized = true
    } else {
      // Critically damped follow, stiff enough to keep up at jet speeds.
      this.smoothedPos.lerp(desired, 1 - Math.exp(-dt * 8))
    }
    this.camera.position.copy(this.smoothedPos)
    this.camera.up.copy(_up)
    this.camera.lookAt(_v.copy(p.position).addScaledVector(_up, p.length * 0.06))
  }

  private cockpitView(p: AircraftPose) {
    this.initialized = false
    const cam = this.camera
    cam.position.copy(p.eye).applyQuaternion(p.quaternion).add(p.position)
    // Body orientation, then head look (yaw about body up, pitch about head right).
    _q.copy(p.quaternion)
    cam.quaternion.copy(_q)
    cam.rotateY(this.lookYaw)
    cam.rotateX(this.lookPitch)
    cam.up.set(0, 1, 0).applyQuaternion(p.quaternion)
  }

  private wingView(p: AircraftPose) {
    this.initialized = false
    const cam = this.camera
    // Above the fuselage side, looking out over the right wing toward the tip.
    const local = new Vector3(p.wingTip.x * 0.18, p.span * 0.035 + 1.4, p.wingTip.z - 1.5)
    cam.position.copy(local).applyQuaternion(p.quaternion).add(p.position)
    const look = p.wingTip.clone().add(new Vector3(0, -0.5, 2.5)).applyQuaternion(p.quaternion).add(p.position)
    cam.up.set(0, 1, 0).applyQuaternion(p.quaternion)
    cam.lookAt(look)
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
    const flat = north.sub(_up.clone().multiplyScalar(north.dot(_up))).normalize()
    const dir = flat.clone().applyAxisAngle(_up, this.yaw)
    const axis = dir.clone().cross(_up).normalize()
    dir.applyAxisAngle(axis, -this.pitch)
    this.freeOffset.copy(dir).multiplyScalar(dist)
    this.camera.position.copy(p.position).add(this.freeOffset)
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
    const shots: [number, number, number][] = [
      [L * 0.9 + t * 0.4, L * 0.12, -L * 0.6 + t * 1.2],
      [-L * 0.7, L * 0.35, L * 1.4 - t * 0.6],
      [L * 0.15, L * 1.6 + t * 0.2, L * 0.4],
      [-L * 1.1, -L * 0.05, -L * 0.25],
      [L * 0.35, L * 0.08, L * 1.0 + t * 0.3],
    ]
    const [rx, ry, rb] = shots[this.cineShot]
    const flatFwd = _v.copy(_fwd).sub(_up.clone().multiplyScalar(_fwd.dot(_up))).normalize()
    if (!this.initialized) this.smoothedFwd.copy(flatFwd)
    else this.smoothedFwd.lerp(flatFwd, 1 - Math.exp(-dt * 1.2)).normalize()
    _right.copy(this.smoothedFwd).cross(_up).normalize()
    const desired = _target.copy(p.position).addScaledVector(_right, rx).addScaledVector(_up, ry).addScaledVector(this.smoothedFwd, -rb)
    if (!this.initialized) {
      this.smoothedPos.copy(desired)
      this.initialized = true
    } else this.smoothedPos.lerp(desired, 1 - Math.exp(-dt * 3))
    this.camera.position.copy(this.smoothedPos)
    this.camera.up.copy(_up)
    this.camera.lookAt(p.position)
  }

  private flybyView(p: AircraftPose) {
    this.initialized = false
    const speed = p.velocity.length()
    const needNew = () => {
      if (!this.flybyEcef) return true
      const w = frame.ecefToWorld(this.flybyEcef.x, this.flybyEcef.y, this.flybyEcef.z, _v)
      const rel = w.sub(p.position)
      const ahead = rel.dot(p.velocity.lengthSq() > 1 ? p.velocity.clone().normalize() : _fwd)
      return ahead < -Math.max(120, speed * 3) || rel.length() > 4000
    }
    if (needNew()) {
      const dir = speed > 3 ? p.velocity.clone().normalize() : _fwd.clone()
      _right.copy(dir).cross(_up).normalize()
      const lead = Math.max(150, speed * 7)
      const pos = p.position.clone().addScaledVector(dir, lead).addScaledVector(_right, p.span * 0.9 + 15).addScaledVector(_up, p.length * 0.25 + 4)
      this.flybyEcef = frame.worldToEcef(pos, new Vector3())
    }
    const fe = this.flybyEcef!
    frame.ecefToWorld(fe.x, fe.y, fe.z, this.camera.position)
    this.camera.up.copy(_up)
    this.camera.lookAt(p.position)
  }
}
