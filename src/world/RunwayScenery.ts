import {
  CanvasTexture, Color, Group, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace,
  Uniform, Vector2, Vector3, type Material, type Object3D,
} from 'three'
import type { Airport, AirportDetail, Runway, WorldQuery } from '../sim/protocol'
import { frame } from './frame'
import { RUNWAY_CLEARANCE, runwayClearsPoint, runwaySurface, type RunwaySurface } from './runwaySurface'

const MAX_RUNWAYS = 24
const ACTIVE_RANGE = 18_000
const FT = 0.3048
const uniformsSource = /* glsl */ `
uniform int runwayCount;
uniform vec4 runwayStart[${MAX_RUNWAYS}];
uniform vec4 runwayForward[${MAX_RUNWAYS}];
uniform vec4 runwayRight[${MAX_RUNWAYS}];
uniform vec4 runwayBounds;
varying vec3 vRunwayWorld;

bool runwayRemovesScenery(vec3 world) {
  if (runwayCount == 0 || abs(world.x - runwayBounds.x) > runwayBounds.z ||
    abs(world.z - runwayBounds.y) > runwayBounds.w) return false;
  for (int i = 0; i < ${MAX_RUNWAYS}; ++i) {
    if (i >= runwayCount) break;
    vec3 relative = world - runwayStart[i].xyz;
    vec3 along = runwayForward[i].xyz;
    vec3 across = runwayRight[i].xyz;
    float lengthwise = dot(relative, along);
    if (lengthwise < 0.0 || lengthwise > runwayForward[i].w) continue;
    if (abs(dot(relative, across)) > runwayRight[i].w) continue;
    float height = dot(relative, cross(across, along));
    if (height >= -0.15 && height <= runwayStart[i].w) return true;
  }
  return false;
}
`

const pavementSource = /* glsl */ `
uniform vec2 runwaySize;
uniform vec2 runwayThresholds;
uniform sampler2D runwayNumbers;
uniform float runwayPaved;
varying vec2 vPavementUv;

float runwayBand(float x, float middle, float halfWidth, float aa) {
  return 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, abs(x - middle));
}
float runwaySection(float x, float start, float end, float aa) {
  return smoothstep(start - aa, start + aa, x) * (1.0 - smoothstep(end - aa, end + aa, x));
}
float runwayNoise(vec2 p) {
  vec2 f = fract(p);
  f *= f * (3.0 - 2.0 * f);
  vec2 c = floor(p);
  vec4 r = fract(sin(vec4(dot(c, vec2(127.1, 311.7))) + vec4(0.0, 127.1, 311.7, 438.8)) * 43758.5453);
  return mix(mix(r.x, r.y, f.x), mix(r.z, r.w, f.x), f.y);
}
void colorRunway(inout vec3 color) {
  vec2 p = vec2(vPavementUv.x - 0.5, vPavementUv.y) * runwaySize;
  vec2 aa = max(fwidth(p) * 0.55, vec2(0.025));
  float wear = runwayNoise(p * 0.11);
  float flecks = runwayNoise(p * 8.0) - 0.5;
  flecks *= 1.0 - smoothstep(0.03, 0.24, max(aa.x, aa.y));
  color *= 0.85 + 0.26 * wear + 0.21 * flecks;
  if (runwayPaved < 0.5) return;
  float mirror = step(runwaySize.y * 0.5, p.y);
  float fromEnd = min(p.y, runwaySize.y - p.y);
  float threshold = mix(runwayThresholds.x, runwayThresholds.y, mirror);
  float landing = fromEnd - threshold;
  float marks = runwayBand(abs(p.x), runwaySize.x * 0.5 - 0.55, 0.14, aa.x)
    * runwaySection(fromEnd, 1.0, runwaySize.y, aa.y);
  float stripe = runwayBand(mod(p.y + 30.0, 60.0), 30.0, 14.5, min(aa.y, 12.0));
  stripe = mix(stripe, 29.0 / 60.0, smoothstep(8.0, 30.0, aa.y));
  marks = max(marks, stripe * runwayBand(p.x, 0.0, 0.42, aa.x)
    * runwaySection(landing, 58.0, runwaySize.y, aa.y));
  float dash = runwayBand(mod(p.x + 1.5, 3.0), 1.5, 0.83, aa.x);
  marks = max(marks, dash * runwaySection(abs(p.x), 1.5, runwaySize.x * 0.5 - 2.8, aa.x)
    * runwaySection(landing, 6.0, 27.0, aa.y));
  if (runwaySize.y > 1150.0) {
    marks = max(marks, runwayBand(abs(p.x), runwaySize.x * 0.24, 2.0, aa.x)
      * runwaySection(landing, 280.0, 321.0, aa.y));
    float rubber = runwayBand(p.x, 0.0, 2.2, aa.x) * runwaySection(landing, 120.0, 620.0, max(30.0, aa.y));
    color *= 1.0 - 0.16 * rubber * (0.48 + 0.52 * wear);
  }
  vec2 label = vec2(0.5 + mix(p.x, -p.x, mirror) / min(24.0, runwaySize.x * 0.75), (landing - 32.0) / 18.0);
  if (all(greaterThanEqual(label, vec2(0.0))) && all(lessThanEqual(label, vec2(1.0)))) {
    marks = max(marks, texture2D(runwayNumbers, vec2(label.x, (label.y + 1.0 - mirror) * 0.5)).a);
  }
  color = mix(color, vec3(0.78, 0.77, 0.72), clamp(marks, 0.0, 1.0) * (0.82 + 0.18 * wear));
}
`

const runwayGeometry = new PlaneGeometry(1, 1)
const _relative = new Vector3()
const _point = new Vector3()
const _world = new Vector3()

function numberTexture(runway: Runway) {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 256
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 80px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  runway.ends.forEach((end, i) => ctx.fillText(end.ident, 64, i * 128 + 64, 112))
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

function makeSurface(runway: Runway, surface: RunwaySurface) {
  const type = runway.surface.toUpperCase()
  const sod = /GRASS|TURF|SOD/.test(type)
  const unpaved = sod || /DIRT|GRAV|SAND|CLAY|EARTH|LATERITE|ICE|SNOW|WATER/.test(type)
  const numbers = numberTexture(runway)
  const material = new MeshBasicMaterial({
    color: new Color(sod ? '#7d8053' : unpaved ? '#8b7963' : /CON/.test(type) ? '#979899' : '#60636a'),
  })
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      runwaySize: new Uniform(new Vector2(surface.width, surface.length)),
      runwayThresholds: new Uniform(new Vector2(
        Math.max(0, runway.ends[0].displaced_threshold_ft * FT),
        Math.max(0, runway.ends[1].displaced_threshold_ft * FT),
      )),
      runwayNumbers: new Uniform(numbers),
      runwayPaved: new Uniform(unpaved ? 0 : 1),
    })
    shader.vertexShader = 'varying vec2 vPavementUv;\n' +
      shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\nvPavementUv = uv;')
    shader.fragmentShader = pavementSource +
      shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\ncolorRunway(diffuseColor.rgb);')
  }
  const mesh = new Mesh(runwayGeometry, material)
  mesh.matrixAutoUpdate = false
  mesh.name = `Runway ${runway.ends.map((end) => end.ident).join('/')}`
  return { mesh, runway, surface, numbers }
}

type Patch = ReturnType<typeof makeSurface>

/** Renders nearby database runways and masks conflicting scenery only over the strip. */
export class RunwayScenery {
  readonly group = new Group()
  private readonly materials = new WeakSet<Material>()
  private readonly cache = new Map<string, AirportDetail | null>()
  private readonly patches: Patch[] = []
  private readonly originWorld = new Vector3()
  private readonly forward = new Vector3()
  private readonly right = new Vector3()
  private readonly position = new Vector3()
  private lastQuery = -Infinity
  private lastAirport: string | null = null
  private queryInFlight = false
  private lastOrigin = -1
  private disposed = false
  private readonly uniforms = {
    runwayCount: new Uniform(0),
    runwayStart: new Uniform(new Float32Array(MAX_RUNWAYS * 4)),
    runwayForward: new Uniform(new Float32Array(MAX_RUNWAYS * 4)),
    runwayRight: new Uniform(new Float32Array(MAX_RUNWAYS * 4)),
    runwayBounds: new Uniform(new Float32Array(4)),
  }

  constructor(private readonly query: <T>(query: WorldQuery) => Promise<T>) {}

  prepareScenery(scene: Object3D) {
    scene.traverse((object) => {
      const material = (object as Mesh).material
      if (!material) return
      for (const m of Array.isArray(material) ? material : [material]) {
        if (this.materials.has(m) || 'isShaderMaterial' in m) continue
        this.materials.add(m)
        const compile = m.onBeforeCompile
        const cacheKey = m.customProgramCacheKey()
        m.customProgramCacheKey = () => `${cacheKey}/runway-clearance`
        m.onBeforeCompile = (shader, renderer) => {
          compile.call(m, shader, renderer)
          Object.assign(shader.uniforms, this.uniforms)
          shader.vertexShader = 'varying vec3 vRunwayWorld;\n' + shader.vertexShader.replace(
            '#include <project_vertex>',
            '#include <project_vertex>\nvRunwayWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
          )
          shader.fragmentShader = uniformsSource + shader.fragmentShader.replace(
            '#include <clipping_planes_fragment>',
            '#include <clipping_planes_fragment>\nif (runwayRemovesScenery(vRunwayWorld)) discard;',
          )
        }
        m.needsUpdate = true
      }
    })
  }

  update(lat: number, lon: number, agl: number, airport: string | null) {
    if (agl > 8500 || this.queryInFlight || performance.now() - this.lastQuery < 3000) return
    if (this.position.distanceToSquared(frame.origin) < 1200 ** 2 && airport === this.lastAirport) return
    this.lastAirport = airport
    this.position.copy(frame.origin)
    this.lastQuery = performance.now()
    this.queryInFlight = true
    const nearby = this.query<{ airport: Airport }[]>({ type: 'nearest_airports', lat, lon, radius_km: 24, limit: 12 })
    return nearby.then(async (rows) => {
      if (this.disposed) return
      const idents = [...new Set([...(airport ? [airport] : []), ...rows.map((r) => r.airport.ident)])]
      const airports = await Promise.all(idents.map(async (ident) => {
        if (!this.cache.has(ident)) {
          const detail = await this.query<AirportDetail | null>({ type: 'airport', ident })
          if (this.cache.size >= 80) this.cache.delete(this.cache.keys().next().value!)
          this.cache.set(ident, detail)
        }
        return this.cache.get(ident)
      }))
      if (this.disposed) return
      const surfaces = airports.flatMap((detail) => detail?.runways.flatMap((runway) => {
        const surface = runwaySurface(runway, detail)
        if (!surface) return []
        const along = Math.min(surface.length, Math.max(0, _relative.subVectors(frame.origin, surface.start).dot(surface.forward)))
        const distance = _world.copy(surface.start).addScaledVector(surface.forward, along).distanceTo(frame.origin)
        const ident = detail.airport.ident
        const key = `${ident}:${runway.ends[0].ident}:${runway.ends[1].ident}`
        return distance < ACTIVE_RANGE ? [{ runway, surface, distance, ident, key }] : []
      }) ?? [])
      surfaces.sort((a, b) => Number(b.ident === airport) - Number(a.ident === airport) || a.distance - b.distance)
      // Keep crossing runways in the same draw order as the aircraft moves.
      const selected = surfaces.slice(0, MAX_RUNWAYS).sort((a, b) => a.key.localeCompare(b.key))
      if (selected.length === this.patches.length && selected.every(({ runway }, i) => runway === this.patches[i].runway)) return
      this.clear()
      for (const { runway, surface } of selected) {
        const patch = makeSurface(runway, surface)
        this.patches.push(patch)
        this.group.add(patch.mesh)
      }
      this.lastOrigin = -1
      this.sync()
    }).catch(() => { this.position.set(0, 0, 0) }).finally(() => { this.queryInFlight = false })
  }

  sync() {
    if (this.lastOrigin === frame.version) return
    this.lastOrigin = frame.version
    this.uniforms.runwayCount.value = this.patches.length
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
    const matrix = new Matrix4()
    for (const [i, { mesh, surface }] of this.patches.entries()) {
      const { start, forward, right, up, length, width } = surface
      const a = frame.ecefToWorld(start.x, start.y, start.z, this.originWorld)
      const f = this.forward.copy(forward).applyQuaternion(frame.worldFromEcefRot)
      const r = this.right.copy(right).applyQuaternion(frame.worldFromEcefRot)
      _point.copy(up).applyQuaternion(frame.worldFromEcefRot)
      this.uniforms.runwayStart.value.set([a.x, a.y, a.z, RUNWAY_CLEARANCE], i * 4)
      this.uniforms.runwayForward.value.set([f.x, f.y, f.z, length], i * 4)
      this.uniforms.runwayRight.value.set([r.x, r.y, r.z, width * 0.5], i * 4)
      const x2 = a.x + f.x * length
      const z2 = a.z + f.z * length
      const margin = width * 0.5 + RUNWAY_CLEARANCE
      minX = Math.min(minX, a.x - margin, x2 - margin)
      minZ = Math.min(minZ, a.z - margin, z2 - margin)
      maxX = Math.max(maxX, a.x + margin, x2 + margin)
      maxZ = Math.max(maxZ, a.z + margin, z2 + margin)
      // Stagger crossing surfaces by a few millimetres and keep the near
      // threshold at v=0 so each approach gets its own runway designation.
      _world.copy(a).addScaledVector(f, length * 0.5).addScaledVector(_point, 0.03 + i * 0.008)
      mesh.matrix.copy(matrix.makeBasis(r.multiplyScalar(width), f.multiplyScalar(length), _point)).setPosition(_world)
      mesh.matrixWorldNeedsUpdate = true
    }
    if (this.patches.length) this.uniforms.runwayBounds.value.set([
      (maxX + minX) * 0.5, (maxZ + minZ) * 0.5, (maxX - minX) * 0.5, (maxZ - minZ) * 0.5,
    ])
    this.group.updateMatrixWorld(true)
  }

  clears(worldPoint: Vector3) {
    const point = frame.worldToEcef(worldPoint, _point)
    return this.patches.some(({ surface }) => runwayClearsPoint(surface, point, _relative))
  }

  private clear() {
    this.group.clear()
    for (const { mesh, numbers } of this.patches) {
      mesh.material.dispose()
      numbers.dispose()
    }
    this.patches.length = 0
  }

  dispose() {
    this.disposed = true
    this.clear()
  }
}
