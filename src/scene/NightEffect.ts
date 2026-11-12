// Terrain fill, airglow and emissive lights, composited in linear light
// after aerial perspective and before tone mapping.

import { BlendFunction, CopyPass, Effect, EffectAttribute } from 'postprocessing'
import {
  Color, DataTexture, ImageLoader, LinearFilter, LinearMipmapLinearFilter, Matrix4,
  RedFormat, RepeatWrapping, Uniform, Vector2, Vector3, Vector4,
  type PerspectiveCamera, type Texture, type WebGLRenderer,
} from 'three'

export const MAX_LAMPS = 16

export interface Lamp {
  /** World position. */
  position: Vector3
  color: Color
  /** Radiance at the core; 0 hides the lamp. */
  intensity: number
  /** Halo radius in metres at the lamp. */
  size: number
}

const frag = /* glsl */ `
uniform float night;
uniform float moonlight;
uniform vec3 ambient;
uniform vec3 skyGlow;
uniform float aspect;
uniform float logFar;
uniform float horizonDip;
uniform vec3 viewRight;
uniform vec3 viewUp;
uniform vec3 viewForward;
uniform vec3 worldUp;
uniform vec3 eyePosition;
uniform mat4 ecefFromWorld;
uniform sampler2D cityMask;
uniform vec2 lightOrigin;
uniform vec3 lightEast;
uniform vec3 lightNorth;
uniform bool hasCityLights;
uniform sampler2D sceneAlbedo;
uniform sampler2D lightingMask;
uniform bool hasLightingMask;
uniform sampler2D cloudOverlay;
uniform bool hasCloudOverlay;
uniform int lampCount;
uniform vec3 lampAt[${MAX_LAMPS}];
uniform vec4 lampColor[${MAX_LAMPS}];

// postprocessing's readDepth() converts log depth to perspective depth. Keep
// the native buffer precision here, including for distant terrain and lamps.
float sceneDepth(const vec2 uv) {
  #if DEPTH_PACKING == 3201
  return unpackRGBAToDepth(texture2D(depthBuffer, uv));
  #else
  return texture2D(depthBuffer, uv).r;
  #endif
}

float cloudTransmission(const vec2 uv) {
  return hasCloudOverlay ? 1.0 - clamp(texture2D(cloudOverlay, uv).a, 0.0, 1.0) : 1.0;
}

// Procedural street, area and landmark lights, seeded on a fixed ground grid.
// Each lamp is drawn as a point of constant on-screen size with a soft pool of
// light on the ground under it; once lamps crowd closer than a few pixels apart
// a layer resolves to its average glow, so the energy matches at every range.
uvec3 lampHash(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

vec3 lampTint(const float k) {
  // High-pressure sodium, warm LED and cool LED.
  return k < 0.5 ? vec3(1.0, 0.5, 0.15) : k < 0.85 ? vec3(1.0, 0.8, 0.56) : vec3(0.8, 0.9, 1.0);
}

vec3 lampLayer(const vec2 ground, const mat2 toScreen, const float footprint, const float stretch,
               const float cell, const uint seed, const float chance, const float power, const float radius,
               const float pool, const float poolRadius, const vec3 albedo, const float near, const float twinkle) {
  if (chance <= 0.0) return vec3(0.0);
  // Mean over a cell: lamp flux plus the lit ground, times the mean tint and brightness.
  vec3 flux = vec3(power * PI * radius * radius) + albedo * (pool * PI * poolRadius * poolRadius);
  vec3 mean = vec3(0.97, 0.665, 0.421) * flux * (chance * 0.675 / (cell * cell));
  float blend = smoothstep(0.12, 0.3, stretch / cell);
  if (blend >= 1.0) return mean;
  vec2 p = ground / cell;
  vec2 base = floor(p - 0.5);
  // Unresolved lamps keep a minimum size and dim instead, preserving their energy.
  float rPx = max(0.75, radius / footprint);
  float energy = radius / (footprint * rPx);
  energy *= energy * near;
  vec3 sum = vec3(0.0);
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      vec2 id = base + vec2(float(i), float(j));
      vec3 h = vec3(lampHash(uvec3(uvec2(ivec2(id) + 8388608), seed))) * (1.0 / 4294967296.0);
      if (h.z >= chance) continue;
      float k = h.z / chance;
      vec2 d = (id + 0.2 + 0.6 * h.xy - p) * cell;
      vec3 tint = lampTint(fract(k * 7.31)) * mix(0.35, 1.0, fract(k * 3.17));
      vec2 s = toScreen * d;
      float flicker = 1.0 + twinkle * sin(time * (2.0 + 5.0 * h.x) + 40.0 * h.y);
      sum += tint * (power * energy * flicker * exp(-dot(s, s) / (rPx * rPx)));
      sum += tint * albedo * (pool * near * exp(-dot(d, d) / (poolRadius * poolRadius)));
    }
  }
  return mix(sum, mean, blend);
}

vec3 cityRadiance(const vec3 worldPosition, const vec3 albedo, const float luma, const float terrain, const float range) {
  vec3 ecef = (ecefFromWorld * vec4(worldPosition, 1.0)).xyz;
  float lon = atan(ecef.y, ecef.x);
  // Approximate geodetic latitude from the WGS84 ellipsoid, accurate at terrain heights.
  float lat = atan(ecef.z, max(1.0, length(ecef.xy)) * 0.99330562);
  vec2 mapUv = vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
  vec2 dx = dFdx(mapUv);
  vec2 dy = dFdy(mapUv);
  // Filter across the antimeridian as neighboring samples.
  dx.x -= round(dx.x);
  dy.x -= round(dy.x);
  // Metres east and north of a fixed reference: exact through floating-origin shifts.
  vec2 ground = lightOrigin + vec2(dot(worldPosition, lightEast), dot(worldPosition, lightNorth));
  vec2 gx = dFdx(ground);
  vec2 gy = dFdy(ground);
  if (terrain <= 0.0 || range >= 300000.0) return vec3(0.0);

  float observed = textureGrad(cityMask, mapUv, dx, dy).r;
  float density = pow(max(0.0, (observed - 0.018) / 0.982), 1.25);
  if (density < 0.001) return vec3(0.0);

  // Ground metres per pixel along each screen axis, and its inverse: a lamp is
  // round on screen however obliquely we see the ground it stands on.
  mat2 jacobian = mat2(gx, gy);
  float det = determinant(jacobian);
  float footprint = range * 2.0 * length(viewUp) / resolution.y;
  bool valid = abs(det) > 1e-10 * footprint * footprint;
  mat2 toScreen = valid ? inverse(jacobian) : mat2(0.0);
  float stretch = valid ? max(footprint, max(length(gx), length(gy))) : 1e9;

  // Satellite brightness places the cities; dark imagery (fields, water) gets fewer street lamps.
  float streets = mix(0.1, 1.0, smoothstep(0.012, 0.18, luma));
  float near = smoothstep(100.0, 400.0, range);
  float twinkle = 0.2 * smoothstep(3000.0, 15000.0, range);
  vec3 glow = vec3(1.0, 0.48, 0.19) * (0.0016 * density);
  glow += streets * lampLayer(ground, toScreen, footprint, stretch, 30.0, 1u, min(0.9, density * 1.6), 3.5, 0.4, 0.06, 7.0, albedo, near, twinkle);
  glow += lampLayer(ground, toScreen, footprint, stretch, 140.0, 2u, density * 0.55, 16.0, 0.6, 0.02, 28.0, albedo, near, twinkle);
  glow += lampLayer(ground, toScreen, footprint, stretch, 600.0, 3u, density * density * 0.7, 40.0, 1.0, 0.0, 1.0, albedo, near, twinkle);
  float d = range / 85000.0;
  return glow * terrain * (1.0 - smoothstep(180000.0, 300000.0, range)) / (1.0 + d * d);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  if (night > 0.001) {
    float depth = sceneDepth(uv);
    bool surface = depth < 1.0;
    vec2 ndc = uv * 2.0 - 1.0;
    vec3 ray = viewForward + ndc.x * viewRight + ndc.y * viewUp;
    float viewDepth = min(300000.0, exp2(depth * logFar) - 1.0);
    float range = viewDepth * length(ray);
    float terrain = surface && hasLightingMask ? texture2D(lightingMask, uv).r : 0.0;
    vec3 raw = max(texture2D(sceneAlbedo, uv).rgb, 0.0);
    float luma = dot(raw, vec3(0.2126, 0.7152, 0.0722));

    // A continuous haze at the curved horizon blends distant terrain into the sky.
    // Close surfaces occlude the haze, including the aircraft and cockpit.
    float h = dot(normalize(ray), worldUp) + horizonDip;
    vec3 airglow = skyGlow * (0.40 + 1.1 * exp(-max(h, 0.0) * 7.0));
    float surfaceHaze = 1.0 - exp(-range / 52000.0);
    // The grazing band should have the same airglow on either side of the
    // skyline, even when distant terrain is still streaming in.
    float skyHaze = smoothstep(-0.075, -0.008, h);
    float haze = surface ? surfaceHaze : skyHaze;
    vec3 fill = (1.0 - haze) * terrain * ambient * mix(vec3(luma), raw, 0.25) * moonlight;
    vec3 emission = airglow * haze + fill;
    if (hasCityLights) {
      emission += cityRadiance(eyePosition + ray * viewDepth, raw, luma, terrain, range);
    }
    // Cloud radiance has already been integrated by the volumetric pass.
    c += night * emission * cloudTransmission(uv);
  }
  for (int i = 0; i < ${MAX_LAMPS}; i++) {
    if (i >= lampCount) break;
    vec3 at = lampAt[i];
    vec4 lamp = lampColor[i];
    float f = length((uv - at.xy) * vec2(aspect, 1.0)) / lamp.a;
    if (f < 1.0) {
      // Hidden when something nearer covers the lamp itself.
      float seen = step(at.z, sceneDepth(at.xy));
      float glow = exp(-f * f * 90.0) + 0.16 * exp(-f * f * 14.0) + 0.03 * (1.0 - f) * (1.0 - f);
      c += lamp.rgb * glow * seen * cloudTransmission(at.xy);
    }
  }
  outputColor = vec4(c, inputColor.a);
}`

const _p = new Vector3()

class NightAlbedoPass extends CopyPass {
  override setSize(width: number, height: number) {
    // The low-intensity terrain fill only needs half-resolution albedo.
    super.setSize(Math.ceil(width / 2), Math.ceil(height / 2))
  }
}

interface CityPixels {
  width: number
  height: number
  pixels: Uint8Array
}

/** Main-thread fallback where workers cannot decode images (no OffscreenCanvas). */
async function decodeOnMainThread(url: string, maxWidth: number): Promise<CityPixels> {
  const image = await new ImageLoader().loadAsync(url)
  const width = Math.min(image.width, maxWidth)
  const height = width / 2
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = 128
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Could not decode the night lights atlas')
  const pixels = new Uint8Array(width * height)
  const scale = image.width / width
  // Extract one channel in strips to avoid holding a second full RGBA atlas.
  for (let y = 0; y < height; y += canvas.height) {
    const rows = Math.min(canvas.height, height - y)
    context.drawImage(image, 0, y * scale, image.width, rows * scale, 0, 0, width, rows)
    const rgba = context.getImageData(0, 0, width, rows).data
    for (let i = 0; i < width * rows; i++) pixels[y * width + i] = rgba[i * 4]
  }
  return { width, height, pixels }
}

function decodeInWorker(url: string, maxWidth: number): Promise<CityPixels> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./cityLights.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<CityPixels & { error?: string }>) => {
      worker.terminate()
      if (event.data.error) reject(new Error(event.data.error))
      else resolve(event.data)
    }
    worker.onerror = (event) => {
      worker.terminate()
      reject(new Error(event.message || 'City lights worker failed'))
    }
    worker.postMessage({ url: new URL(url, location.href).href, maxWidth })
  })
}

async function loadCityMask(url: string, maxTextureSize: number) {
  const maxWidth = Math.min(8192, maxTextureSize)
  let decoded: CityPixels
  try {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') throw new Error('no worker decode')
    decoded = await decodeInWorker(url, maxWidth)
  } catch {
    decoded = await decodeOnMainThread(url, maxWidth)
  }
  const texture = new DataTexture(decoded.pixels, decoded.width, decoded.height, RedFormat)
  texture.name = 'Black Marble city lights'
  texture.wrapS = RepeatWrapping
  texture.minFilter = LinearMipmapLinearFilter
  texture.magFilter = LinearFilter
  texture.generateMipmaps = true
  texture.needsUpdate = true
  return texture
}

/** Re-anchor the lamp grid only after this much travel; it is exact in between. */
const LIGHT_FRAME_RANGE = 150_000
/** Fetch the atlas this long after start even by day, so dusk never waits on it. */
const PREFETCH_DELAY_MS = 6000
export class NightEffect extends Effect {
  readonly albedoPass = new NightAlbedoPass()
  private readonly cityMapUrl?: string
  private readonly getCloudOverlay?: () => Texture | null
  private cityLoad: Promise<DataTexture> | null = null
  private cityMask: DataTexture | null = null
  private readonly createdAt = typeof performance === 'undefined' ? 0 : performance.now()
  private readonly ecefFromWorld: Matrix4
  private readonly lightReference = new Vector3()
  private readonly referenceEast = new Vector3()
  private readonly referenceNorth = new Vector3()
  private hasLightReference = false

  constructor(ecefFromWorld = new Matrix4(), cityMapUrl?: string, getCloudOverlay?: () => Texture | null) {
    super('NightEffect', frag, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, Uniform>([
        ['night', new Uniform(0)],
        ['moonlight', new Uniform(0.62)],
        ['ambient', new Uniform(new Color(0.013, 0.016, 0.022))],
        ['skyGlow', new Uniform(new Color(0.0010, 0.00135, 0.00215))],
        ['aspect', new Uniform(1)],
        ['logFar', new Uniform(1)],
        ['horizonDip', new Uniform(0)],
        ['viewRight', new Uniform(new Vector3(1, 0, 0))],
        ['viewUp', new Uniform(new Vector3(0, 1, 0))],
        ['viewForward', new Uniform(new Vector3(0, 0, -1))],
        ['worldUp', new Uniform(new Vector3(0, 1, 0))],
        ['eyePosition', new Uniform(new Vector3())],
        ['ecefFromWorld', new Uniform(ecefFromWorld)],
        ['cityMask', new Uniform(null)],
        ['lightOrigin', new Uniform(new Vector2())],
        ['lightEast', new Uniform(new Vector3(1, 0, 0))],
        ['lightNorth', new Uniform(new Vector3(0, 0, -1))],
        ['hasCityLights', new Uniform(false)],
        ['sceneAlbedo', new Uniform(null)],
        ['lightingMask', new Uniform(null)],
        ['hasLightingMask', new Uniform(false)],
        ['cloudOverlay', new Uniform(null)],
        ['hasCloudOverlay', new Uniform(false)],
        ['lampCount', new Uniform(0)],
        ['lampAt', new Uniform(Array.from({ length: MAX_LAMPS }, () => new Vector3()))],
        ['lampColor', new Uniform(Array.from({ length: MAX_LAMPS }, () => new Vector4()))],
      ]),
    })
    this.cityMapUrl = cityMapUrl
    this.getCloudOverlay = getCloudOverlay
    this.ecefFromWorld = ecefFromWorld
    this.albedoPass.enabled = false
    this.uniforms.get('sceneAlbedo')!.value = this.albedoPass.texture
  }

  setLightingMask(texture: Texture | null) {
    this.uniforms.get('lightingMask')!.value = texture
    this.uniforms.get('hasLightingMask')!.value = texture !== null
  }

  override update(renderer: WebGLRenderer) {
    // The cloud resolve swaps its textures during this composer frame.
    const overlay = this.getCloudOverlay?.() ?? null
    this.uniforms.get('cloudOverlay')!.value = overlay
    this.uniforms.get('hasCloudOverlay')!.value = overlay !== null
    if (!this.cityMapUrl || this.cityLoad) return
    if (this.uniforms.get('night')!.value < 0.001 && performance.now() - this.createdAt < PREFETCH_DELAY_MS) return
    const pending = loadCityMask(this.cityMapUrl, renderer.capabilities.maxTextureSize)
    this.cityLoad = pending
    void pending.then((mask) => {
      if (this.cityLoad !== pending) {
        mask.dispose()
        return
      }
      this.cityMask = mask
      // Upload now (and build its mipmaps) rather than on the first night frame.
      renderer.initTexture(mask)
      this.uniforms.get('cityMask')!.value = mask
      this.uniforms.get('hasCityLights')!.value = true
    }).catch((error: unknown) => {
      if (this.cityLoad === pending) console.warn('Could not load the city lights atlas', error)
    })
  }

  override dispose() {
    this.cityLoad = null
    this.cityMask?.dispose()
    this.cityMask = null
    this.uniforms.get('cityMask')!.value = null
    this.uniforms.get('hasCityLights')!.value = false
    super.dispose()
  }

  /**
   * The lamp grid lives on a plane tangent to the Earth at a reference point. Its
   * coordinates are a linear function of ECEF, so they are identical before and
   * after a floating-origin shift; only moving the reference (every 150 km) re-seeds it.
   */
  private updateLightFrame() {
    const m = this.ecefFromWorld.elements
    const ref = this.lightReference
    const dx = m[12] - ref.x, dy = m[13] - ref.y, dz = m[14] - ref.z
    if (!this.hasLightReference || dx * dx + dy * dy + dz * dz > LIGHT_FRAME_RANGE * LIGHT_FRAME_RANGE) {
      this.hasLightReference = true
      ref.set(m[12], m[13], m[14])
      const up = _p.copy(ref).normalize()
      this.referenceEast.set(-up.y, up.x, 0)
      if (this.referenceEast.lengthSq() < 1e-12) this.referenceEast.set(0, 1, 0)
      this.referenceEast.normalize()
      this.referenceNorth.crossVectors(up, this.referenceEast)
    }
    const e = this.referenceEast, n = this.referenceNorth
    const ox = m[12] - ref.x, oy = m[13] - ref.y, oz = m[14] - ref.z
    ;(this.uniforms.get('lightOrigin')!.value as Vector2).set(ox * e.x + oy * e.y + oz * e.z, ox * n.x + oy * n.y + oz * n.z)
    // World axes are the columns of ecefFromWorld; project the reference axes onto them.
    const axis = (v: Vector3, out: Vector3) => out.set(
      m[0] * v.x + m[1] * v.y + m[2] * v.z,
      m[4] * v.x + m[5] * v.y + m[6] * v.z,
      m[8] * v.x + m[9] * v.y + m[10] * v.z,
    )
    axis(e, this.uniforms.get('lightEast')!.value as Vector3)
    axis(n, this.uniforms.get('lightNorth')!.value as Vector3)
  }

  /**
   * @param night 0 in daylight, 1 in full night.
   * @param moon 0..1 how much moonlight reaches the ground.
   */
  setFrame(camera: PerspectiveCamera, night: number, moon: number, up: Vector3, lamps: readonly Lamp[], eyeHeight = 0) {
    const u = this.uniforms
    this.albedoPass.enabled = night > 0.001
    // View rays in world space, for the sky gradient.
    const e = camera.matrixWorld.elements
    const tan = Math.tan((camera.fov * Math.PI) / 360)
    ;(u.get('viewRight')!.value as Vector3).set(e[0], e[1], e[2]).multiplyScalar(tan * camera.aspect)
    ;(u.get('viewUp')!.value as Vector3).set(e[4], e[5], e[6]).multiplyScalar(tan)
    ;(u.get('viewForward')!.value as Vector3).set(-e[8], -e[9], -e[10])
    ;(u.get('worldUp')!.value as Vector3).copy(up)
    ;(u.get('eyePosition')!.value as Vector3).setFromMatrixPosition(camera.matrixWorld)
    u.get('night')!.value = night
    this.updateLightFrame()
    u.get('moonlight')!.value = 0.62 + 0.38 * moon
    // Sine of the angle below local horizontal at which the Earth falls away.
    const heightRatio = Math.max(0, eyeHeight) / 6371000
    u.get('horizonDip')!.value = Math.sqrt(heightRatio * (2 + heightRatio)) / (1 + heightRatio)
    u.get('aspect')!.value = camera.aspect
    const at = u.get('lampAt')!.value as Vector3[]
    const col = u.get('lampColor')!.value as Vector4[]
    const logFar = Math.log2(camera.far + 1)
    u.get('logFar')!.value = logFar
    let n = 0
    for (const lamp of lamps) {
      if (n >= MAX_LAMPS) break
      if (lamp.intensity <= 0) continue
      _p.copy(lamp.position).applyMatrix4(camera.matrixWorldInverse)
      const w = -_p.z
      if (w < camera.near) continue
      const x = _p.x / (w * tan * camera.aspect)
      const y = _p.y / (w * tan)
      // Offscreen depth samples clamp to the edge and cannot establish visibility.
      if (Math.abs(x) > 1 || Math.abs(y) > 1 || w > camera.far) continue
      // Same logarithmic depth the renderer writes, pulled half a metre towards the eye
      // so the lamp's own housing does not hide it.
      const depth = Math.log2(1 + Math.max(camera.near, w - 0.6)) / logFar
      at[n].set(x * 0.5 + 0.5, y * 0.5 + 0.5, depth)
      // Halo radius as a fraction of the view height; never smaller than a few pixels,
      // so distant lamps stay visible as points.
      const radius = Math.min(0.2, Math.max(0.006, lamp.size / (2 * w * tan)))
      // Far lamps are dimmer, but far less than inverse-square: the eye sees a point source.
      const fall = Math.min(1, 60 / Math.max(w, 1)) ** 0.6
      col[n].set(lamp.color.r * lamp.intensity * fall, lamp.color.g * lamp.intensity * fall, lamp.color.b * lamp.intensity * fall, radius)
      n++
    }
    u.get('lampCount')!.value = n
  }
}
