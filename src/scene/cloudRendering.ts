import type { CloudsEffect } from '@takram/three-clouds'
import { Quaternion, Uniform, Vector3, type Camera, type RawShaderMaterial, type WebGLRenderer, type WebGLRenderTarget } from 'three'
import type { Effect } from 'postprocessing'

// Compatibility fixes for @takram/three-clouds 0.7.6. Keep these at the
// material boundary, rather than editing node_modules (lost on npm install).
function replace(source: string, from: string, to: string) {
  if (!source.includes(from)) throw new Error(`Cloud shader changed: missing ${from}`)
  return source.replaceAll(from, to)
}

// Visit four output pixels in turn. The phase in the march and in the resolve
// must describe the same ray, including at odd framebuffer sizes.
const QUARTER_RESOLVE = /* glsl */ `
uniform highp sampler2D sceneDepthBuffer;
uniform float nearHistoryDepth;

void temporalUpscale(
  const bool currentFrame,
  out vec4 outputColor,
  out float outputShadowLength
) {
  vec2 lowSize = vec2(textureSize(colorBuffer, 0));
  vec2 jitter = jitterOffset * texelSize;
  vec2 cell = floor((vUv - jitter) * lowSize - 0.5);
  ivec2 last = ivec2(lowSize) - 1;
  float sceneDepth = texture(sceneDepthBuffer, vUv).r;
  vec4 current = vec4(0.0);
  vec4 square = vec4(0.0);
  vec2 velocity = vec2(0.0);
  float total = 0.0;
  #ifdef SHADOW_LENGTH
  float shaft = 0.0;
  float shaftSquare = 0.0;
  #endif
  for (int i = 0; i < 4; ++i) {
    ivec2 tap = clamp(ivec2(cell) + ivec2(i & 1, i >> 1), ivec2(0), last);
    vec2 uv = (vec2(tap) + 0.5) / lowSize + jitter;
    float depth = texture(sceneDepthBuffer, uv).r;
    vec2 tent = max(vec2(0.0), 1.0 - abs((vUv - uv) * lowSize));
    float weight = tent.x * tent.y * exp(-abs(sceneDepth - depth) * 300.0) + 1e-5;
    vec4 sampleColor = texelFetch(colorBuffer, tap, 0);
    current += weight * sampleColor;
    square += weight * sampleColor * sampleColor;
    velocity += weight * texelFetch(depthVelocityBuffer, tap, 0).gb;
    #ifdef SHADOW_LENGTH
    float sampleShaft = texelFetch(shadowLengthBuffer, tap, 0).r;
    shaft += weight * sampleShaft;
    shaftSquare += weight * sampleShaft * sampleShaft;
    #endif
    total += weight;
  }
  current /= total;
  velocity /= total;
  #ifdef SHADOW_LENGTH
  shaft /= total;
  #endif
  vec2 previousUv = vUv - velocity;
  bool rejected = resetHistory || sceneDepth < nearHistoryDepth ||
    any(isnan(previousUv)) || any(isinf(previousUv)) ||
    any(lessThan(previousUv, vec2(0.0))) || any(greaterThan(previousUv, vec2(1.0)));
  if (rejected) {
    outputColor = current;
    #ifdef SHADOW_LENGTH
    outputShadowLength = shaft;
    #endif
    return;
  }

  // Give each channel a minimum spread. At a marched texel the spatial
  // filter has nearly zero variance, so hard clipping would expose the grid.
  float blend = currentFrame ? 0.55 : mix(0.16, 0.38, smoothstep(0.5, 3.0, length(velocity / texelSize)));
  vec4 historyColor = texture(colorHistoryBuffer, previousUv);
  vec4 spread = 2.0 * sqrt(max(vec4(0.0), square / total - current * current)) + vec4(0.001, 0.001, 0.001, 0.05);
  if (any(isnan(historyColor)) || any(isinf(historyColor))) historyColor = current;
  outputColor = mix(clamp(historyColor, current - spread, current + spread), current, blend);
  #ifdef SHADOW_LENGTH
  float historyShaft = texture(shadowLengthHistoryBuffer, previousUv).r;
  float shaftSpread = 2.0 * sqrt(max(0.0, shaftSquare / total - shaft * shaft)) + 0.05;
  if (isnan(historyShaft) || isinf(historyShaft)) historyShaft = shaft;
  outputShadowLength = mix(clamp(historyShaft, shaft - shaftSpread, shaft + shaftSpread), shaft, blend);
  #endif
}
`

function interleaveClouds(effect: CloudsEffect) {
  const pass = effect.cloudsPass
  const march = pass.currentMaterial
  const resolve = pass.resolveMaterial
  const targets = pass as unknown as {
    width: number
    height: number
    currentRenderTarget: WebGLRenderTarget
    resolveRenderTarget: WebGLRenderTarget
    historyRenderTarget: WebGLRenderTarget
  }
  const setSize = pass.setSize
  pass.setSize = function (width, height) {
    if (!pass.temporalUpscale) {
      setSize.call(this, width, height)
      return
    }
    targets.width = width
    targets.height = height
    const evenWidth = Math.ceil(width / 2) * 2
    const evenHeight = Math.ceil(height / 2) * 2
    targets.currentRenderTarget.setSize(evenWidth / 2, evenHeight / 2)
    targets.resolveRenderTarget.setSize(evenWidth, evenHeight)
    targets.historyRenderTarget.setSize(evenWidth, evenHeight)
    march.setSize(evenWidth, evenHeight)
    resolve.setSize(evenWidth, evenHeight)
  }

  const copyCamera = march.copyCameraSettings
  march.copyCameraSettings = function (camera) {
    copyCamera.call(this, camera)
    if (!march.temporalUpscale) return
    const { frame, inverseProjectionMatrix, temporalJitter, reprojectionMatrix, viewReprojectionMatrix,
      inverseViewMatrix, resolution, mipLevelScale } = march.uniforms
    const phase = frame.value % 4
    const x = jitterForPhase(phase, 0) / resolution.value.x
    const y = jitterForPhase(phase, 1) / resolution.value.y
    // The library applies its 4x4 jitter first. Replace it while preserving
    // the previous projection, including changes of FOV and near plane.
    const previous = march as unknown as { previousProjectionMatrix?: Camera['projectionMatrix']; previousViewMatrix?: Camera['matrixWorldInverse'] }
    const previousProjection = previous.previousProjectionMatrix ?? camera.projectionMatrix
    const previousView = previous.previousViewMatrix ?? camera.matrixWorldInverse
    temporalJitter.value.set(x, y)
    inverseProjectionMatrix.value.copy(camera.projectionMatrix)
    inverseProjectionMatrix.value.elements[8] += 2 * x
    inverseProjectionMatrix.value.elements[9] += 2 * y
    inverseProjectionMatrix.value.invert()
    reprojectionMatrix.value.copy(previousProjection)
    reprojectionMatrix.value.elements[8] += 2 * x
    reprojectionMatrix.value.elements[9] += 2 * y
    reprojectionMatrix.value.multiply(previousView)
    viewReprojectionMatrix.value.copy(reprojectionMatrix.value).multiply(inverseViewMatrix.value)
    // Estimate the cloud LOD at the density of the finished image.
    mipLevelScale.value = 0.5
  }
  const beforeResolve = resolve.onBeforeRender
  resolve.onBeforeRender = function (...args) {
    beforeResolve.apply(this, args)
    if (pass.temporalUpscale) {
      const phase = resolve.uniforms.frame.value % 4
      resolve.uniforms.jitterOffset.value.set(jitterForPhase(phase, 0), jitterForPhase(phase, 1))
    }
  }
  let source = resolve.fragmentShader
  const start = source.indexOf('void temporalUpscale(')
  const end = source.indexOf('void temporalAntialiasing(')
  if (start < 0 || end < start) throw new Error('Cloud shader changed: missing temporalUpscale')
  source = source.slice(0, start) + QUARTER_RESOLVE + source.slice(end)
  source = replace(source, `ivec2 lowResCoord = coord / 4;
  int bayerValue = bayerIndices[coord.x % 4][coord.y % 4];
  bool currentFrame = bayerValue == frame % 16;`,
    'bool currentFrame = ivec2(jitterOffset + 0.5) == coord % 2;')
  resolve.fragmentShader = replace(source, 'temporalUpscale(coord, lowResCoord, currentFrame, outputColor, outputShadowLength);',
    'temporalUpscale(currentFrame, outputColor, outputShadowLength);')
  resolve.uniforms.sceneDepthBuffer = march.uniforms.depthBuffer
  resolve.uniforms.nearHistoryDepth = new Uniform(0)
  resolve.needsUpdate = true
}

function jitterForPhase(phase: number, axis: 0 | 1) {
  // Move diagonally on the first two phases, then visit the opposite pair.
  const y = phase & 1
  return (axis === 0 ? y ^ (phase >> 1) : y) - 0.5
}

/** Keep a fitted shadow map and its matrices together for two flight frames. */
function reuseCloudShadows(effect: CloudsEffect) {
  const maps = effect.shadowMaps
  const pass = effect.shadowPass
  const fit = maps.update
  const draw = pass.update
  // The library looks up the GL texture before binding the array target.
  // Allocate it on the first draw and after a shadow-map resize.
  for (const stage of [pass.currentPass, pass.resolvePass]) {
    const render = stage.render
    stage.render = function (renderer, input, output, ...args) {
      renderer.setRenderTarget(output)
      render.call(this, renderer, input, output, ...args)
    }
  }
  let reuse = false
  let canReuse = false
  let lastWidth = 0
  let lastHeight = 0
  let lastCascades = 0
  let lastCoverage = -1
  const lastSun = new Vector3()
  maps.update = function (...args) {
    // Camera cuts and origin changes are signalled by the history controller.
    // Reuse only on a short frame so shadows don't linger through a long hitch.
    const reset = pass.resolveMaterial.uniforms.resetHistory.value
    reuse = effect.temporalUpscale && canReuse && !reset &&
      lastWidth === maps.mapSize.x && lastHeight === maps.mapSize.y && lastCascades === maps.cascadeCount &&
      Math.abs(lastCoverage - effect.coverage) < 0.002 &&
      lastSun.distanceToSquared(effect.sunDirection) < 1e-8
    if (!reuse) fit.apply(this, args)
  }
  pass.update = function (renderer: WebGLRenderer, frame: number, deltaTime: number) {
    if (!reuse) {
      draw.call(this, renderer, frame, deltaTime)
      lastWidth = maps.mapSize.x
      lastHeight = maps.mapSize.y
      lastCascades = maps.cascadeCount
      lastCoverage = effect.coverage
      lastSun.copy(effect.sunDirection)
    }
    canReuse = !reuse && deltaTime > 0 && deltaTime < 0.06
  }
}

function stabilizeDensity(material: RawShaderMaterial) {
  let source = material.fragmentShader
  source = replace(source, 'sqrt(1.5 + m2.x - m2.y - 0.5 * sqrt(-24.0 * m2.x + q2))',
    'sqrt(max(0.0, 1.5 + m2.x - m2.y - 0.5 * sqrt(max(0.0, -24.0 * m2.x + q2))))')
  source = replace(source, 'media.weight = density / densitySum;', 'media.weight = density / max(densitySum, 1e-7);')
  source = replace(source, '  vec4 density = weather.density;', /* glsl */ `
  vec4 density = weather.density;
  if (!any(greaterThan(density, vec4(0.0)))) {
    MediaSample empty;
    empty.density = 0.0;
    empty.weight = vec4(0.0);
    empty.scattering = 0.0;
    empty.extinction = 0.0;
    return empty;
  }`)
  // Zero-weight turbulence and the default unit weather exponents cannot
  // affect the sample. Keep the general paths for custom cloud layers.
  source = replace(source, `  vec4 localWeather = pow(
    textureLod(
      localWeatherTexture,
      uv * localWeatherRepeat + localWeatherOffset,
      mipLevel
    ).LOCAL_WEATHER_CHANNELS,
    weatherExponents
  );`, `  vec4 localWeather = textureLod(
    localWeatherTexture, uv * localWeatherRepeat + localWeatherOffset, mipLevel
  ).LOCAL_WEATHER_CHANNELS;
  if (any(notEqual(weatherExponents, vec4(1.0)))) localWeather = pow(localWeather, weatherExponents);`)
  source = replace(source, `  turbulence =
    turbulenceDisplacement *
    (texture(turbulenceTexture, turbulenceUv).rgb * 2.0 - 1.0) *
    dot(density, remapClamped(weather.heightFraction, vec4(0.3), vec4(0.0)));`, `
  float turbulenceWeight = dot(density, remapClamped(weather.heightFraction, vec4(0.3), vec4(0.0)));
  if (turbulenceWeight > 0.0) {
    turbulence = turbulenceDisplacement *
      (texture(turbulenceTexture, turbulenceUv).rgb * 2.0 - 1.0) * turbulenceWeight;
  }`)
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
  if (!shadow) {
    // The library has already unrolled these neighborhoods. Clamp their
    // integer coordinates at the edge before reading motion or color.
    source = source.replace(/texelFetchOffset\((depthVelocityBuffer|inputBuffer), coord, 0, ((?:neighborOffsets|varianceOffsets)\[\d+\])\)/g,
      'texelFetch($1, clamp(coord + $2, ivec2(0), textureSize($1, 0) - 1), 0)')
    const shadowHistory = 'vec4 historyShadowLength = vec4(texture(shadowLengthHistoryBuffer, prevUv).rgb, 1.0);'
    source = replace(source, shadowHistory, `${shadowHistory}\n  if (isnan(historyShadowLength.r) || isinf(historyShadowLength.r)) historyShadowLength = currentShadowLength;`)
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
  // A 2×2 march spans twice the angular footprint between rays. Scale the
  // derivatives before the logarithm so texture LOD matches the original grid.
  source = replace(source, 'vec2 coord = uv * resolution;', 'vec2 coord = uv * resolution * mipLevelScale;')
  source = replace(source, 'getMipLevel(globeUv * localWeatherRepeat) * mipLevelScale',
    'getMipLevel(globeUv * localWeatherRepeat)')
  source = replace(source, 'uniform mat4 viewMatrix;', 'uniform mat4 viewMatrix;\nuniform mat4 inverseViewMatrix;')
  source = `uniform highp float nightLighting;\nuniform highp float moonPhase;\nuniform highp vec3 nightMoonDirection;\n${source}`
  source = replace(source, 'float getViewZ(', /* glsl */ `
float solarVisibility() {
  return smoothstep(-0.26, -0.12, dot(normalize(vCameraPosition + altitudeCorrection), sunDirection));
}

float getViewZ(`)
  // The phase function depends on the view ray, so evaluate it once for all
  // occupied samples on that ray. Each sample still integrates its own depth.
  const phaseTerms = Array.from({ length: 12 }, (_, i) => /* glsl */ `
  #if ${i} < MULTI_SCATTERING_OCTAVES
  rayScatteringPhase[${i}] = phaseFunction(cosTheta, ${(2 ** -i).toFixed(11)});
  #endif`).join('')
  const scatteringStart = source.indexOf('float approximateMultipleScattering(')
  const scatteringEnd = source.indexOf('// TODO: Construct spherical harmonics', scatteringStart)
  if (scatteringStart < 0 || scatteringEnd < 0) throw new Error('Cloud shader changed: missing multiple scattering')
  const scattering = source.slice(scatteringStart, scatteringEnd)
  let octave = 0
  const phase = 'phaseFunction(cosTheta, coeffs.z)'
  if (scattering.split(phase).length !== 13) throw new Error('Cloud shader changed: multiple-scattering octaves')
  source = source.slice(0, scatteringStart) + /* glsl */ `
float rayScatteringPhase[MULTI_SCATTERING_OCTAVES];

void prepareRayScattering(const float cosTheta) {${phaseTerms}
}

` + scattering.replace('approximateMultipleScattering(const float opticalDepth, const float cosTheta)',
    'rayMultipleScattering(const float opticalDepth)')
    .replaceAll(phase, () => `rayScatteringPhase[${octave++}]`) + source.slice(scatteringStart)
  source = replace(source, 'sunIrradiance * approximateMultipleScattering(opticalDepth, cosTheta)',
    'sunIrradiance * rayMultipleScattering(opticalDepth)')
  source = replace(source, '    vec3 rayOrigin = rayNearFar.x * rayDirection + cameraPosition;',
    '    prepareRayScattering(cosTheta);\n    vec3 rayOrigin = rayNearFar.x * rayDirection + cameraPosition;')
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
  source = replace(source, 'float stbn = getSTBN();', /* glsl */ `float stbn;
  #ifdef TEMPORAL_UPSCALE
  vec3 noiseSize = vec3(textureSize(stbnTexture, 0));
  vec2 pixel = gl_FragCoord.xy * 2.0 + temporalJitter * resolution;
  stbn = texture(stbnTexture, vec3(pixel, float(frame % int(noiseSize.z))) / noiseSize).r;
  #else
  stbn = getSTBN();
  #endif`)
  clouds.fragmentShader = source
  clouds.uniforms.nightLighting = new Uniform(0)
  clouds.uniforms.moonPhase = new Uniform(0)
  clouds.uniforms.nightMoonDirection = new Uniform(new Vector3(0, 0, 1))
  shadow.fragmentShader = replace(shadow.fragmentShader,
    'weightedDistanceSum / transmittanceSum', 'weightedDistanceSum / max(transmittanceSum, 1e-7)')
  stabilizeResolve(effect.cloudsPass.resolveMaterial, false)
  stabilizeResolve(effect.shadowPass.resolveMaterial, true)
  interleaveClouds(effect)
  reuseCloudShadows(effect)
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
    const resolve = effect.cloudsPass.resolveMaterial.uniforms
    const far = (camera as Camera & { far?: number }).far ?? 2e7
    // Foreground aircraft and nearby geometry change too quickly for cloud history.
    resolve.nearHistoryDepth.value = Math.log2(401) / Math.log2(1 + far)
    resolve.resetHistory.value = reset
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

/** Depth-aware upsampling of the cloud overlay where the aerial perspective composites it. */
export function stabilizeAerialPerspective(effect: Effect) {
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
}
