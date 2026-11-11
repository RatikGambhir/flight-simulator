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
  ShaderMaterial,
  Vector3,
  WebGLRenderTarget,
  type Material,
  type WebGLRenderer,
} from 'three'
import type { RenderState } from '../sim/simClient'
import { S } from '../sim/protocol'
import { BODY_FROM_MODEL, frame, geodeticToEcef } from '../world/frame'
import { buildCockpit, type Cockpit } from './cockpit'
import { CockpitLighting } from './cockpitLighting'
import { buildAircraft, type AircraftModel, type LampKind } from './models'
import type { Lamp } from '../scene/NightEffect'
import { setHingeAngle } from './geometry'

export const LIGHTING_MASK_LAYER = 10

const _v = new Vector3()
const _up = new Vector3()
const _e = new Vector3()
const _n = new Vector3()
const _a = new Vector3()
const _b = new Vector3()
const _c = new Vector3()

// Ground shadow: the silhouette blurred by a penumbra that widens with height,
// as the sun's half-degree disc does to a real aircraft's shadow.
const SHADOW_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`

const SHADOW_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D silhouette;
uniform float opacity;
uniform float radius;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  // 16 taps on a golden-angle spiral.
  float a = 0.0;
  for (int i = 0; i < 16; i++) {
    float f = (float(i) + 0.5) / 16.0;
    float t = float(i) * 2.39996323;
    a += texture2D(silhouette, vUv + vec2(cos(t), sin(t)) * sqrt(f) * radius).g;
  }
  a /= 16.0;
  // Fade to nothing at the quad's edge so a wide penumbra never shows a hard border.
  vec2 e = smoothstep(vec2(0.0), vec2(0.04), vUv) * smoothstep(vec2(0.0), vec2(0.04), 1.0 - vUv);
  gl_FragColor = vec4(0.0, 0.0, 0.0, a * opacity * e.x * e.y);
}`

/** Padding around the silhouette so the blurred edge stays inside the quad. */
const SHADOW_PAD = 1.5

/** Glow colour, core radiance and halo size (metres) for each kind of lamp. */
const LAMP_COLOR: Record<LampKind, string> = { navRed: '#ff2218', navGreen: '#18ff5a', navWhite: '#ffffff', strobe: '#eef4ff', beacon: '#ff1a10', landing: '#fff6e4' }
const LAMP_POWER: Record<LampKind, number> = { navRed: 0.07, navGreen: 0.05, navWhite: 0.04, strobe: 0.3, beacon: 0.14, landing: 0.28 }
const LAMP_SIZE: Record<LampKind, number> = { navRed: 1, navGreen: 1, navWhite: 0.8, strobe: 2, beacon: 1.5, landing: 2.2 }
const CABIN_GLOW = 1.3
const LOGO_LIGHT = 1.2

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
  /** Lamps in world space with this frame's brightness, for the night glow pass. */
  readonly lamps: Lamp[]
  private night = 0
  private readonly cockpitLighting: CockpitLighting

  constructor(
    readonly id: string,
    renderer: WebGLRenderer,
  ) {
    this.model = buildAircraft(id, LIGHTING_MASK_LAYER)
    this.lamps = this.model.lamps.map((l) => ({ position: new Vector3(), color: new Color(LAMP_COLOR[l.kind]), intensity: 0, size: LAMP_SIZE[l.kind] }))
    this.cockpit = buildCockpit(this.model)
    this.cockpitLighting = new CockpitLighting(this.cockpit.root)
    this.cockpit.root.visible = false
    this.model.root.add(this.cockpit.root)
    this.container.add(this.model.root)
    this.shadowTarget = this.renderSilhouette(renderer)
    const mat = new ShaderMaterial({
      vertexShader: SHADOW_VERT,
      fragmentShader: SHADOW_FRAG,
      uniforms: { silhouette: { value: this.shadowTarget.texture }, opacity: { value: 0.5 }, radius: { value: 0.002 } },
      transparent: true,
      depthWrite: false,
    })
    const size = Math.max(this.model.span, this.model.length) * SHADOW_PAD
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
    const size = Math.max(this.model.span, this.model.length) * SHADOW_PAD
    const rt = new WebGLRenderTarget(1024, 1024, { samples: 4, depthBuffer: true })
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
    if (sunDirWorld) {
      frame.enuInWorld(s[S.LAT], s[S.LON], _e, _n, _up)
      this.night = Math.min(1, Math.max(0, (-sunDirWorld.dot(_up) - 0.02) / 0.16))
    }
    this.updateLamps(s)
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
      setHingeAngle(sfc.pivot, sfc.restQuaternion, theta)
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

  /** Navigation, anti-collision and landing lamps, plus the lit cabin and logo lights. */
  private updateLamps(s: Float64Array) {
    const m = this.model
    const night = this.night
    const t = this.time % 1.2
    const strobe = t < 0.06 || (t > 0.14 && t < 0.2)
    const beacon = (this.time + 0.5) % 1.0 < 0.1
    // Landing lights: on with the gear down, or below about 5,000 ft above the ground.
    const landing = s[S.GEAR] > 0.5 || s[S.AGL_FT] < 5000
    const outside = this.interiorVisible ? 0 : 1
    for (let i = 0; i < m.lamps.length; i++) {
      const src = m.lamps[i]
      const lamp = this.lamps[i]
      lamp.position.copy(src.at).applyQuaternion(this.quaternion).add(this.position)
      let on = 1
      if (src.kind === 'strobe') on = strobe ? 1 : 0
      else if (src.kind === 'beacon') on = beacon ? 1 : 0
      else if (src.kind === 'landing') on = landing ? 1 : 0
      // By day the lamps are just visible; at night they carry the aircraft.
      lamp.intensity = on * outside * LAMP_POWER[src.kind] * (0.04 + 0.96 * night)
    }
    m.materials.fuselage.emissiveIntensity = night * CABIN_GLOW
    this.cockpitLighting.update(night)
    for (const l of m.logoLights) l.intensity = night * LOGO_LIGHT
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
    const height = _a.copy(this.position).sub(sh.position).dot(_up)
    const horiz = _b.copy(sun).addScaledVector(_up, -elev)
    sh.position.addScaledVector(horiz, -height / elev)
    // Orient: plane normal = up, texture "up" (−z of the silhouette camera) = aircraft forward.
    const fwd = _a.set(0, 0, -1).applyQuaternion(this.quaternion)
    fwd.addScaledVector(_up, -fwd.dot(_up)).normalize()
    const right = _c.copy(fwd).cross(_up).normalize()
    // Basis: x = right, y = forward (texture up), z = up (normal).
    const m = sh.matrix
    m.makeBasis(right, fwd, _up)
    sh.quaternion.setFromRotationMatrix(m)
    const fade = Math.max(0, 1 - agl / 250)
    const u = (sh.material as ShaderMaterial).uniforms
    u.opacity.value = 0.62 * fade * Math.min(1, elev * 4)
    // Penumbra width = slant distance to the ground x the sun's angular radius (~0.27 deg),
    // in UV units of the shadow quad; a small floor hides texel stair-stepping.
    const quad = Math.max(this.model.span, this.model.length) * SHADOW_PAD
    u.radius.value = Math.min(0.12, 0.0012 + ((Math.max(0, height) / elev) * 0.0047) / quad)
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
