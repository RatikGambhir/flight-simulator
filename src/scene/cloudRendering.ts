import type { CloudsEffect } from '@takram/three-clouds'
import { Quaternion, Uniform, Vector3, type Camera, type RawShaderMaterial } from 'three'

// Compatibility fixes for @takram/three-clouds 0.7.6. Keep these at the
// material boundary, rather than editing node_modules (lost on npm install).
function replace(source: string, from: string, to: string) {
  if (!source.includes(from)) throw new Error(`Cloud shader changed: missing ${from}`)
  return source.replaceAll(from, to)
}

function stabilizeDensity(material: RawShaderMaterial) {
  let source = material.fragmentShader
  source = replace(source, 'sqrt(1.5 + m2.x - m2.y - 0.5 * sqrt(-24.0 * m2.x + q2))',
    'sqrt(max(0.0, 1.5 + m2.x - m2.y - 0.5 * sqrt(max(0.0, -24.0 * m2.x + q2))))')
  source = replace(source, 'media.weight = density / densitySum;', 'media.weight = density / max(densitySum, 1e-7);')
  material.fragmentShader = source
  material.needsUpdate = true
}

function stabilizeResolve(material: RawShaderMaterial, shadow: boolean) {
  let source = material.fragmentShader
  source = `uniform bool resetHistory;\n${source}`
  // Invalid history must never feed back into the next frame. A NaN survives
  // both clamp() and mix(), so rejection must happen before either operation.
  source = replace(source,
    'if (prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0)',
    'if (resetHistory || any(isnan(prevUv)) || any(isinf(prevUv)) || prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0)')
  const history = shadow ? 'vec4 history = texture(historyBuffer, vec3(prevUv, float(cascadeIndex)));' :
    'vec4 historyColor = texture(colorHistoryBuffer, prevUv);'
  source = replace(source, history, `${history}\n${shadow
    ? 'if (any(isnan(history)) || any(isinf(history))) history = current;'
    : 'if (any(isnan(historyColor)) || any(isinf(historyColor))) historyColor = currentColor;'}`)
  material.uniforms.resetHistory = new Uniform(true)
  material.fragmentShader = source
  material.needsUpdate = true
}

export function stabilizeClouds(effect: CloudsEffect) {
  const clouds = effect.cloudsPass.currentMaterial
  // Store the marker on the material: a module-local WeakSet is lost during
  // Fast Refresh while R3F can retain the already-patched effect instance.
  if (clouds.userData.geoflightStableClouds) return
  const shadow = effect.shadowPass.currentMaterial
  stabilizeDensity(clouds)
  stabilizeDensity(shadow)

  // RawShaderMaterial does not inherit Three's high precision sampler defaults.
  // Depth and motion textures must retain precision on the Metal/WebKit path.
  for (const material of [clouds, shadow, effect.cloudsPass.resolveMaterial, effect.shadowPass.resolveMaterial]) {
    material.fragmentShader = `precision highp sampler2D;\n${material.fragmentShader}`
  }

  let source = clouds.fragmentShader
  source = replace(source, 'uniform mat4 viewMatrix;', 'uniform mat4 viewMatrix;\nuniform mat4 inverseViewMatrix;')
  source = replace(source, 'vec3 frontPositionWorld = ecefToWorld(frontPosition);',
    'vec3 frontPositionWorld = inverseViewMatrix[3].xyz + mat3(ecefToWorldMatrix) * (frontDepth * rayDirection);')
  // At Earth-sized coordinates a sub-metre segment can round to zero. Avoid
  // normalizing that zero vector inside the atmospheric scattering lookup.
  source = replace(source, 'applyAerialPerspective(cameraPosition, frontPosition, shadowLength, color);',
    'if (frontDepth > 1.0) applyAerialPerspective(cameraPosition, frontPosition, shadowLength, color);')
  // Motion depth is stored in RGBA16F: a 20,000 km far plane overflows it.
  source = replace(source, 'outputDepthVelocity = depthVelocity;', 'outputDepthVelocity = vec3(min(depthVelocity.x, 65000.0), depthVelocity.yz);')
  clouds.fragmentShader = source
  shadow.fragmentShader = replace(shadow.fragmentShader,
    'weightedDistanceSum / transmittanceSum', 'weightedDistanceSum / max(transmittanceSum, 1e-7)')
  stabilizeResolve(effect.cloudsPass.resolveMaterial, false)
  stabilizeResolve(effect.shadowPass.resolveMaterial, true)
  effect.cloudsPass.resolveMaterial.uniforms.temporalAlpha.value = 0.2
  clouds.userData.geoflightStableClouds = true
}

/** Invalidate both histories on cuts, teleports, resize and floating-origin changes. */
export class CloudHistory {
  private effect: CloudsEffect | null = null
  private origin = -1
  private width = 0
  private height = 0
  private coverage = -1
  private mode = ''
  private quality = ''
  private readonly position = new Vector3()
  private readonly rotation = new Quaternion()

  update(effect: CloudsEffect, camera: Camera, origin: number, mode: string, quality: string) {
    const { width, height } = effect.resolution
    const reset = effect !== this.effect || origin !== this.origin || mode !== this.mode || quality !== this.quality ||
      width !== this.width || height !== this.height || effect.coverage !== this.coverage ||
      this.position.distanceToSquared(camera.position) > 100 * 100 ||
      Math.abs(this.rotation.dot(camera.quaternion)) < 0.9
    effect.cloudsPass.resolveMaterial.uniforms.resetHistory.value = reset
    effect.shadowPass.resolveMaterial.uniforms.resetHistory.value = reset
    this.effect = effect
    this.origin = origin
    this.mode = mode
    this.quality = quality
    this.width = width
    this.height = height
    this.coverage = effect.coverage
    this.position.copy(camera.position)
    this.rotation.copy(camera.quaternion)
  }
}
