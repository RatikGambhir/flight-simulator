import type { CloudsEffect } from '@takram/three-clouds'
import { Quaternion, Uniform, Vector3, type Camera, type RawShaderMaterial } from 'three'
import type { Effect } from 'postprocessing'

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
  // Stock haze fades out under clear skies (coverage < 0.2). Live weather can
  // report mist without cloud, so haze raised above the default always shows.
  source = replace(source, 'float modulation = remapClamped(coverage, 0.2, 0.4);',
    'float modulation = max(remapClamped(coverage, 0.2, 0.4), step(4e-5, hazeDensityScale));')
  clouds.fragmentShader = source
  shadow.fragmentShader = replace(shadow.fragmentShader,
    'weightedDistanceSum / transmittanceSum', 'weightedDistanceSum / max(transmittanceSum, 1e-7)')
  stabilizeResolve(effect.cloudsPass.resolveMaterial, false)
  stabilizeResolve(effect.shadowPass.resolveMaterial, true)
  effect.cloudsPass.resolveMaterial.uniforms.temporalAlpha.value = 0.2
  clouds.userData.geoflightStableClouds = true
}

/**
 * Invalidate both histories on cuts, teleports, resize and floating-origin changes.
 * Coverage easing towards live weather moves far less than 0.01 a frame and keeps its history.
 */
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
      width !== this.width || height !== this.height || Math.abs(effect.coverage - this.coverage) > 0.01 ||
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

const OVERLAY_UPSAMPLE = /* glsl */ `
#ifdef HAS_OVERLAY
// The clouds are marched at a fraction of the screen resolution, each texel against
// the scene depth at its centre. A plain bilinear fetch blends texels marched past
// the aircraft into the sky with texels that stopped at the aircraft, which drew a
// bright cloud fringe along the wings and fuselage. Weight the four nearest texels
// by how closely the depth they were marched against matches this pixel's.
vec4 sampleCloudOverlay(const vec2 uv) {
  vec2 size = vec2(textureSize(overlayBuffer, 0));
  vec2 st = uv * size - 0.5;
  vec2 base = floor(st);
  vec2 f = st - base;
  float center = readDepthValue(depthBuffer, uv);
  ivec2 last = ivec2(size) - 1;
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int j = 0; j < 2; ++j) {
    for (int i = 0; i < 2; ++i) {
      vec2 offset = vec2(float(i), float(j));
      float texelDepth = readDepthValue(depthBuffer, (base + offset + 0.5) / size);
      vec2 bilinear = mix(1.0 - f, f, offset);
      float weight = bilinear.x * bilinear.y * exp(-abs(texelDepth - center) * 300.0) + 1e-5;
      sum += weight * texelFetch(overlayBuffer, clamp(ivec2(base + offset), ivec2(0), last), 0);
      total += weight;
    }
  }
  return sum / total;
}
#endif // HAS_OVERLAY

void mainImage(`

/** Depth-aware upsampling of the cloud overlay where the aerial perspective composites it. */
export function stabilizeAerialPerspective(effect: Effect) {
  const target = effect as unknown as { getFragmentShader(): string; setFragmentShader(source: string): void }
  let source = target.getFragmentShader()
  if (source.includes('sampleCloudOverlay')) return
  source = replace(source, 'vec4 overlay = texture(overlayBuffer, uv);', 'vec4 overlay = sampleCloudOverlay(uv);')
  source = source.replace('void mainImage(', OVERLAY_UPSAMPLE)
  target.setFragmentShader(source)
}
