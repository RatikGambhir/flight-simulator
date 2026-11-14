import { Pass } from 'postprocessing'
import {
  GLSL3, HalfFloatType, Matrix3, Matrix4, RedFormat, ShaderMaterial, Uniform, Vector2, Vector3, Vector4, WebGLRenderTarget,
  type PerspectiveCamera, type Texture, type WebGLRenderer,
} from 'three'
import type { Quality } from '../state/store'
import { CUMULUS, type CloudProfile } from '../weather/cloudProfiles'
import { WGS84_A, WGS84_F } from '../world/frame'
import { DETAIL_PERIOD, SHAPE_PERIOD, SPACING_PERIOD, WEATHER_PERIOD, createCloudField } from './cloudField'
import { cloudVolumeFragment, cloudVolumeVertex } from './cloudVolumeShader'

const RESOLUTION: Record<Quality, number> = { low: 0.28, medium: 0.36, high: 0.48, ultra: 0.58 }
const STEPS: Record<Quality, number> = { low: 42, medium: 56, high: 72, ultra: 80 }
const SHADOW_SIZE: Record<Quality, number> = { low: 128, medium: 192, high: 256, ultra: 384 }
export const CLOUD_SHADOW_RANGE = 46000
const POLAR_SCALE = 1 / (1 - WGS84_F)

interface CloudWeather {
  coverage: number
  haze: number
  wind: Vector3
  sun: Vector3
  moon: Vector3
  moonPhase: number
  shadows?: boolean
  profile?: CloudProfile
}

function phase(out: Vector3, position: Vector3, displacement: Vector3, period: number, extra?: Vector3) {
  out.subVectors(position, displacement)
  if (extra) out.sub(extra)
  out.divideScalar(period)
  out.x -= Math.floor(out.x)
  out.y -= Math.floor(out.y)
  out.z -= Math.floor(out.z)
}

// An HDR premultiplied cloud image for the existing atmosphere and night passes.
// No camera history or frame-varying sample pattern is needed.
export class VolumetricCloudPass extends Pass {
  private readonly target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false })
  readonly overlay = { map: this.target.texture }
  private readonly shadowTarget = new WebGLRenderTarget(SHADOW_SIZE.high, SHADOW_SIZE.high, { format: RedFormat, depthBuffer: false })
  private readonly volumeMaterial: ShaderMaterial
  private readonly shadowMaterial: ShaderMaterial
  private readonly profile = new Uniform(new Vector4(CUMULUS.base, CUMULUS.top, CUMULUS.sheet, CUMULUS.convection))
  private readonly profileTarget = new Vector4()
  private weatherInitialized = false
  readonly groundShadow = {
    cloudGroundMap: new Uniform(this.shadowTarget.texture),
    cloudGroundEast: new Uniform(new Vector3()),
    cloudGroundNorth: new Uniform(new Vector3()),
    cloudGroundOffset: new Uniform(new Vector2()),
    cloudGroundStrength: new Uniform(0),
    cloudGroundProfile: this.profile,
  }
  private readonly viewToEcef = new Matrix4()
  private readonly eye = new Vector3()
  private readonly up = new Vector3()
  private readonly sun = new Vector3()
  private readonly shadowAnchor = new Vector3()
  private readonly drift = new Vector3()
  private readonly detailDrift = new Vector3()
  private resolution = RESOLUTION.high
  private width = 1
  private height = 1
  private readonly uniforms = {
    noiseField: { value: createCloudField() },
    sceneDepth: { value: null as Texture | null },
    inverseProjection: { value: new Matrix4() },
    ecefFromView: { value: new Matrix3() },
    eyeScaled: { value: new Vector3() },
    eyeRadius: { value: WGS84_A },
    eyeAltitude: { value: 0 },
    weatherPhase: { value: new Vector3() },
    spacingPhase: { value: new Vector3() },
    shapePhase: { value: new Vector3() },
    detailPhase: { value: new Vector3() },
    lightDirection: { value: new Vector3(0, 1, 0) },
    directLight: { value: new Vector3() },
    skyLight: { value: new Vector3() },
    hazeColor: { value: new Vector3() },
    coverage: { value: 0 },
    cloudProfile: this.profile,
    fogExtinction: { value: 0 },
    hazeDensity: { value: 0 },
    cameraFar: { value: 1 },
    logarithmicDepth: { value: false },
    stepBudget: { value: STEPS.high },
  }

  constructor(private readonly view: PerspectiveCamera, private readonly ecefFromWorld: Matrix4) {
    super('VolumetricCloudPass')
    this.needsDepthTexture = true
    this.needsSwap = false
    this.target.texture.name = 'GeoFlight cloud volume'
    const defines = {
      WEATHER_PERIOD: WEATHER_PERIOD.toFixed(1),
      SPACING_PERIOD: SPACING_PERIOD.toFixed(1),
      SHAPE_PERIOD: SHAPE_PERIOD.toFixed(1),
      DETAIL_PERIOD: DETAIL_PERIOD.toFixed(1),
      POLAR_SCALE: POLAR_SCALE.toFixed(9),
    }
    const material = {
      name: 'GeoFlight volumetric clouds',
      glslVersion: GLSL3,
      vertexShader: cloudVolumeVertex,
      fragmentShader: cloudVolumeFragment,
      depthTest: false,
      depthWrite: false,
    }
    this.volumeMaterial = new ShaderMaterial({ ...material, defines, uniforms: this.uniforms })
    this.shadowMaterial = new ShaderMaterial({
      ...material,
      name: 'GeoFlight cloud shadows',
      defines: { ...defines, SHADOW_PASS: 1, SHADOW_RANGE: CLOUD_SHADOW_RANGE.toFixed(1) },
      uniforms: {
        ...this.uniforms,
        eyeScaled: { value: new Vector3() },
        eyeRadius: { value: WGS84_A },
        eyeAltitude: { value: 0 },
        weatherPhase: { value: new Vector3() },
        spacingPhase: { value: new Vector3() },
        shapePhase: { value: new Vector3() },
        sunDirection: { value: this.sun },
        shadowEast: this.groundShadow.cloudGroundEast,
        shadowNorth: this.groundShadow.cloudGroundNorth,
      },
    })
    this.fullscreenMaterial = this.volumeMaterial
  }

  setWeather(dt: number, { coverage, haze, wind, sun, moon, moonPhase, shadows = false, profile = CUMULUS }: CloudWeather) {
    const u = this.uniforms
    u.coverage.value = coverage
    u.hazeDensity.value = haze
    this.profileTarget.set(profile.base, profile.top, profile.sheet, profile.convection)
    const blend = this.weatherInitialized ? 1 - Math.exp(-dt / 12) : 1
    this.profile.value.lerp(this.profileTarget, blend)
    u.fogExtinction.value += ((profile.fog ?? 0) - u.fogExtinction.value) * blend
    this.weatherInitialized = true
    this.drift.addScaledVector(wind, dt)
    // At most 4 cm/s of extra translation. This changes erosion at the edge
    // of a billow while the weather and main shape share exactly one wind.
    this.detailDrift.addScaledVector(wind, dt * 0.04 / Math.max(1, wind.length()))
    this.eye.copy(this.view.position).applyMatrix4(this.ecefFromWorld)
    this.up.copy(this.eye)
    this.up.z *= POLAR_SCALE ** 2
    this.up.normalize()
    const elevation = this.up.dot(sun)
    this.sun.copy(sun)
    this.groundShadow.cloudGroundStrength.value = shadows && coverage > 0.001 ? 0.78 * smooth(0.10, 0.24, elevation) : 0
    const daylight = smooth(-0.095, 0.16, elevation)
    const stormDarkness = 1 - 0.38 * this.profile.value.w * smooth(0.25, 0.78, coverage)
    const sunVisible = smooth(-0.045, 0.12, elevation)
    const warm = 1 - smooth(0.015, 0.35, elevation)
    const moonVisible = moonPhase ** 1.7 * smooth(0, 0.22, this.up.dot(moon))
    u.lightDirection.value.copy(sunVisible > 0 ? sun : moon)
    u.directLight.value.set(
      0.49 * sunVisible * stormDarkness + 0.005 * moonVisible,
      (0.47 - 0.27 * warm) * sunVisible * stormDarkness + 0.006 * moonVisible,
      (0.44 - 0.34 * warm) * sunVisible * stormDarkness + 0.008 * moonVisible,
    )
    u.skyLight.value.set(0.003 + 0.11 * daylight, 0.004 + 0.14 * daylight, 0.006 + 0.20 * daylight)
    u.hazeColor.value.set(0.0012 + (0.24 - 0.03 * warm) * daylight,
      0.0016 + (0.34 - 0.17 * warm) * daylight, 0.00235 + (0.46 - 0.32 * warm) * daylight)
  }

  setQuality(quality: Quality) {
    this.uniforms.stepBudget.value = STEPS[quality]
    if (this.shadowTarget.width !== SHADOW_SIZE[quality]) this.shadowTarget.setSize(SHADOW_SIZE[quality], SHADOW_SIZE[quality])
    if (this.resolution === RESOLUTION[quality]) return
    this.resolution = RESOLUTION[quality]
    this.setSize(this.width, this.height)
  }

  /** The current layer limits, including a weather transition in progress. */
  get base() { return this.profile.value.x }
  get top() { return this.profile.value.y }

  override setSize(width: number, height: number) {
    this.width = width
    this.height = height
    this.target.setSize(Math.max(1, Math.round(width * this.resolution)), Math.max(1, Math.round(height * this.resolution)))
  }

  override getDepthTexture() {
    // postprocessing's declaration omits null before the composer attaches depth.
    return this.uniforms.sceneDepth.value!
  }

  override setDepthTexture(texture: Texture | null) {
    this.uniforms.sceneDepth.value = texture
  }

  override render(renderer: WebGLRenderer) {
    const u = this.uniforms
    this.viewToEcef.multiplyMatrices(this.ecefFromWorld, this.view.matrixWorld)
    this.eye.setFromMatrixPosition(this.viewToEcef)
    u.ecefFromView.value.setFromMatrix4(this.viewToEcef)
    u.inverseProjection.value.copy(this.view.projectionMatrixInverse)
    u.cameraFar.value = this.view.far
    u.logarithmicDepth.value = renderer.capabilities.logarithmicDepthBuffer
    const scaled = u.eyeScaled.value.copy(this.eye)
    scaled.z *= POLAR_SCALE
    u.eyeRadius.value = scaled.length()
    u.eyeAltitude.value = u.eyeRadius.value - WGS84_A
    // Reduce the phase in double precision, before sending it to the GPU.
    phase(u.weatherPhase.value, this.eye, this.drift, WEATHER_PERIOD)
    phase(u.spacingPhase.value, this.eye, this.drift, SPACING_PERIOD)
    phase(u.shapePhase.value, this.eye, this.drift, SHAPE_PERIOD)
    phase(u.detailPhase.value, this.eye, this.drift, DETAIL_PERIOD, this.detailDrift)
    renderer.setRenderTarget(this.target)
    renderer.render(this.scene, this.camera)
    if (this.groundShadow.cloudGroundStrength.value > 0) this.renderGroundShadow(renderer)
  }

  private renderGroundShadow(renderer: WebGLRenderer) {
    const { cloudGroundEast, cloudGroundNorth, cloudGroundOffset } = this.groundShadow
    const east = cloudGroundEast.value
    const north = cloudGroundNorth.value
    // The sun plane is fixed in ECEF. Snap the map to its texel grid so
    // moving the camera or changing the floating origin cannot move shadows.
    east.set(0, Math.abs(this.sun.z) > 0.95 ? 1 : 0, Math.abs(this.sun.z) > 0.95 ? 0 : 1)
    east.cross(this.sun).normalize()
    north.crossVectors(this.sun, east)
    const texel = 2 * CLOUD_SHADOW_RANGE / this.shadowTarget.width
    const x = this.eye.dot(east)
    const y = this.eye.dot(north)
    const offset = cloudGroundOffset.value.set(x - Math.round(x / texel) * texel, y - Math.round(y / texel) * texel)
    this.shadowAnchor.copy(this.eye).addScaledVector(east, -offset.x).addScaledVector(north, -offset.y)
    const u = this.shadowMaterial.uniforms
    const scaled = u.eyeScaled.value.copy(this.shadowAnchor)
    scaled.z *= POLAR_SCALE
    u.eyeRadius.value = scaled.length()
    u.eyeAltitude.value = u.eyeRadius.value - WGS84_A
    phase(u.weatherPhase.value, this.shadowAnchor, this.drift, WEATHER_PERIOD)
    phase(u.spacingPhase.value, this.shadowAnchor, this.drift, SPACING_PERIOD)
    phase(u.shapePhase.value, this.shadowAnchor, this.drift, SHAPE_PERIOD)
    this.fullscreenMaterial = this.shadowMaterial
    renderer.setRenderTarget(this.shadowTarget)
    renderer.render(this.scene, this.camera)
    this.fullscreenMaterial = this.volumeMaterial
  }

  override dispose() {
    this.uniforms.noiseField.value.dispose()
    // The pass disposes its materials and render targets.
    super.dispose()
  }
}

function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
