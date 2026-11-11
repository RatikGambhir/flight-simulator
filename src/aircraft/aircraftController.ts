// Places and animates the aircraft each frame from the interpolated sim state.

import {
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  Vector3,
  WebGLRenderTarget,
  type Material,
  type WebGLRenderer,
} from 'three'
import type { RenderState } from '../sim/simClient'
import { S } from '../sim/protocol'
import { BODY_FROM_MODEL, frame, geodeticToEcef } from '../world/frame'
import { buildCockpit, type Cockpit } from './cockpit'
import { buildAircraft, type AircraftModel } from './models'

export const LIGHTING_MASK_LAYER = 10

const _v = new Vector3()
const _up = new Vector3()
const _e = new Vector3()
const _n = new Vector3()

export class AircraftController {
  readonly container = new Group()
  readonly model: AircraftModel
  readonly cockpit: Cockpit
  private shadow: Mesh
  private shadowTarget: WebGLRenderTarget
  private time = 0
  /** World position and orientation of the aircraft this frame. */
  readonly position = new Vector3()
  readonly quaternion = new Quaternion()
  interiorVisible = false

  constructor(
    readonly id: string,
    renderer: WebGLRenderer,
  ) {
    this.model = buildAircraft(id, LIGHTING_MASK_LAYER)
    this.cockpit = buildCockpit(this.model)
    this.cockpit.root.visible = false
    this.model.root.add(this.cockpit.root)
    this.container.add(this.model.root)
    this.shadowTarget = this.renderSilhouette(renderer)
    const mat = new MeshBasicMaterial({ color: new Color('#000000'), alphaMap: this.shadowTarget.texture, transparent: true, opacity: 0.5, depthWrite: false })
    const size = Math.max(this.model.span, this.model.length) * 1.15
    this.shadow = new Mesh(new PlaneGeometry(size, size), mat)
    this.shadow.renderOrder = 2
    this.shadow.frustumCulled = false
  }

  /** Adds the ground shadow to the scene (it lives in world space, not under the aircraft). */
  attachShadow(scene: Scene) {
    scene.add(this.shadow)
  }

  detachShadow(scene: Scene) {
    scene.remove(this.shadow)
  }

  /** Renders a top-down silhouette of the exterior into a small texture for the ground shadow. */
  private renderSilhouette(renderer: WebGLRenderer) {
    const size = Math.max(this.model.span, this.model.length) * 1.15
    const rt = new WebGLRenderTarget(256, 256)
    const cam = new OrthographicCamera(-size / 2, size / 2, size / 2, -size / 2, 0.1, 100)
    cam.position.set(0, 50, 0)
    cam.lookAt(0, 0, 0)
    cam.up.set(0, 0, -1)
    cam.lookAt(0, 0, 0)
    cam.layers.enableAll()
    const scene = new Scene()
    scene.background = new Color('#000')
    const clone = this.model.root.clone(true)
    const white = new MeshBasicMaterial({ color: '#ffffff' })
    clone.traverse((o) => {
      const m = o as Mesh
      if (m.isMesh) m.material = white
    })
    const cockpit = clone.getObjectByName('cockpit')
    if (cockpit) cockpit.visible = false
    scene.add(clone)
    const prev = renderer.getRenderTarget()
    renderer.setRenderTarget(rt)
    renderer.render(scene, cam)
    renderer.setRenderTarget(prev)
    white.dispose()
    return rt
  }

  setInteriorView(inside: boolean) {
    this.interiorVisible = inside
    this.cockpit.root.visible = inside
    for (const o of this.model.exteriorOnly) o.visible = !inside
  }

  update(r: RenderState, dt: number, sunDirWorld: Vector3 | null) {
    this.time += dt
    const s = r.latest
    frame.ecefToWorld(r.x, r.y, r.z, this.position)
    this.quaternion.copy(frame.worldFromEcefRot).multiply(r.quat).multiply(BODY_FROM_MODEL)
    this.container.position.copy(this.position)
    this.container.quaternion.copy(this.quaternion)
    this.animate(r, dt)
    if (this.interiorVisible) {
      this.cockpit.update(s, { pitch: r.elevator, roll: r.aileron, throttle: s[S.THROTTLE] })
    }
    this.updateShadow(s, sunDirWorld)
  }

  private animate(r: RenderState, dt: number) {
    const m = this.model
    for (const sfc of m.surfaces) {
      let theta = 0
      switch (sfc.kind) {
        case 'aileron':
          theta = -r.aileron * sfc.max
          break
        case 'elevator':
          theta = -r.elevator * sfc.max * sfc.sign
          break
        case 'rudder':
          theta = r.rudder * sfc.max
          break
        case 'flap':
          theta = r.flaps * sfc.max * sfc.sign
          break
        case 'spoiler':
          theta = r.spoilers * sfc.max * sfc.sign
          break
      }
      sfc.pivot.rotation.x = theta
    }
    for (const g of m.gear) {
      const a = (1 - r.gear) * g.retracted
      if (g.axis === 'x') g.pivot.rotation.x = a
      else g.pivot.rotation.z = a
      g.pivot.visible = r.gear > 0.02
    }
    for (const sp of m.spinners) {
      const rate = sp.speed * (0.12 + 0.88 * r.engine)
      sp.obj.rotation.z += rate * dt
      if (sp.blurAbove !== undefined && sp.blades && sp.disc) {
        const blur = r.engine > sp.blurAbove
        sp.disc.visible = r.engine > 0.05
        sp.blades.visible = !blur
      }
    }
    const strobeOn = this.time % 1.2 < 0.06 || (this.time % 1.2 > 0.14 && this.time % 1.2 < 0.2)
    for (const st of m.strobes) st.visible = strobeOn
    const beaconOn = (this.time + 0.5) % 1.0 < 0.1
    for (const b of m.beacons) b.visible = beaconOn
  }

  private updateShadow(s: Float64Array, sun: Vector3 | null) {
    const agl = s[S.AGL_FT] * 0.3048
    const sh = this.shadow
    if (!sun || this.interiorVisible || agl > 250) {
      sh.visible = false
      return
    }
    frame.enuInWorld(s[S.LAT], s[S.LON], _e, _n, _up)
    const elev = sun.dot(_up)
    if (elev < 0.08) {
      sh.visible = false
      return
    }
    sh.visible = true
    // Ground point under the aircraft (ground height from the sim, lifted slightly).
    geodeticToEcef(s[S.LAT], s[S.LON], s[S.GROUND_HEIGHT] + 0.25, _v)
    frame.ecefToWorld(_v.x, _v.y, _v.z, sh.position)
    // Project along the sun direction onto the ground plane.
    const height = this.position.clone().sub(sh.position).dot(_up)
    const horiz = sun.clone().sub(_up.clone().multiplyScalar(elev))
    sh.position.addScaledVector(horiz, -height / elev)
    // Orient: plane normal = up, texture "up" (−z of the silhouette camera) = aircraft forward.
    const fwd = new Vector3(0, 0, -1).applyQuaternion(this.quaternion)
    fwd.sub(_up.clone().multiplyScalar(fwd.dot(_up))).normalize()
    const right = fwd.clone().cross(_up).normalize()
    // Basis: x = right, y = forward (texture up), z = up (normal).
    const m = sh.matrix
    m.makeBasis(right, fwd, _up)
    sh.quaternion.setFromRotationMatrix(m)
    const fade = Math.max(0, 1 - agl / 250)
    ;(sh.material as MeshBasicMaterial).opacity = 0.55 * fade * Math.min(1, elev * 4)
  }

  dispose() {
    this.shadowTarget.dispose()
    this.cockpit.dispose()
    this.container.traverse((o) => {
      const m = o as Mesh
      if (m.isMesh) {
        m.geometry.dispose()
        const mat = m.material as Material | Material[]
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
        else mat.dispose()
      }
    })
    this.shadow.geometry.dispose()
    ;(this.shadow.material as Material).dispose()
  }
}
