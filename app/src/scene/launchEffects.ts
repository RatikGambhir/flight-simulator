import { Pass } from 'postprocessing'
import {
  AdditiveBlending, Color, CylinderGeometry, type Camera, DataTexture, InstancedBufferAttribute, InstancedBufferGeometry,
  LinearMipmapLinearFilter, Mesh, NormalBlending, Object3D, type PerspectiveCamera, PlaneGeometry, PointLight, RedFormat, Scene,
  ShaderMaterial, type Texture, type WebGLRenderer, type WebGLRenderTarget, Vector3,
} from 'three'
import { S } from '../sim/protocol'
import { frame } from '../world/frame'

/*
 * Rocket exhaust for the Endeavour launch: shader plumes, a lit smoke column and
 * the pad exhaust cloud. Everything here is emissive or self-lit and is drawn
 * after aerial perspective, so the atmosphere pass cannot relight it as terrain.
 * Depth comes from the composer's (logarithmic) depth texture: it hides the
 * effects behind the stack, terrain and tower and softens their intersections.
 */

const DEPTH_GLSL = /* glsl */ `
  uniform sampler2D uDepth;
  uniform float uHasDepth;
  uniform float uLogFar;
  // Distance along the view axis of the opaque scene at this pixel.
  float sceneViewDepth() {
    if (uHasDepth < 0.5) return 1e9;
    float d = texelFetch(uDepth, ivec2(gl_FragCoord.xy), 0).r;
    if (d >= 1.0) return 1e9;
    return exp2(d * uLogFar) - 1.0;
  }`

const NOISE_GLSL = /* glsl */ `
  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  float vnoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }`

/* ------------------------------------------------------------------ plumes */

const PLUME_VERTEX = /* glsl */ `
  uniform float uTime, uLength, uRadius0, uRadius1, uSeed;
  varying float vT;
  varying float vFacing;
  varying float vViewDepth;
  varying vec2 vCircle;
  void main() {
    float t = position.y + 0.5;           // 0 at the nozzle exit, 1 at the tail
    vec2 c = normalize(position.xz);
    // Fast initial expansion, then a slow widening with a little shimmer.
    float r = mix(uRadius0, uRadius1, pow(t, 0.55));
    r *= 1.0 + 0.05 * sin(uTime * 37.0 + t * 23.0 + uSeed) + 0.03 * sin(uTime * 61.0 - t * 41.0);
    vec3 p = vec3(c.x * r, c.y * r, t * uLength);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vec3 n = normalize(normalMatrix * vec3(c, -(uRadius1 - uRadius0) / uLength));
    vFacing = abs(dot(n, normalize(-mv.xyz)));
    vViewDepth = -mv.z;
    vT = t;
    vCircle = c;
    gl_Position = projectionMatrix * mv;
  }`

const PLUME_FRAGMENT = /* glsl */ `
  ${DEPTH_GLSL}
  ${NOISE_GLSL}
  uniform float uTime, uLength, uIntensity, uFlow, uDiamond, uDiamondMix, uSeed, uSoft, uFade;
  uniform vec3 uCore, uMid, uTail;
  varying float vT;
  varying float vFacing;
  varying float vViewDepth;
  varying vec2 vCircle;
  void main() {
    float t = vT;
    float axial = smoothstep(0.0, 0.04, t) * pow(1.0 - t, uFade);
    float body = pow(vFacing, 2.2);
    vec3 q = vec3(vCircle * 1.6, t * uLength * 0.11 - uTime * uFlow + uSeed);
    float n = vnoise(q * 1.7) * 0.6 + vnoise(q * 4.3 + 7.0) * 0.4;
    float turb = mix(1.0, 0.35 + 1.25 * n, smoothstep(0.03, 0.45, t));
    float diamonds = 1.0;
    if (uDiamond > 0.0) {
      float k = 0.5 + 0.5 * cos(t * uLength / uDiamond * 6.2831853);
      diamonds = mix(1.0, 0.45 + 1.6 * pow(k, 10.0) * (1.0 - t), uDiamondMix);
    }
    vec3 color = t < 0.35 ? mix(uCore, uMid, t / 0.35) : mix(uMid, uTail, (t - 0.35) / 0.65);
    float a = axial * body * turb * diamonds * uIntensity;
    float soft = clamp((sceneViewDepth() - vViewDepth) / uSoft, 0.0, 1.0);
    gl_FragColor = vec4(color * a * soft, 1.0);
  }`

interface PlumeSpec { anchor: string; length: number; r0: number; r1: number; intensity: number; flow: number; diamond: number; fade: number; core: string; mid: string; tail: string }

const SRB_CORE = { length: 44, r0: 1.6, r1: 3.1, intensity: 9, flow: 2.6, diamond: 0, fade: 1.25, core: '#fff6e0', mid: '#ffc46a', tail: '#ff7a24' }
const SRB_OUTER = { length: 70, r0: 2.0, r1: 7.0, intensity: 1.1, flow: 1.6, diamond: 0, fade: 1.6, core: '#ffe2a8', mid: '#ff9a3c', tail: '#c8501c' }
const SSME_CORE = { length: 22, r0: 1.05, r1: 1.55, intensity: 1.6, flow: 3.2, diamond: 3.4, fade: 1.2, core: '#d9e6ff', mid: '#9fb6ff', tail: '#ff9e70' }
const SSME_GLOW = { length: 34, r0: 1.15, r1: 3.6, intensity: 0.25, flow: 2.0, diamond: 0, fade: 1.8, core: '#c6d4ff', mid: '#8a9cff', tail: '#5a3c9a' }
const OMS = { length: 7, r0: 0.3, r1: 1.2, intensity: 0.7, flow: 2.5, diamond: 0, fade: 1.4, core: '#d6e2ff', mid: '#8ca3ff', tail: '#5c4aa8' }

class Plume {
  readonly mesh: Mesh<CylinderGeometry, ShaderMaterial>
  constructor(readonly spec: PlumeSpec, geometry: CylinderGeometry, depth: Record<string, { value: unknown }>, seed: number) {
    const material = new ShaderMaterial({
      vertexShader: PLUME_VERTEX, fragmentShader: PLUME_FRAGMENT,
      uniforms: {
        ...depth, uTime: { value: 0 }, uSeed: { value: seed }, uLength: { value: spec.length }, uRadius0: { value: spec.r0 }, uRadius1: { value: spec.r1 },
        uIntensity: { value: spec.intensity }, uFlow: { value: spec.flow }, uDiamond: { value: spec.diamond }, uDiamondMix: { value: 1 }, uFade: { value: spec.fade }, uSoft: { value: 3 },
        uCore: { value: new Color(spec.core) }, uMid: { value: new Color(spec.mid) }, uTail: { value: new Color(spec.tail) },
      },
      transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending, side: 2,
    })
    this.mesh = new Mesh(geometry, material)
    this.mesh.matrixAutoUpdate = false
    this.mesh.frustumCulled = false
    this.mesh.name = `plume ${spec.anchor}`
    // Drawn after the smoke so the flame glows through the column it feeds.
    this.mesh.renderOrder = 2
  }
}

/* ------------------------------------------------------------------ smoke */

const SMOKE_VERTEX = /* glsl */ `
  attribute vec3 iPos;
  attribute vec4 iData;   // radius, opacity, seed, plume glow
  attribute vec2 iShade;  // erosion, warmth
  attribute vec3 iAxis;   // world direction from the column's centre line
  uniform float uTime;
  varying vec2 vUv;
  varying vec2 vTex;
  varying vec4 vData;
  varying vec2 vShade;
  varying float vViewDepth;
  varying vec3 vAxis;
  varying vec2 vSpin;
  void main() {
    vAxis = (viewMatrix * vec4(iAxis, 0.0)).xyz;
    vec4 mv = viewMatrix * vec4(iPos, 1.0);
    vec2 corner = position.xy * 2.0;
    float a = iData.z * 6.2831853 + uTime * 0.03 * (iData.z - 0.5);
    vec2 rot = mat2(cos(a), sin(a), -sin(a), cos(a)) * corner;
    vSpin = vec2(cos(a), sin(a));
    mv.xy += corner * iData.x * 1.2;
    float tile = floor(fract(iData.z * 7.31) * 4.0);
    vTex = (clamp(rot, -1.0, 1.0) * 0.5 + 0.5) * 0.5 + vec2(mod(tile, 2.0), floor(tile * 0.5)) * 0.5;
    vUv = corner;
    vData = iData;
    vShade = iShade;
    vViewDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`

const SMOKE_FRAGMENT = /* glsl */ `
  ${DEPTH_GLSL}
  uniform sampler2D uPuff;
  uniform vec3 uSunView, uSunColor, uAmbient, uGlow, uHaze;
  uniform float uHazeDistance;
  varying vec2 vUv;
  varying vec2 vTex;
  varying vec4 vData;
  varying vec2 vShade;
  varying float vViewDepth;
  varying vec3 vAxis;
  varying vec2 vSpin;
  void main() {
    float r2 = dot(vUv, vUv);
    if (r2 > 1.0) discard;
    float d = texture2D(uPuff, vTex).r * smoothstep(1.0, 0.55, sqrt(r2));
    float erosion = vShade.x;
    float alpha = smoothstep(erosion, erosion + 0.42, d) * vData.y;
    float soft = clamp((sceneViewDepth() - vViewDepth) / max(2.0, vData.x * 0.6), 0.0, 1.0);
    alpha *= soft * smoothstep(0.5, 1.0 + vData.x * 0.5, vViewDepth);
    if (alpha < 0.003) discard;
    // Billowed sphere normal, bumped by the density gradient. Central differences
    // on a blurred mip stay smooth when a puff is magnified across the screen.
    const float e = 2.5 / 256.0;
    vec2 g = vec2(textureLod(uPuff, vTex + vec2(e, 0.0), 1.5).r - textureLod(uPuff, vTex - vec2(e, 0.0), 1.5).r,
      textureLod(uPuff, vTex + vec2(0.0, e), 1.5).r - textureLod(uPuff, vTex - vec2(0.0, e), 1.5).r);
    vec2 grad = vec2(vSpin.x * g.x + vSpin.y * g.y, -vSpin.y * g.x + vSpin.x * g.y) * 2.2;
    vec3 n = normalize(vec3(vUv * 0.85 - grad, sqrt(max(0.04, 1.0 - r2))));
    float ndl = dot(n, uSunView);
    float diffuse = clamp(ndl * 0.6 + 0.4, 0.0, 1.0) * (0.55 + 0.45 * d);
    // Puffs on the far side of the column from the sun sit in its shadow.
    float facing = dot(normalize(vAxis + n * 0.35), uSunView);
    diffuse *= mix(0.3, 1.0, smoothstep(-0.65, 0.55, facing));
    float silver = pow(max(0.0, -uSunView.z), 5.0) * (1.0 - d) * 1.4;
    vec3 albedo = mix(vec3(0.82, 0.82, 0.8), vec3(0.95, 0.86, 0.74), vShade.y);
    vec3 color = albedo * (uSunColor * (diffuse + silver) + uAmbient * (0.6 + 0.4 * n.y));
    // Firelight from the plume on the underside and inside of the column.
    color += uGlow * vData.w * (0.55 + 0.45 * d) * (0.7 - 0.3 * n.y);
    float haze = 1.0 - exp(-vViewDepth / uHazeDistance);
    color = mix(color, uHaze, haze * 0.85);
    gl_FragColor = vec4(color, alpha * (1.0 - haze * 0.4));
  }`

/** Four 128 px soft fractal puffs in a 2x2 atlas, red channel density. */
function puffAtlas() {
  const size = 256, tile = 128
  const data = new Uint8Array(size * size)
  const lattice = new Float32Array(64 * 64)
  let seed = 11
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand()
  const smooth = (t: number) => t * t * (3 - 2 * t)
  const noise = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = smooth(x - xi), yf = smooth(y - yi)
    const v = (i: number, j: number) => lattice[((j & 63) << 6) | (i & 63)]
    return (v(xi, yi) * (1 - xf) + v(xi + 1, yi) * xf) * (1 - yf) + (v(xi, yi + 1) * (1 - xf) + v(xi + 1, yi + 1) * xf) * yf
  }
  for (let t = 0; t < 4; t++) {
    const ox = (t % 2) * tile, oy = Math.floor(t / 2) * tile, shift = t * 17.3
    for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) {
      const u = (x + 0.5) / tile * 2 - 1, v = (y + 0.5) / tile * 2 - 1
      let f = 0, amp = 0.6, freq = 1.6
      for (let o = 0; o < 3; o++) { f += noise(u * freq + shift, v * freq + shift * 0.7) * amp; amp *= 0.5; freq *= 2.03 }
      const r = Math.hypot(u, v)
      const falloff = Math.max(0, 1 - r * r * (1.0 + 1.1 * (0.5 - f)))
      data[(oy + y) * size + ox + x] = Math.round(Math.min(1, Math.max(0, falloff * (0.25 + f * 1.25))) * 255)
    }
  }
  const texture = new DataTexture(data, size, size, RedFormat)
  texture.generateMipmaps = true
  texture.minFilter = LinearMipmapLinearFilter
  texture.needsUpdate = true
  return texture
}

const CAPACITY = 4096
interface Emitter { anchor: Object3D | null; last: Vector3 | null }
type Kind = 0 | 1 // 0: trail behind the vehicle, 1: pad exhaust and steam cloud

class Smoke {
  readonly px = new Float64Array(CAPACITY); readonly py = new Float64Array(CAPACITY); readonly pz = new Float64Array(CAPACITY)
  readonly vx = new Float32Array(CAPACITY); readonly vy = new Float32Array(CAPACITY); readonly vz = new Float32Array(CAPACITY)
  readonly age = new Float32Array(CAPACITY); readonly life = new Float32Array(CAPACITY).fill(-1)
  readonly r0 = new Float32Array(CAPACITY); readonly rMax = new Float32Array(CAPACITY); readonly tau = new Float32Array(CAPACITY)
  readonly seed = new Float32Array(CAPACITY); readonly opacity = new Float32Array(CAPACITY); readonly kind = new Uint8Array(CAPACITY)
  readonly drag = new Float32Array(CAPACITY)
  readonly ax = new Float32Array(CAPACITY); readonly ay = new Float32Array(CAPACITY); readonly az = new Float32Array(CAPACITY)
  /** Indices of live puffs, so per-frame work scales with the smoke, not the capacity. */
  readonly live = new Uint16Array(CAPACITY)
  count = 0
  private head = 0

  clear() { this.life.fill(-1); this.count = 0 }

  spawn(kind: Kind, p: Vector3, v: Vector3, axis: Vector3, r0: number, rMax: number, tau: number, life: number, opacity: number, drag: number) {
    // A full buffer recycles its oldest puff, which is already in the live list.
    const i = this.head; this.head = (this.head + 1) % CAPACITY
    if (this.life[i] < 0) this.live[this.count++] = i
    const size = 0.7 + Math.random() * 0.7
    r0 *= size; rMax *= size
    this.ax[i] = axis.x; this.ay[i] = axis.y; this.az[i] = axis.z
    this.px[i] = p.x; this.py[i] = p.y; this.pz[i] = p.z
    this.vx[i] = v.x; this.vy[i] = v.y; this.vz[i] = v.z
    this.age[i] = 0; this.life[i] = life; this.r0[i] = r0; this.rMax[i] = rMax; this.tau[i] = tau
    this.seed[i] = Math.random(); this.opacity[i] = opacity; this.kind[i] = kind; this.drag[i] = drag
  }

  radius(i: number) {
    const a = this.age[i]
    return this.r0[i] + (this.rMax[i] - this.r0[i]) * (1 - Math.exp(-a / this.tau[i])) + a * 0.12
  }
}

const FIRE_GLOW = new Color('#ff9a4a')
const PAD_GLOW = new Color('#ff8a3a')

/** Composer pass that draws the launch effects over the lit, hazed image. */
export class LaunchFxPass extends Pass {
  constructor(private readonly fx: LaunchEffects, private readonly view: Camera) {
    super('LaunchFxPass')
    this.needsSwap = false
    this.needsDepthTexture = true
  }

  override setDepthTexture(depthTexture: Texture) {
    this.fx.setDepth(depthTexture)
  }

  override render(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget | null) {
    if (!this.fx.active && !this.fx.alwaysRender) return
    const autoClear = renderer.autoClear
    renderer.autoClear = false
    renderer.setRenderTarget(this.renderToScreen ? null : inputBuffer)
    this.fx.prepare(this.view as PerspectiveCamera)
    renderer.render(this.fx.scene, this.view)
    renderer.autoClear = autoClear
  }
}

export interface LaunchFrame {
  s: Float64Array
  generation: number
  /** Unit vector to the sun in world space and its transmitted irradiance. */
  sun: Vector3
  sunColor: Color
  /** Sky irradiance on an upward-facing surface. */
  ambient: Color
  /** Pad location (ECEF), its local up and east (ECEF unit vectors). */
  pad: Vector3
  padUp: Vector3
  padEast: Vector3
  padNorth: Vector3
  /** Ground-relative vehicle velocity, ECEF metres per second. */
  velocity: Vector3
  /** Wind the smoke drifts with, ECEF metres per second at the surface. */
  wind: Vector3
}

const _a = new Vector3(), _b = new Vector3(), _c = new Vector3(), _d = new Vector3(), _e = new Vector3(), _v = new Vector3(), _axis = new Vector3()

export class LaunchEffects {
  readonly scene = new Scene()
  /** Firelight on the stack, tower and pad. Add it to the lit scene. */
  readonly light = new PointLight('#ffb070', 0, 0, 2)
  active = false
  /** Draw the pass even without exhaust, for other overlays added to `scene`. */
  alwaysRender = false
  /** Composer depth for overlays added to `scene`: shared by every material that spreads it. */
  readonly depth = { uDepth: { value: null as Texture | null }, uHasDepth: { value: 0 }, uLogFar: { value: 1 } }
  private readonly plumes: { plume: Plume; anchor: Object3D; group: 'srb' | 'ssme' | 'oms' }[] = []
  private readonly smoke = new Smoke()
  private readonly smokeMesh: Mesh<InstancedBufferGeometry, ShaderMaterial>
  private readonly glow: Mesh<PlaneGeometry, ShaderMaterial>
  private readonly iPos: InstancedBufferAttribute
  private readonly iData: InstancedBufferAttribute
  private readonly iShade: InstancedBufferAttribute
  private readonly iAxis: InstancedBufferAttribute
  private readonly order = new Uint16Array(CAPACITY)
  private drawn = 0
  private readonly keys = new Float32Array(CAPACITY)
  private readonly wx = new Float32Array(CAPACITY)
  private readonly wy = new Float32Array(CAPACITY)
  private readonly wz = new Float32Array(CAPACITY)
  private readonly seen = new Uint32Array(CAPACITY)
  private stamp = 0
  private readonly instanceAttributes: [InstancedBufferAttribute, number][]
  private readonly anchors: Object3D[] = []
  private readonly anchorParents: Object3D[] = []
  private readonly emitters: Emitter[]
  /** One merged column once the two booster plumes have combined. */
  private readonly column: Emitter = { anchor: null, last: null }
  private readonly columnOnly = [this.column]
  private readonly mainAnchor: Object3D | null
  private lastTime = -1
  private generation = -1
  private padCarry = 0
  private thrust = { srb: 0, ssme: 0, oms: 0 }
  private readonly nozzle = new Vector3()
  private readonly exhaust = new Vector3()
  private time = 0

  constructor(private readonly model: Object3D) {
    const geometry = new CylinderGeometry(1, 1, 1, 40, 28, true)
    let seed = 1
    const add = (anchor: string, spec: Omit<PlumeSpec, 'anchor'>, group: 'srb' | 'ssme' | 'oms') => {
      const node = model.getObjectByName(anchor)
      if (!node) return
      const plume = new Plume({ ...spec, anchor }, geometry, this.depth, seed++ * 13.7)
      this.scene.add(plume.mesh)
      this.plumes.push({ plume, anchor: node, group })
    }
    for (const i of [0, 1]) { add(`plume-srb-${i}`, SRB_OUTER, 'srb'); add(`plume-srb-${i}`, SRB_CORE, 'srb') }
    for (const i of [0, 1, 2]) { add(`plume-ssme-${i}`, SSME_GLOW, 'ssme'); add(`plume-ssme-${i}`, SSME_CORE, 'ssme') }
    for (const i of [0, 1]) add(`plume-oms-${i}`, OMS, 'oms')
    this.emitters = [0, 1].map((i) => ({ anchor: model.getObjectByName(`plume-srb-${i}`) ?? null, last: null }))
    this.mainAnchor = model.getObjectByName('plume-ssme-0') ?? null
    for (const { anchor } of this.plumes) if (!this.anchors.includes(anchor)) this.anchors.push(anchor)
    for (const anchor of this.anchors) if (anchor.parent && anchor.parent !== model && !this.anchorParents.includes(anchor.parent)) this.anchorParents.push(anchor.parent)

    const quad = new PlaneGeometry(1, 1)
    const smokeGeometry = new InstancedBufferGeometry()
    smokeGeometry.index = quad.index
    smokeGeometry.setAttribute('position', quad.attributes.position)
    this.iPos = new InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3).setUsage(35048)
    this.iData = new InstancedBufferAttribute(new Float32Array(CAPACITY * 4), 4).setUsage(35048)
    this.iShade = new InstancedBufferAttribute(new Float32Array(CAPACITY * 2), 2).setUsage(35048)
    smokeGeometry.setAttribute('iPos', this.iPos)
    smokeGeometry.setAttribute('iData', this.iData)
    smokeGeometry.setAttribute('iShade', this.iShade)
    this.iAxis = new InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3).setUsage(35048)
    smokeGeometry.setAttribute('iAxis', this.iAxis)
    this.instanceAttributes = [[this.iPos, 3], [this.iData, 4], [this.iShade, 2], [this.iAxis, 3]]
    smokeGeometry.instanceCount = 0
    this.smokeMesh = new Mesh(smokeGeometry, new ShaderMaterial({
      vertexShader: SMOKE_VERTEX, fragmentShader: SMOKE_FRAGMENT,
      uniforms: {
        ...this.depth, uPuff: { value: puffAtlas() }, uTime: { value: 0 },
        uSunView: { value: new Vector3() }, uSunColor: { value: new Color() }, uAmbient: { value: new Color() },
        uGlow: { value: new Color() }, uHaze: { value: new Color() }, uHazeDistance: { value: 40000 },
      },
      transparent: true, depthWrite: false, depthTest: false, blending: NormalBlending,
    }))
    this.smokeMesh.frustumCulled = false
    this.smokeMesh.renderOrder = 1
    this.scene.add(this.smokeMesh)

    // Firelight pooled on the pad and in the trench.
    this.glow = new Mesh(new PlaneGeometry(1, 1), new ShaderMaterial({
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying float vViewDepth;
        void main() { vUv = uv * 2.0 - 1.0; vec4 mv = modelViewMatrix * vec4(position, 1.0); vViewDepth = -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */ `
        ${DEPTH_GLSL}
        uniform vec3 uColor; varying vec2 vUv; varying float vViewDepth;
        void main() {
          float r = length(vUv);
          float g = exp(-r * r * 5.0) + 0.25 * exp(-r * r * 40.0);
          if (vViewDepth > sceneViewDepth() + 4.0) discard;
          gl_FragColor = vec4(uColor * g, 1.0);
        }`,
      uniforms: { ...this.depth, uColor: { value: new Color() } },
      transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending,
    }))
    this.glow.matrixAutoUpdate = false
    this.glow.frustumCulled = false
    this.scene.add(this.glow)
    this.light.castShadow = false
  }

  setDepth(texture: Texture) {
    this.depth.uDepth.value = texture
    this.depth.uHasDepth.value = 1
  }

  /** Advances the mission's exhaust and smoke. Call once per frame after the vehicle moved. */
  update(f: LaunchFrame, dt: number) {
    const s = f.s, phase = s[S.SHUTTLE_PHASE], mission = s[S.MISSION_TIME]
    this.time += dt
    // A new spawn, a restart or a rewind clears the old exhaust.
    if (f.generation !== this.generation || mission < this.lastTime - 0.5 || phase <= 1) {
      this.generation = f.generation
      this.smoke.clear()
      for (const e of this.emitters) e.last = null
      this.column.last = null
      this.padCarry = 0
    }
    const simDt = this.lastTime < 0 ? 0 : Math.max(0, Math.min(2, mission - this.lastTime))
    this.lastTime = mission
    const height = s[S.HEIGHT] - s[S.SHUTTLE_PAD_HEIGHT]
    const ignition = MathSmooth(mission, 0, 0.7)
    const boosting = phase === 2
    this.thrust.srb = boosting ? ignition : 0
    this.thrust.ssme = phase === 2 || phase === 3 ? ignition : 0
    this.thrust.oms = phase === 5 ? s[S.ENGINE] : 0
    const firing = this.thrust.srb > 0 || this.thrust.ssme > 0 || this.thrust.oms > 0.01
    if (firing || this.smoke.count > 0) this.refreshAnchors()
    // Plumes widen as the ambient pressure drops; above ~60 km they are a faint haze.
    const expand = 1 + Math.min(8, Math.pow(Math.max(0, height) / 11000, 1.35))
    // Wider plumes spread the same light over more area.
    const thin = 1 / Math.pow(expand, 0.9)
    // Hydrogen-oxygen exhaust is nearly invisible in vacuum; shock diamonds need an atmosphere.
    const vacuum = 1 - MathSmooth(height, 45_000, 110_000) * 0.85
    const diamonds = 1 - MathSmooth(height, 8_000, 30_000)
    for (const { plume, anchor, group } of this.plumes) {
      const level = this.thrust[group]
      const visible = level > 0.01 && (anchor.parent?.visible ?? true)
      plume.mesh.visible = visible
      if (!visible) continue
      plume.mesh.matrix.copy(anchor.matrixWorld)
      plume.mesh.matrixWorldNeedsUpdate = true
      const u = plume.mesh.material.uniforms, spec = plume.spec
      const flicker = 1 + 0.06 * Math.sin(this.time * 47 + spec.r0 * 9) + 0.04 * Math.sin(this.time * 83)
      const grow = group === 'oms' ? 1 : expand
      u.uTime.value = this.time
      u.uLength.value = spec.length * (group === 'oms' ? Math.max(0.2, level) : (0.3 + 0.7 * level) * (1 + 0.45 * (grow - 1)))
      u.uRadius1.value = spec.r1 * Math.pow(grow, group === 'srb' ? 1.05 : 0.95)
      u.uIntensity.value = spec.intensity * level * flicker * (group === 'oms' ? 1 : thin * (group === 'ssme' ? vacuum : 1))
      u.uDiamondMix.value = diamonds
    }

    const fire = Math.max(this.thrust.srb, this.thrust.ssme * 0.25)
    this.glowAt = fire > 0 ? this.nozzleCentre() : null
    // Wind strengthens with height; the smoke column leans and drifts downwind.
    const smoke = this.smoke
    if (boosting && simDt > 0) this.emit(f, simDt, height)
    const drift = 1 + Math.min(4, Math.max(0, height) / 9000)
    const live = smoke.live
    let kept = 0
    for (let n = 0; n < smoke.count; n++) {
      const i = live[n]
      const age = smoke.age[i] += simDt
      if (age > smoke.life[i]) { smoke.life[i] = -1; continue }
      live[kept++] = i
      if (simDt === 0) continue
      const k = Math.exp(-simDt / smoke.drag[i])
      const w = smoke.kind[i] === 1 ? 1 : drift
      smoke.vx[i] = f.wind.x * w + (smoke.vx[i] - f.wind.x * w) * k
      smoke.vy[i] = f.wind.y * w + (smoke.vy[i] - f.wind.y * w) * k
      smoke.vz[i] = f.wind.z * w + (smoke.vz[i] - f.wind.z * w) * k
      // The hot pad cloud rises and billows; trail puffs settle very slowly.
      const lift = smoke.kind[i] === 1 ? 3.2 * Math.exp(-age / 40) + 0.4 : -0.05
      let x = smoke.px[i] + (smoke.vx[i] + f.padUp.x * lift) * simDt
      let y = smoke.py[i] + (smoke.vy[i] + f.padUp.y * lift) * simDt
      let z = smoke.pz[i] + (smoke.vz[i] + f.padUp.z * lift) * simDt
      // Exhaust that reaches the pad is turned along the north-south flame trench.
      const above = (x - f.pad.x) * f.padUp.x + (y - f.pad.y) * f.padUp.y + (z - f.pad.z) * f.padUp.z
      const floor = smoke.radius(i) * 0.35
      if (above < floor) {
        const vn = smoke.vx[i] * f.padUp.x + smoke.vy[i] * f.padUp.y + smoke.vz[i] * f.padUp.z
        if (vn < 0) {
          const dir = smoke.seed[i] < 0.5 ? -1 : 1, spread = (smoke.seed[i] * 7.3 % 1 - 0.5) * 0.7
          smoke.vx[i] += -vn * f.padUp.x + (f.padNorth.x * dir + f.padEast.x * spread) * -vn * 0.85
          smoke.vy[i] += -vn * f.padUp.y + (f.padNorth.y * dir + f.padEast.y * spread) * -vn * 0.85
          smoke.vz[i] += -vn * f.padUp.z + (f.padNorth.z * dir + f.padEast.z * spread) * -vn * 0.85
          smoke.rMax[i] *= 1.25
          smoke.kind[i] = 1
        }
        x += f.padUp.x * (floor - above); y += f.padUp.y * (floor - above); z += f.padUp.z * (floor - above)
      }
      smoke.px[i] = x; smoke.py[i] = y; smoke.pz[i] = z
    }
    smoke.count = kept

    // Firelight: a point light between the boosters' nozzles and the glow on the pad.
    // The light stays in the scene at zero intensity: adding or removing a light
    // changes every lit material's program and would stall the liftoff frame.
    this.active = firing || smoke.count > 0
    const flick = 0.85 + 0.15 * Math.sin(this.time * 31) * Math.sin(this.time * 17.3)
    if (this.glowAt) this.light.position.copy(this.glowAt).addScaledVector(this.exhaust, 12)
    this.light.intensity = fire * flick * 550
    const near = 1 - MathSmooth(height, 50, 600)
    this.glow.visible = fire > 0 && near > 0
    if (this.glow.visible) {
      frame.ecefToWorld(f.pad.x, f.pad.y, f.pad.z, _a)
      _b.copy(f.padUp).transformDirection(frame.worldFromEcef)
      _c.copy(f.padEast).transformDirection(frame.worldFromEcef)
      _d.crossVectors(_b, _c)
      const size = 110 + height * 0.3
      this.glow.matrix.makeBasis(_c, _d, _b).scale(_e.set(size, size, 1)).setPosition(_a.addScaledVector(_b, 0.4))
      this.glow.matrixWorldNeedsUpdate = true
      this.glow.material.uniforms.uColor.value.copy(PAD_GLOW).multiplyScalar(0.9 * fire * near * flick)
    }
    const u = this.smokeMesh.material.uniforms
    u.uTime.value = this.time
    u.uSunColor.value.copy(f.sunColor).multiplyScalar(1 / Math.PI)
    u.uAmbient.value.copy(f.ambient).multiplyScalar(1 / Math.PI)
    u.uGlow.value.copy(FIRE_GLOW).multiplyScalar(1.5 * fire * flick)
    u.uHaze.value.copy(f.ambient).multiplyScalar(0.42 / Math.PI)
    u.uHazeDistance.value = 26000 * (1 + Math.max(0, height) / 9000)
    this.sunWorld.copy(f.sun)
  }

  private readonly sunWorld = new Vector3()
  private glowAt: Vector3 | null = null
  /** Far to near; used when a camera cut reorders everything at once. */
  private readonly byDepth = (a: number, b: number) => this.keys[b] - this.keys[a]

  /** One world-matrix refresh per frame for the exhaust anchors and their parents. */
  private refreshAnchors() {
    this.model.updateWorldMatrix(true, false)
    for (const parent of this.anchorParents) parent.updateWorldMatrix(false, false)
    for (const anchor of this.anchors) anchor.updateWorldMatrix(false, false)
  }

  /** Centre of the booster nozzles, or the main engines once the boosters are gone. */
  private nozzleCentre() {
    const [a, b] = this.emitters.map((e) => e.anchor)
    if (a && b && a.parent?.visible) {
      this.nozzle.setFromMatrixPosition(a.matrixWorld).add(_a.setFromMatrixPosition(b.matrixWorld)).multiplyScalar(0.5)
      this.exhaust.set(0, 0, 1).transformDirection(a.matrixWorld)
      return this.nozzle
    }
    if (!this.mainAnchor) return null
    this.nozzle.setFromMatrixPosition(this.mainAnchor.matrixWorld)
    this.exhaust.set(0, 0, 1).transformDirection(this.mainAnchor.matrixWorld)
    return this.nozzle
  }

  /** Spawns smoke at the end of the visible booster flames, spaced by puff size. */
  private emit(f: LaunchFrame, simDt: number, height: number) {
    const smoke = this.smoke
    const centre = this.glowAt
    if (!centre) return
    const km = Math.max(0, height) / 1000
    const r0 = 4.5 + km * 1.6
    const rMax = 16 + km * 5.5
    const opacity = Math.max(0.25, 0.85 - km * 0.012)
    const life = 150 + km * 3
    // Exhaust leaves the flame far faster than the vehicle near the pad; aloft
    // the ground-relative smoke is almost stationary, so it forms a column.
    const eject = 10 + 75 * Math.exp(-km / 3)
    const flameEnd = 26 + Math.min(60, km * 3.5)
    const dirEcef = _d.copy(this.exhaust).transformDirection(frame.ecefFromWorld)
    const separate = height < 350
    const sources = separate ? this.emitters : this.columnOnly
    let budget = 160
    for (const source of sources) {
      if (source.anchor) _a.setFromMatrixPosition(source.anchor.matrixWorld)
      else _a.copy(centre)
      frame.worldToEcef(_a, _b).addScaledVector(dirEcef, flameEnd)
      if (!source.last) { source.last = _b.clone(); continue }
      const gap = _c.subVectors(_b, source.last).length()
      const spacing = separate ? Math.max(1.6, r0 * 0.45) : r0 * 0.6
      const steps = Math.min(budget, Math.floor(gap / spacing))
      const r = r0 * (separate ? 1 : 1.35)
      for (let k = 1; k <= steps; k++) {
        _e.lerpVectors(source.last, _b, k / steps)
        _v.copy(f.velocity).multiplyScalar(0.15).addScaledVector(dirEcef, eject)
        jitter(_v, 6 + km)
        // Offset across the column; its direction also shades the column as a whole.
        jitter(_axis.set(0, 0, 0), 1).addScaledVector(dirEcef, -_axis.dot(dirEcef))
        if (_axis.lengthSq() < 1e-4) _axis.copy(f.padEast)
        _axis.normalize()
        _e.addScaledVector(_axis, r0 * 0.45 * Math.random())
        smoke.spawn(0, _e, _v, _axis, r, rMax * (separate ? 1 : 1.4), 3 + km * 0.4, life * (0.8 + Math.random() * 0.4), opacity, 0.6)
      }
      budget -= steps
      if (steps > 0) source.last.copy(_b)
    }
    // Hand over between the two booster trails and the merged column.
    if (separate) this.column.last = null
    else for (const e of this.emitters) e.last = null
    // The pad exhaust and deluge steam cloud billowing out of the trench.
    const near = 1 - MathSmooth(height, 0, 420)
    this.padCarry += simDt * 34 * near
    while (this.padCarry >= 1 && budget-- > 0) {
      this.padCarry -= 1
      const dir = Math.random() < 0.5 ? -1 : 1
      const along = 12 + Math.random() * 30
      _e.copy(f.pad).addScaledVector(f.padNorth, dir * along).addScaledVector(f.padEast, (Math.random() - 0.5) * 16).addScaledVector(f.padUp, 3)
      _v.copy(f.padNorth).multiplyScalar(dir * (40 + Math.random() * 45)).addScaledVector(f.padEast, (Math.random() - 0.5) * 34)
        .addScaledVector(f.padUp, 4 + Math.random() * 12)
      _axis.subVectors(_e, f.pad).addScaledVector(f.padUp, 6).normalize()
      smoke.spawn(1, _e, _v, _axis, 9 + Math.random() * 5, 34 + Math.random() * 26, 7, 85 + Math.random() * 40, 0.92, 2.6)
    }
  }

  /**
   * Writes the smoke instances back to front for this camera. The draw order
   * barely changes between frames, so last frame's order is insertion-sorted
   * in place: near O(n), and nothing is allocated per frame.
   */
  prepare(camera: PerspectiveCamera) {
    this.depth.uLogFar.value = Math.log2(camera.far + 1)
    const smoke = this.smoke, u = this.smokeMesh.material.uniforms
    u.uSunView.value.copy(this.sunWorld).transformDirection(camera.matrixWorldInverse)
    camera.getWorldDirection(_a)
    const cam = camera.position, keys = this.keys, wx = this.wx, wy = this.wy, wz = this.wz
    const stamp = ++this.stamp
    for (let n = 0; n < smoke.count; n++) {
      const i = smoke.live[n]
      frame.ecefToWorld(smoke.px[i], smoke.py[i], smoke.pz[i], _b)
      wx[i] = _b.x; wy[i] = _b.y; wz[i] = _b.z
      keys[i] = (_b.x - cam.x) * _a.x + (_b.y - cam.y) * _a.y + (_b.z - cam.z) * _a.z
      this.seen[i] = keys[i] < -smoke.rMax[i] * 2 ? 0 : stamp
    }
    // Keep last frame's survivors in order, then append newcomers.
    const order = this.order
    let m = 0
    for (let k = 0; k < this.drawn; k++) {
      const i = order[k]
      if (this.seen[i] === stamp) { order[m++] = i; this.seen[i] = stamp + 1 }
    }
    for (let n = 0; n < smoke.count; n++) {
      const i = smoke.live[n]
      if (this.seen[i] === stamp) { order[m++] = i; this.seen[i] = stamp + 1 }
    }
    this.stamp++
    let shifts = 0
    for (let k = 1; k < m && shifts <= m * 24; k++) {
      const i = order[k], key = keys[i]
      let j = k - 1
      while (j >= 0 && keys[order[j]] < key) { order[j + 1] = order[j]; j--; shifts++ }
      order[j + 1] = i
    }
    if (shifts > m * 24) order.subarray(0, m).sort(this.byDepth)
    this.drawn = m
    const pos = this.iPos.array as Float32Array, data = this.iData.array as Float32Array
    const shade = this.iShade.array as Float32Array, axis = this.iAxis.array as Float32Array
    const glowAt = this.glowAt, rot = frame.worldFromEcefRot
    for (let k = 0; k < m; k++) {
      const i = order[k]
      pos[k * 3] = wx[i]; pos[k * 3 + 1] = wy[i]; pos[k * 3 + 2] = wz[i]
      const age = smoke.age[i], life = smoke.life[i], r = smoke.radius(i)
      const fadeIn = Math.min(1, age / 0.6), fadeOut = 1 - MathSmooth(age, life * 0.55, life)
      const glow = glowAt ? Math.exp(-Math.hypot(wx[i] - glowAt.x, wy[i] - glowAt.y, wz[i] - glowAt.z) / (14 + r * 0.25)) : 0
      data[k * 4] = r; data[k * 4 + 1] = smoke.opacity[i] * fadeIn * (0.35 + 0.65 * fadeOut)
      data[k * 4 + 2] = smoke.seed[i]; data[k * 4 + 3] = glow
      // Erode the edges as a puff ages, and warm the freshest exhaust.
      _axis.set(smoke.ax[i], smoke.ay[i], smoke.az[i]).applyQuaternion(rot)
      axis[k * 3] = _axis.x; axis[k * 3 + 1] = _axis.y; axis[k * 3 + 2] = _axis.z
      shade[k * 2] = 0.16 + 0.4 * (1 - fadeOut); shade[k * 2 + 1] = smoke.kind[i] === 0 ? Math.exp(-age / 6) * 0.6 : 0.1
    }
    for (const [attribute, size] of this.instanceAttributes) {
      attribute.needsUpdate = true
      attribute.clearUpdateRanges()
      attribute.addUpdateRange(0, m * size)
    }
    this.smokeMesh.geometry.instanceCount = m
    this.smokeMesh.visible = m > 0
  }

  /** Live smoke puffs (diagnostics and benchmarks). */
  get smokeCount() { return this.smokeMesh.geometry.instanceCount }

  /** Camera shake from engine noise and ground vibration, 0..1. */
  shake(s: Float64Array, cameraDistance: number) {
    const phase = s[S.SHUTTLE_PHASE], t = s[S.MISSION_TIME]
    if (phase !== 2 && phase !== 3) return 0
    // Sound reaches a distant camera late and weaker.
    if (t < cameraDistance / 343) return 0
    const height = s[S.HEIGHT] - s[S.SHUTTLE_PAD_HEIGHT]
    const near = Math.exp(-Math.max(0, height) / 1800) * Math.exp(-cameraDistance / 3000)
    const maxQ = Math.exp(-(((t - 62) / 14) ** 2)) * 0.45
    return Math.min(1, (phase === 2 ? 1 : 0.3) * (0.2 + 0.8 * near) + maxQ) * MathSmooth(t, 0, 0.8)
  }

  dispose() {
    this.plumes[0]?.plume.mesh.geometry.dispose()
    for (const { plume } of this.plumes) plume.mesh.material.dispose()
    this.smokeMesh.geometry.dispose()
    ;(this.smokeMesh.material.uniforms.uPuff.value as Texture).dispose()
    this.smokeMesh.material.dispose()
    this.glow.geometry.dispose(); this.glow.material.dispose()
    this.light.dispose()
  }
}

function MathSmooth(x: number, a: number, b: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function jitter(v: Vector3, amount: number) {
  v.x += (Math.random() - 0.5) * 2 * amount
  v.y += (Math.random() - 0.5) * 2 * amount
  v.z += (Math.random() - 0.5) * 2 * amount
  return v
}

