import type { CloudsEffect } from '@takram/three-clouds'
import type { AerialPerspectiveEffect } from '@takram/three-atmosphere'
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

/**
 * Temporal upscaling marches one pixel of every 4x4 block per frame and rebuilds
 * the rest from reprojected history. The stock resolve breaks down in motion: in
 * a turn the freshly marched pixels stand out against lagging history as a 4x4
 * dot pattern, history ghosts cloud onto the aircraft as it rolls, and rejected
 * pixels show one low-resolution texel per 4x4 block.
 *
 * This resolve keeps the stock path where the image is steady, and otherwise
 * leans on a depth-aware, jitter-aligned reconstruction of the current frame
 * (the same weighting the overlay upsample uses), accumulated against clipped
 * history so it stays temporally stable. Near geometry (the aircraft, the ground
 * on approach) never trusts history.
 */
const UPSCALE_RESOLVE = /* glsl */ `
uniform highp sampler2D sceneDepthBuffer;
uniform float nearHistoryDepth;

// Weights for the four low-resolution texels around uv. Each texel was marched at
// this frame's jittered position, against the scene depth found there.
void upscaleWeights(const vec2 uv, const float center, out ivec2 base, out vec4 weights) {
  vec2 lowSize = vec2(textureSize(colorBuffer, 0));
  vec2 st = (uv - jitterOffset * texelSize) * lowSize - 0.5;
  vec2 cell = floor(st);
  vec2 f = st - cell;
  base = ivec2(cell);
  for (int i = 0; i < 4; ++i) {
    vec2 offset = vec2(float(i & 1), float(i >> 1));
    vec2 marched = (cell + offset + 0.5) / lowSize + jitterOffset * texelSize;
    float depth = texture(sceneDepthBuffer, clamp(marched, vec2(0.0), vec2(1.0))).r;
    vec2 bilinear = mix(1.0 - f, f, offset);
    weights[i] = bilinear.x * bilinear.y * exp(-abs(depth - center) * 300.0) + 1e-5;
  }
  weights /= weights.x + weights.y + weights.z + weights.w;
}

vec4 upscaleFetch(const sampler2D buffer, const ivec2 base, const vec4 weights) {
  ivec2 last = textureSize(buffer, 0) - 1;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 4; ++i) {
    sum += weights[i] * texelFetch(buffer, clamp(base + ivec2(i & 1, i >> 1), ivec2(0), last), 0);
  }
  return sum;
}

void temporalUpscale(
  const ivec2 coord,
  const ivec2 lowResCoord,
  const bool currentFrame,
  out vec4 outputColor,
  out float outputShadowLength
) {
  vec4 currentColor = texelFetch(colorBuffer, lowResCoord, 0);
  float center = texture(sceneDepthBuffer, vUv).r;
  ivec2 base;
  vec4 weights;
  upscaleWeights(vUv, center, base, weights);
  // Each sample is a single noisy march, so this is only a stand-in where history
  // is unusable, and a gentle pull in motion; accumulation still does the denoising.
  vec4 spatialColor = upscaleFetch(colorBuffer, base, weights);
  #ifdef SHADOW_LENGTH
  vec4 currentShadowLength = vec4(texelFetch(shadowLengthBuffer, lowResCoord, 0).rgb, 1.0);
  float spatialShadowLength = upscaleFetch(shadowLengthBuffer, base, weights).r;
  #endif // SHADOW_LENGTH

  vec4 depthVelocity = getClosestFragment(lowResCoord);
  vec2 velocity = depthVelocity.gb;
  vec2 prevUv = vUv - velocity;
  if (resetHistory || center < nearHistoryDepth || any(isnan(prevUv)) || any(isinf(prevUv)) ||
      prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0) {
    outputColor = spatialColor;
    #ifdef SHADOW_LENGTH
    outputShadowLength = spatialShadowLength;
    #endif // SHADOW_LENGTH
    return; // Rejection
  }

  // 0 while the image is steady, 1 once it moves a few pixels per frame.
  float moving = smoothstep(0.5, 3.0, length(velocity / texelSize));
  vec4 historyColor = texture(colorHistoryBuffer, prevUv);
  if (any(isnan(historyColor)) || any(isinf(historyColor))) historyColor = spatialColor;
  vec4 clippedColor = varianceClipping(colorBuffer, vUv, currentColor, historyColor, varianceGamma);
  // A fresh sample keeps a little history, so it cannot pop out of stale neighbours.
  vec4 settled = currentFrame ? mix(clippedColor, currentColor, 0.8) : clippedColor;
  outputColor = mix(settled, mix(clippedColor, spatialColor, 0.2), moving);

  #ifdef SHADOW_LENGTH
  vec4 historyShadowLength = vec4(texture(shadowLengthHistoryBuffer, prevUv).rgb, 1.0);
  if (isnan(historyShadowLength.r) || isinf(historyShadowLength.r)) historyShadowLength = currentShadowLength;
  float clippedShadowLength = varianceClipping(shadowLengthBuffer, vUv, currentShadowLength, historyShadowLength, varianceGamma).r;
  float settledShadowLength = currentFrame ? mix(clippedShadowLength, currentShadowLength.r, 0.8) : clippedShadowLength;
  outputShadowLength = mix(settledShadowLength, mix(clippedShadowLength, spatialShadowLength, 0.2), moving);
  #endif // SHADOW_LENGTH
}

`

function upscaleResolve(source: string) {
  const start = source.indexOf('void temporalUpscale(')
  const end = source.indexOf('void temporalAntialiasing(')
  if (start < 0 || end < start) throw new Error('Cloud shader changed: missing temporalUpscale')
  return source.slice(0, start) + UPSCALE_RESOLVE + source.slice(end)
}

/** Feed the upscale resolve the scene depth the march used and the near-history cutoff. */
function syncUpscaleInputs(effect: CloudsEffect, camera: Camera) {
  const resolve = effect.cloudsPass.resolveMaterial.uniforms
  if (!resolve.sceneDepthBuffer) return
  resolve.sceneDepthBuffer.value = effect.cloudsPass.currentMaterial.uniforms.depthBuffer.value
  const far = (camera as Camera & { far?: number }).far ?? 2e7
  // The aircraft (and cockpit) sit well inside 400 m of the camera; terrain below does not.
  resolve.nearHistoryDepth.value = Math.log2(1 + NEAR_HISTORY_M) / Math.log2(far + 1)
}
const NEAR_HISTORY_M = 400

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
  if (!shadow) {
    // The library has already unrolled these neighborhoods. Clamp their
    // integer coordinates at the edge before reading motion or color.
    source = source.replace(/texelFetchOffset\((depthVelocityBuffer|inputBuffer), coord, 0, ((?:neighborOffsets|varianceOffsets)\[\d+\])\)/g,
      'texelFetch($1, clamp(coord + $2, ivec2(0), textureSize($1, 0) - 1), 0)')
    const shadowHistory = 'vec4 historyShadowLength = vec4(texture(shadowLengthHistoryBuffer, prevUv).rgb, 1.0);'
    source = replace(source, shadowHistory, `${shadowHistory}\n  if (isnan(historyShadowLength.r) || isinf(historyShadowLength.r)) historyShadowLength = currentShadowLength;`)
  }
  if (!shadow) {
    source = upscaleResolve(source)
    material.uniforms.sceneDepthBuffer = new Uniform(null)
    material.uniforms.nearHistoryDepth = new Uniform(0)
    // The stock gamma of 2 lets stale history linger for the 16 frames between a
    // pixel's own samples, which reads as a dot pattern while turning.
    material.uniforms.varianceGamma.value = 1.25
  }
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
  source = `uniform highp float nightLighting;\nuniform highp float moonPhase;\nuniform highp vec3 nightMoonDirection;\n${source}`
  source = replace(source, 'float getViewZ(', /* glsl */ `
float solarVisibility() {
  return smoothstep(-0.26, -0.12, dot(normalize(vCameraPosition + altitudeCorrection), sunDirection));
}

float getViewZ(`)
  source = replace(source, 'float sunRayDistance = 0.0;\n      float opticalDepth = marchOpticalDepth(\n        position,\n        sunDirection,', /* glsl */ `
      // Reuse the lighting ray for the dominant sky illumination after twilight.
      float moonElevation = dot(nightMoonDirection, surfaceNormal);
      float moon = moonPhase * smoothstep(0.0, 0.15, moonElevation);
      float nightDepthWeight = smoothstep(0.82, 1.0, nightLighting);
      vec3 nightLightDirection = normalize(mix(surfaceNormal, nightMoonDirection, moon * 0.7));
      vec3 lightDirection = normalize(mix(sunDirection, nightLightDirection, nightDepthWeight));
      float sunRayDistance = 0.0;
      float opticalDepth = marchOpticalDepth(
        position,
        lightDirection,`)
  source = replace(source, 'if (height < shadowTopHeight) {\n        // Obtain the optical depth from BSM at the ray position.\n        opticalDepth += sampleShadowOpticalDepth(', /* glsl */ `
      if (height < shadowTopHeight && nightDepthWeight < 1.0) {
        // The shadow cascades follow the sun, so they only shade its contribution.
        opticalDepth += (1.0 - nightDepthWeight) * sampleShadowOpticalDepth(`)
  source = replace(source, 'radiance *= media.scattering;', /* glsl */ `
      if (nightLighting > 0.001) {
        // Light the volume before integrating extinction, so thin edges and
        // denser interiors react differently even on a moonless night.
        float body = media.extinction * 125.0;
        float skyTransmission = mix(exp(-0.8 * body), exp(-0.9 * opticalDepth), nightDepthWeight);
        float skyFill = mix(0.60, 1.24, skyGradient) * mix(0.36, 1.0, skyTransmission);
        vec3 nightRadiance = vec3(0.0030, 0.00365, 0.00465) * skyFill;
        if (moon > 0.001) {
          float moonOpticalDepth = mix(body / max(0.22, moonElevation), opticalDepth, nightDepthWeight);
          float moonAngle = dot(nightMoonDirection, rayDirection);
          float moonScatter = min(1.0, approximateMultipleScattering(moonOpticalDepth, moonAngle) * 4.0);
          nightRadiance += vec3(0.0030, 0.0037, 0.0048) * moon * moonScatter;
        }
        radiance += nightLighting * nightRadiance;
      }
      radiance *= media.scattering;`)
  source = replace(source, 'vec3 frontPositionWorld = ecefToWorld(frontPosition);',
    'vec3 frontPositionWorld = inverseViewMatrix[3].xyz + mat3(ecefToWorldMatrix) * (frontDepth * rayDirection);')
  source = replace(source, 'color.rgb = color.rgb * transmittance + inscatter * color.a;',
    'color.rgb = color.rgb * transmittance + max(inscatter, vec3(0.0)) * color.a;')
  // At Earth-sized coordinates a sub-metre segment can round to zero. Avoid
  // normalizing that zero vector inside the atmospheric scattering lookup.
  source = replace(source, 'applyAerialPerspective(cameraPosition, frontPosition, shadowLength, color);',
    /* glsl */ `if (frontDepth > 1.0) applyAerialPerspective(cameraPosition, frontPosition, shadowLength, color);
      // Apply night haze at cloud depth, independently of the background surface.
      float nightHaze = nightLighting * (1.0 - exp(-max(0.0, frontDepth) / 65000.0));
      color.rgb = mix(color.rgb, color.a * vec3(0.0012, 0.0016, 0.00235), nightHaze);`)
  source = replace(source, 'depth = reverseLogDepth(depth, cameraNear, cameraFar);\n    viewZ = getViewZ(depth);', /* glsl */ `
    #if defined(USE_LOGDEPTHBUF) || defined(USE_LOGARITHMIC_DEPTH_BUFFER)
    viewZ = 1.0 - exp2(depth * log2(cameraFar + 1.0));
    #else
    viewZ = getViewZ(depth);
    #endif`)
  // Motion depth is stored in RGBA16F: a 20,000 km far plane overflows it.
  source = replace(source, 'outputDepthVelocity = depthVelocity;', 'outputDepthVelocity = vec3(min(depthVelocity.x, 65000.0), depthVelocity.yz);')
  // Stock haze fades out under clear skies (coverage < 0.2). Live weather can
  // report mist without cloud, so haze raised above the default always shows.
  source = replace(source, 'float modulation = remapClamped(coverage, 0.2, 0.4);',
    'float modulation = max(remapClamped(coverage, 0.2, 0.4), step(4e-5, hazeDensityScale));')
  source = replace(source, 'if (cameraHeight * modulation < 0.0) {',
    'if (maxRayDistance <= 0.0 || cameraHeight * modulation < 0.0) {')
  // From above the weather, the haze starts at the entry to the cloud shell.
  // At the tangent the entry and exit meet, so the haze fades out with its path length.
  source = replace(source, `} else {
    nearFar = vec2(cameraNear, intersections.second.z);
    if (intersections.ground) {`, `} else {
    nearFar = vec2(max(cameraNear, intersections.first.z), intersections.second.z);
    if (intersections.ground) {`)
  source = replace(source, 'cameraNear * rayDirection + cameraPosition,\n    rayDirection,\n    hazeRayNearFar.y - hazeRayNearFar.x,',
    'hazeRayNearFar.x * rayDirection + cameraPosition,\n    rayDirection,\n    hazeRayNearFar.y - hazeRayNearFar.x,')
  // NightEffect already supplies airglow. Solar weather haze must not cut a
  // second silhouette over it when the weather shell meets the horizon.
  source = replace(source, 'return vec4(inscatter, transmittance);',
    'return vec4(inscatter, transmittance * solarVisibility());')
  source = replace(source, 'if (all(greaterThanEqual(shadowRayNearFar, vec2(0.0)))) {',
    'if (solarVisibility() > 0.0 && all(greaterThanEqual(shadowRayNearFar, vec2(0.0)))) {')
  source = replace(source, 'outputColor = color;', /* glsl */ `
  outputColor = any(isnan(color)) || any(isinf(color)) ? vec4(0.0) : color;`)
  clouds.fragmentShader = source
  clouds.uniforms.nightLighting = new Uniform(0)
  clouds.uniforms.moonPhase = new Uniform(0)
  clouds.uniforms.nightMoonDirection = new Uniform(new Vector3(0, 0, 1))
  shadow.fragmentShader = replace(shadow.fragmentShader,
    'weightedDistanceSum / transmittanceSum', 'weightedDistanceSum / max(transmittanceSum, 1e-7)')
  stabilizeResolve(effect.cloudsPass.resolveMaterial, false)
  stabilizeResolve(effect.shadowPass.resolveMaterial, true)
  effect.cloudsPass.resolveMaterial.uniforms.temporalAlpha.value = 0.2
  clouds.userData.geoflightStableClouds = true
}

export function setCloudNightLighting(effect: CloudsEffect, darkness: number, moonDirection: Vector3, moonPhase: number) {
  const { uniforms } = effect.cloudsPass.currentMaterial
  uniforms.nightLighting.value = darkness
  uniforms.moonPhase.value = moonPhase ** 1.7
  ;(uniforms.nightMoonDirection.value as Vector3).copy(moonDirection)
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
  private darkness = -1
  private mode = ''
  private quality = ''
  private readonly position = new Vector3()
  private readonly rotation = new Quaternion()
  private readonly sunDirection = new Vector3()

  update(effect: CloudsEffect, camera: Camera, origin: number, mode: string, quality: string) {
    const { width, height } = effect.resolution
    const darkness = (effect.cloudsPass.currentMaterial.uniforms.nightLighting?.value as number | undefined) ?? 0
    const reset = effect !== this.effect || origin !== this.origin || mode !== this.mode || quality !== this.quality ||
      width !== this.width || height !== this.height || Math.abs(effect.coverage - this.coverage) > 0.01 ||
      Math.abs(darkness - this.darkness) > 0.05 ||
      this.sunDirection.distanceToSquared(effect.sunDirection) > 0.0025 ||
      this.position.distanceToSquared(camera.position) > 100 * 100 ||
      Math.abs(this.rotation.dot(camera.quaternion)) < 0.9
    syncUpscaleInputs(effect, camera)
    effect.cloudsPass.resolveMaterial.uniforms.resetHistory.value = reset
    effect.shadowPass.resolveMaterial.uniforms.resetHistory.value = reset
    this.effect = effect
    this.origin = origin
    this.mode = mode
    this.quality = quality
    this.width = width
    this.height = height
    this.coverage = effect.coverage
    this.darkness = darkness
    this.position.copy(camera.position)
    this.rotation.copy(camera.quaternion)
    this.sunDirection.copy(effect.sunDirection)
  }
}

const OVERLAY_UPSAMPLE = /* glsl */ `
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
`

function setEffectFragment(effect: Effect, source: string) {
  const target = effect as unknown as { setFragmentShader(source: string): void }
  target.setFragmentShader(source)
}

export function stabilizeNightClouds(effect: Effect) {
  const source = effect.getFragmentShader()
  if (source.includes('sampleCloudOverlay')) return
  const sampling = OVERLAY_UPSAMPLE.replaceAll('overlayBuffer', 'cloudOverlay').replaceAll('readDepthValue(depthBuffer, ', 'sceneDepth(')
  setEffectFragment(effect, replace(source, 'float cloudTransmission(', `${sampling}\nfloat cloudTransmission(`)
    .replace('texture2D(cloudOverlay, uv).a', 'sampleCloudOverlay(uv).a'))
}

/** Keep the aerial shader's inputs in sync with the cloud pass that just rendered. */
function syncAerialInputs(effect: AerialPerspectiveEffect, getClouds?: () => CloudsEffect | null) {
  const update = effect.update
  const inputs = effect as unknown as {
    updateOverlay(): boolean
    updateShadow(): boolean
    updateShadowLength(): boolean
    updateLightingMask(): boolean
    setChanged(): void
  }
  effect.update = (...args) => {
    if (getClouds) {
      const clouds = getClouds()
      effect.overlay = clouds?.atmosphereOverlay ?? null
      effect.shadow = clouds?.atmosphereShadow ?? null
      effect.shadowLength = clouds?.atmosphereShadowLength ?? null
    }

    const { defines, overlay, shadow, shadowLength, lightingMask } = effect
    if (defines.has('HAS_OVERLAY') !== (overlay != null) ||
      defines.has('HAS_SHADOW') !== (shadow != null) ||
      defines.has('HAS_SHADOW_LENGTH') !== (shadowLength != null) ||
      defines.has('HAS_LIGHTING_MASK') !== (lightingMask != null) ||
      (shadow != null && defines.get('SHADOW_CASCADE_COUNT') !== `${shadow.cascadeCount}`)) {
      // The upstream update short-circuits after the first shader-define change.
      // Set them together so a toggle never leaves disposed shadow buffers bound.
      inputs.updateOverlay()
      inputs.updateShadow()
      inputs.updateShadowLength()
      inputs.updateLightingMask()
      inputs.setChanged()
    }
    update.apply(effect, args)
  }
}

/** Depth-aware upsampling of the cloud overlay where the aerial perspective composites it. */
export function stabilizeAerialPerspective(effect: AerialPerspectiveEffect, getClouds?: () => CloudsEffect | null) {
  let source = effect.getFragmentShader()
  if (source.includes('sampleCloudOverlay')) return
  source = replace(source, `#ifdef HAS_OVERLAY
  vec4 overlay = texture(overlayBuffer, uv);
  if (overlay.a == 1.0) {
    outputColor = overlay;
    return;
  }
  #endif // HAS_OVERLAY`, '')
  source = replace(source, 'void mainImage(', `#ifdef HAS_OVERLAY\n${OVERLAY_UPSAMPLE}\n#endif\n\nvoid mainImage(`)
  source = replace(source, 'float depth = readDepthValue(depthBuffer, uv);\n  if (depth >= 1.0 - 1e-8) {', /* glsl */ `
  float depth = readDepthValue(depthBuffer, uv);
  // Compute derivatives before branching on depth. At silhouettes the 2x2
  // quad may include sky or foreground geometry, so reject large depth jumps.
  #if defined(USE_LOGDEPTHBUF) || defined(USE_LOGARITHMIC_DEPTH_BUFFER)
  float viewZ = 1.0 - exp2(depth * log2(cameraFar + 1.0));
  vec3 viewRay = (inverseProjectionMatrix * vec4(uv * 2.0 - 1.0, 1.0, 1.0)).xyz;
  vec3 viewPosition = viewRay * (viewZ / viewRay.z);
  #else
  float viewZ = getViewZ(depth);
  vec3 viewPosition = screenToView(uv, depth, viewZ, projectionMatrix, inverseProjectionMatrix);
  #endif
  #ifdef RECONSTRUCT_NORMAL
  vec3 depthNormal = cross(dFdx(viewPosition), dFdy(viewPosition));
  float normalLength = length(depthNormal);
  bool validDepthNormal = fwidth(viewZ) < max(2.0, -0.035 * viewZ) && normalLength > 0.0;
  #endif
  #ifdef HAS_OVERLAY
  vec4 overlay = sampleCloudOverlay(uv);
  if (overlay.a >= 1.0) {
    outputColor = overlay;
    return;
  }
  #endif
  if (depth >= 1.0) {`)
  source = replace(source, `depth = reverseLogDepth(depth, cameraNear, cameraFar);

  // Reconstruct position and normal in world space.
  vec3 viewPosition = screenToView(
    uv,
    depth,
    getViewZ(depth),
    projectionMatrix,
    inverseProjectionMatrix
  );`, '')
  source = replace(source, `vec3 dVPdx = dFdx(viewPosition);
  vec3 dVPdy = dFdy(viewPosition);
  viewNormal = normalize(cross(dVPdx, dVPdy));`, /* glsl */ `
  degenerateNormal = !validDepthNormal;
  viewNormal = validDepthNormal ? depthNormal / normalLength : vec3(0.0);`)
  source = replace(source, 'vec3 normalECEF = (worldToECEFMatrix * vec4(worldNormal, 0.0)).xyz;', /* glsl */ `
  vec3 normalECEF = degenerateNormal || !(dot(viewNormal, viewNormal) > 0.0)
    ? normalize(positionECEF / vEllipsoidRadiiSquared)
    : normalize((worldToECEFMatrix * vec4(worldNormal, 0.0)).xyz);`)
  source = replace(source, `if (!degenerateNormal) {
    radiance = getSunSkyIrradiance(positionECEF, normalECEF, inputColor.rgb, sunTransmittance);
  } else {
    radiance = inputColor.rgb;
  }`, /* glsl */ `
  // Finite scene depth belongs to a surface. A missing normal must not
  // make streamed satellite albedo bypass lighting as if it were a star.
  radiance = getSunSkyIrradiance(positionECEF, normalECEF, inputColor.rgb, sunTransmittance);`)
  source = replace(source, 'vec3 transmittance;\n  vec3 inscatter = GetSkyRadianceToPoint(', /* glsl */ `
  if (length(positionECEF - vCameraPosition) < 0.001) return;
  vec3 transmittance;
  vec3 inscatter = GetSkyRadianceToPoint(`)
  source = replace(source, 'radiance = radiance + inscatter;',
    'radiance += max(inscatter, vec3(0.0));')
  setEffectFragment(effect, source)
  syncAerialInputs(effect, getClouds)
}
