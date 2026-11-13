import type { CloudsEffect } from '@takram/three-clouds'
import type { AerialPerspectiveEffect } from '@takram/three-atmosphere'
import { Data3DTexture, LinearMipmapLinearFilter, Matrix4, Quaternion, Uniform, Vector2, Vector3, Vector4, type Camera, type RawShaderMaterial, type WebGLRenderer, type WebGLRenderTarget } from 'three'
import type { Effect } from 'postprocessing'

// Compatibility fixes for @takram/three-clouds 0.7.6. Keep these at the
// material boundary, rather than editing node_modules (lost on npm install).
function replace(source: string, from: string, to: string) {
  if (!source.includes(from)) throw new Error(`Cloud shader changed: missing ${from}`)
  return source.replaceAll(from, to)
}

/** Cloud density ramps up from nothing at the camera to full strength this far away (m). */
const NEAR_CLEAR_M = 250

function stabilizeDensity(material: RawShaderMaterial) {
  let source = `uniform highp vec3 cloudFieldOffset;\n${material.fragmentShader}`
  // Advect the cached weather, turbulence, and both shape scales together.
  // Moving only shape noise through a fixed weather map deforms formations.
  source = replace(source, 'return getCubeSphereUv(position);', 'return getCubeSphereUv(position + cloudFieldOffset);')
  source = replace(source, '(position + evolution + turbulence) * shapeRepeat', '(position + cloudFieldOffset + evolution + turbulence) * shapeRepeat')
  source = replace(source, '(position + turbulence) * shapeDetailRepeat', '(position + cloudFieldOffset + turbulence) * shapeDetailRepeat')
  source = replace(source, 'sqrt(1.5 + m2.x - m2.y - 0.5 * sqrt(-24.0 * m2.x + q2))',
    'sqrt(max(0.0, 1.5 + m2.x - m2.y - 0.5 * sqrt(max(0.0, -24.0 * m2.x + q2))))')
  source = replace(source, 'media.weight = density / densitySum;', 'media.weight = density / max(densitySum, 1e-7);')
  // Each ray sample integrates a finite interval. Sampling 5 m detail at a
  // single point in a 50-90 m interval aliases as camera-dependent churning.
  // Filter the volumes to that footprint, with explicit LOD because implicit
  // derivatives are undefined inside divergent raymarch loops.
  source = replace(source, '  const float jitter,\n  out ivec3 sampleCount',
    '  const float jitter,\n  const float footprint,\n  out ivec3 sampleCount')
  source = replace(source, '  const float jitter\n) {\n  ivec3 sampleCount;',
    '  const float jitter,\n  const float footprint\n) {\n  ivec3 sampleCount;')
  source = replace(source, 'sampleMedia(weather, position, uv, mipLevel, jitter, sampleCount)',
    'sampleMedia(weather, position, uv, mipLevel, jitter, footprint, sampleCount)')
  // The overload forwards its footprint; all march call sites use their step.
  source = source.replace('MediaSample media = sampleMedia(weather, position, uv, mipLevel, jitter, footprint, sampleCount);',
    'MediaSample media = sampleMedia(weather, position, uv, mipLevel, jitter, stepSize, sampleCount);')
  source = replace(source, 'sampleMedia(weather, position, uv, mipLevel, jitter)',
    'sampleMedia(weather, position, uv, mipLevel, jitter, stepSize)')
  source = replace(source, 'texture(shapeTexture, shapePosition)',
    'textureLod(shapeTexture, shapePosition, max(0.0, log2(max(1.0, footprint * 0.5 * shapeRepeat.x * float(textureSize(shapeTexture, 0).x)))))')
  source = replace(source, 'texture(shapeDetailTexture, detailPosition)',
    'textureLod(shapeDetailTexture, detailPosition, max(0.0, log2(max(1.0, footprint * 0.5 * shapeDetailRepeat.x * float(textureSize(shapeDetailTexture, 0).x)))))')
  source = replace(source, 'texture(turbulenceTexture, turbulenceUv)', 'textureLod(turbulenceTexture, turbulenceUv, mipLevel)')
  // A random per-frame switch changed the actual cloud density, not merely
  // where it was sampled. Blend the detail continuously across its LOD range.
  source = replace(source, 'if (mipLevel * 0.5 + (jitter - 0.5) * 0.5 < 0.5) {',
    'float detailWeight = 1.0 - smoothstep(0.5, 1.5, mipLevel);\n  if (detailWeight > 0.0) {')
  source = replace(source, 'density = remapClamped(density * 2.0, vec4(modifier * 0.5), vec4(1.0));',
    'density = mix(density, remapClamped(density * 2.0, vec4(modifier * 0.5), vec4(1.0)), detailWeight);')
  // Skip the lookups that cannot contribute. A sample outside every layer's profile has
  // no density to shape; turbulence only displaces the lowest third of a layer; and the
  // detail noise only erodes layers that ask for it (the cirrus does not). Seen from
  // cruise altitude most samples along a ray are of those kinds.
  source = replace(source, '  vec4 density = weather.density;\n', /* glsl */ `  vec4 density = weather.density;
  if (!any(greaterThan(density, vec4(0.0)))) {
    MediaSample none;
    none.density = 0.0;
    none.weight = vec4(0.0);
    none.scattering = 0.0;
    none.extinction = 0.0;
    return none;
  }
`)
  source = replace(source, '  turbulence =\n    turbulenceDisplacement *',
    '  float turbulenceWeight = dot(density, remapClamped(weather.heightFraction, vec4(0.3), vec4(0.0)));\n  if (turbulenceWeight > 0.0) turbulence =\n    turbulenceDisplacement *')
  source = replace(source, '    dot(density, remapClamped(weather.heightFraction, vec4(0.3), vec4(0.0)));\n  #endif // TURBULENCE',
    '    turbulenceWeight;\n  #endif // TURBULENCE')
  source = replace(source, 'if (detailWeight > 0.0) {', 'if (detailWeight > 0.0 && any(greaterThan(density * shapeDetailAmounts, vec4(0.0)))) {')
  material.fragmentShader = source
  material.needsUpdate = true
}

/**
 * Temporal upscaling marches one pixel of every 4x4 block per frame, a different one each
 * frame, so sixteen frames visit every pixel of the cloud image. The march is
 * deterministic (no per-frame noise), so each visit to a pixel through an unmoved camera
 * returns the value it returned last time. This resolve keeps exactly that property:
 *
 * - The sample marched through a pixel replaces that pixel outright; every other pixel
 *   keeps its reprojected history untouched. A still view therefore converges to the full
 *   cloud resolution in sixteen frames and then does not change at all: nothing is blended,
 *   clipped or re-estimated while the camera and the clouds hold still. (An earlier version
 *   pinned the march to one of the sixteen positions and spread it over its neighbours,
 *   which was steady but drew the clouds at a quarter of their resolution: visible blocks.)
 * - History follows the camera and the wind drift of the cloud field every frame, so slowly
 *   moving cloud is carried across the screen rather than recomputed. The march itself
 *   is spread over two frames in every three (see CloudCadence).
 * - Only while the image actually moves is history clipped to this frame's samples and
 *   eased towards them: that clears stale cloud where parallax uncovers sky. Motion and
 *   clipping statistics come only from samples marched against the pixel's own surface.
 * - Where history is unusable (cuts, screen edges) a depth-aware, jitter-aligned
 *   reconstruction of this frame's samples stands in until the pixel's turn comes round.
 *   Near geometry (the aircraft, the cockpit) stays inside the march's clear region
 *   without history.
 */
const UPSCALE_RESOLVE = /* glsl */ `
uniform highp sampler2D sceneDepthBuffer;
uniform float nearHistoryDepth;
uniform float nearClearDepth;
// How far a moving image eases towards this frame's sparse samples each frame.
uniform float upscaleFreshWeight;
// Rows of the march target (fraction of its height, from and to) that were marched this
// frame; an empty range on frames that only carry the image along.
uniform vec2 freshRows;
// Reprojection of a view-space point into last frame's image, and the wind's drift of
// the cloud field over one frame (view space, metres).
uniform mat4 viewFromClip;
uniform mat4 historyClipFromView;
uniform vec3 cloudDriftView;
// Benchmark-only diagnostics: 1 paints R = motion, G = rejected, B = nearest usable sample.
uniform int upscaleDebug;

// The march is drawn half a target at a time, so on the frame a new sample position
// begins the other half still holds the previous one: each half has its own jitter
// (lower in xy, upper in zw, in the library's jitterOffset units).
uniform vec4 halfJitter;
uniform float halfSplit;

vec2 marchJitter() {
  vec2 offset = vUv.y < halfSplit ? halfJitter.xy : halfJitter.zw;
  return offset / (vec2(textureSize(colorBuffer, 0)) * 4.0);
}

// 1 where a texel was marched against the surface this pixel shows, falling to 0 across a
// depth edge (the aircraft against cloud, terrain against sky).
float sameSurface(const vec2 marchedUv, const float center) {
  float depth = texture(sceneDepthBuffer, clamp(marchedUv, vec2(0.0), vec2(1.0))).r;
  return exp(-abs(depth - center) * 300.0);
}

// Weights for the four low-resolution texels around uv. Each texel was marched at
// this frame's jittered position, against the scene depth found there. "nearest" is
// how close the closest usable sample is: 1 on it, 0.25 midway between four.
void upscaleWeights(const vec2 uv, const float center, out ivec2 base, out vec4 weights, out float nearest) {
  vec2 lowSize = vec2(textureSize(colorBuffer, 0));
  vec2 st = (uv - marchJitter()) * lowSize - 0.5;
  vec2 cell = floor(st);
  vec2 f = st - cell;
  base = ivec2(cell);
  for (int i = 0; i < 4; ++i) {
    vec2 offset = vec2(float(i & 1), float(i >> 1));
    vec2 marched = (cell + offset + 0.5) / lowSize + marchJitter();
    vec2 bilinear = mix(1.0 - f, f, offset);
    weights[i] = bilinear.x * bilinear.y * sameSurface(marched, center) + 1e-5;
  }
  nearest = max(max(weights.x, weights.y), max(weights.z, weights.w));
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

// Mean and spread of actual march texels around uv, with continuous tent weights.
// Samples stopped at near geometry say nothing about the cloud behind it, so
// exclude them before filtering (bilinear taps would already mix them together).
void upscaleMoments(
  const vec2 uv,
  out vec4 colorMean,
  out vec4 colorSigma,
  out float shadowLengthMean,
  out float shadowLengthSigma
) {
  vec2 lowTexel = 1.0 / vec2(textureSize(colorBuffer, 0));
  vec2 jitter = marchJitter();
  vec2 st = (uv - jitter) / lowTexel - 0.5;
  ivec2 cell = ivec2(floor(st + 0.5));
  ivec2 last = textureSize(colorBuffer, 0) - 1;
  vec4 colorSum = vec4(0.0);
  vec4 colorSquares = vec4(0.0);
  vec2 shadowLengthSums = vec2(0.0);
  float total = 0.0;
  for (int j = -1; j <= 1; ++j) {
    for (int i = -1; i <= 1; ++i) {
      ivec2 at = clamp(cell + ivec2(i, j), ivec2(0), last);
      vec2 tap = (vec2(at) + 0.5) * lowTexel + jitter;
      float depth = texture(sceneDepthBuffer, clamp(tap, vec2(0.0), vec2(1.0))).r;
      vec2 tent = max(vec2(0.0), 1.5 - abs(vec2(at) - st));
      float weight = tent.x * tent.y * step(nearHistoryDepth, depth) + 1e-5;
      // A bilinear fetch mixes aircraft pixels into otherwise valid cloud
      // samples. Fetch the actual texel whose scene depth we just checked.
      vec4 color = texelFetch(colorBuffer, at, 0);
      colorSum += weight * color;
      colorSquares += weight * color * color;
      #ifdef SHADOW_LENGTH
      float shadowLength = texelFetch(shadowLengthBuffer, at, 0).r;
      shadowLengthSums += weight * vec2(shadowLength, shadowLength * shadowLength);
      #endif // SHADOW_LENGTH
      total += weight;
    }
  }
  colorMean = colorSum / total;
  colorSigma = sqrt(max(colorSquares / total - colorMean * colorMean, 0.0));
  shadowLengthMean = shadowLengthSums.x / total;
  shadowLengthSigma = sqrt(max(shadowLengthSums.y / total - shadowLengthMean * shadowLengthMean, 0.0));
}

void temporalUpscale(
  const ivec2 coord,
  const ivec2 lowResCoord,
  const bool currentFrame,
  out vec4 outputColor,
  out float outputShadowLength
) {
  float center = texture(sceneDepthBuffer, vUv).r;
  ivec2 base;
  vec4 weights;
  float nearest;
  upscaleWeights(vUv, center, base, weights, nearest);
  // This frame's samples interpolated to this pixel. Each is a single noisy march, so on
  // its own it is only a stand-in where history is unusable.
  vec4 spatialColor = upscaleFetch(colorBuffer, base, weights);
  #ifdef SHADOW_LENGTH
  float spatialShadowLength = upscaleFetch(shadowLengthBuffer, base, weights).r;
  #endif // SHADOW_LENGTH

  // Motion of the cloud at this pixel, from the samples marched against its own surface.
  // The stock closest-fragment pick handed the aircraft's motion to the cloud around it,
  // which fetched history from on the aircraft: block-shaped holes beside the wings.
  // Where the cloud at this pixel stood in last frame's image: its distance comes from
  // the latest march, the camera's move and the wind's drift from this frame. (The march
  // also writes a velocity, but only on the frames it runs.)
  vec3 depthVelocity = upscaleFetch(depthVelocityBuffer, base, weights).rgb;
  // The ray through this pixel, from its point on the NEAR plane. Unprojecting the far
  // plane instead cancels two nearly equal terms: with the far plane at 20,000 km their
  // difference is below single precision, w comes out zero or negative (always, with the
  // cockpit's 3 cm near plane), and every pixel's history was rejected: from the cockpit
  // the clouds were raw low-resolution blocks.
  vec4 nearPoint = viewFromClip * vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
  vec3 viewPoint = normalize(nearPoint.xyz / nearPoint.w) * depthVelocity.r - cloudDriftView;
  vec4 prevClip = historyClipFromView * vec4(viewPoint, 1.0);
  vec2 prevUv = prevClip.xy / prevClip.w * 0.5 + 0.5;
  vec2 velocity = vUv - prevUv;
  bool near = center < nearHistoryDepth;
  bool rejected = resetHistory || !(prevClip.w > 0.0) || any(isnan(prevUv)) || any(isinf(prevUv)) ||
      prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0;
  if (upscaleDebug == 1) {
    outputColor = vec4(smoothstep(0.5, 3.0, length(velocity / texelSize)), rejected ? 1.0 : 0.0, nearest, 1.0);
    #ifdef SHADOW_LENGTH
    outputShadowLength = 0.0;
    #endif // SHADOW_LENGTH
    return;
  }
  if (rejected && !near) {
    outputColor = spatialColor;
    #ifdef SHADOW_LENGTH
    outputShadowLength = spatialShadowLength;
    #endif // SHADOW_LENGTH
    return; // Rejection
  }
  if (near) {
    // Camera-attached geometry has no usable cloud velocity. Keeping its old
    // screen-space history leaves silhouettes behind a banking aircraft. Match
    // the march's near-clear region, with a soft transition on nearby terrain.
    float nearFade = smoothstep(nearClearDepth, nearHistoryDepth, center);
    outputColor = spatialColor * nearFade;
    #ifdef SHADOW_LENGTH
    outputShadowLength = spatialShadowLength * nearFade;
    #endif // SHADOW_LENGTH
    return;
  }

  // The sample marched through this pixel, on the frame its turn comes round: 1 on that
  // frame and 0 on the other fifteen. (stabilizeClouds keeps the cloud image a multiple
  // of four pixels across, so every sample lands on one pixel's centre.)
  vec2 lowSize = vec2(textureSize(colorBuffer, 0));
  vec2 st = (vUv - marchJitter()) * lowSize - 0.5;
  ivec2 own = ivec2(floor(st + 0.5));
  vec2 miss = abs(st - vec2(own)) / (texelSize * lowSize);
  own = clamp(own, ivec2(0), ivec2(lowSize) - 1);
  float ownRow = (float(own.y) + 0.5) / lowSize.y;
  float fresh = step(freshRows.x, ownRow) * step(ownRow, freshRows.y) *
    clamp((max(0.0, 1.0 - miss.x) * max(0.0, 1.0 - miss.y) - 0.05) / 0.9, 0.0, 1.0);
  vec4 freshColor = texelFetch(colorBuffer, own, 0);
  #ifdef SHADOW_LENGTH
  float freshShadowLength = texelFetch(shadowLengthBuffer, own, 0).r;
  #endif // SHADOW_LENGTH

  vec4 historyColor = texture(colorHistoryBuffer, prevUv);
  if (any(isnan(historyColor)) || any(isinf(historyColor))) historyColor = spatialColor;
  #ifdef SHADOW_LENGTH
  float historyShadowLength = texture(shadowLengthHistoryBuffer, prevUv).r;
  if (isnan(historyShadowLength) || isinf(historyShadowLength)) historyShadowLength = spatialShadowLength;
  #endif // SHADOW_LENGTH

  // Pixels per frame the cloud here moves across the screen. Parked, or drifting with
  // the wind, this is zero and history is exact.
  float moving = smoothstep(0.25, 2.0, length(velocity / texelSize));
  // In a moving image the carried pixels are a little soft and a little behind, and a
  // sample written over them at full strength stands out as a dot: seen from cruise
  // altitude the whole deck turned to stipple. There it only pulls its pixel part of
  // the way, and the easing below spreads the rest. A still image takes it whole.
  fresh *= mix(1.0, 0.4, moving);
  // At the horizon each ray crosses kilometres of cloud in a few long steps, and single
  // rays alias. Take the neighbourhood's mean there instead of one ray.
  float horizonFilter = 0.7 * smoothstep(20000.0, 60000.0, depthVelocity.r);
  if (moving > 0.0 || horizonFilter > 0.0) {
    vec4 colorMean;
    vec4 colorSigma;
    float shadowLengthMean;
    float shadowLengthSigma;
    upscaleMoments(vUv, colorMean, colorSigma, shadowLengthMean, shadowLengthSigma);
    freshColor = mix(freshColor, colorMean, horizonFilter);
    spatialColor = mix(spatialColor, colorMean, horizonFilter);

    vec4 clippedColor = clipAABB(colorMean, historyColor, colorMean - colorSigma * varianceGamma, colorMean + colorSigma * varianceGamma);
    // Clip opacity independently. clipAABB scales all four history channels by
    // the RGB error: small night-light changes then drag opacity toward this
    // frame's sparse samples. Alpha still needs its own bounds to clear old
    // silhouettes when cloud moves away.
    clippedColor.a = clamp(historyColor.a,
      max(0.0, colorMean.a - colorSigma.a * varianceGamma),
      min(1.0, colorMean.a + colorSigma.a * varianceGamma));
    // While the image moves, lean lightly on this frame's interpolated samples as well:
    // lighting and parallax that drifted since a pixel's last visit are then corrected
    // smoothly everywhere, rather than only as each pixel's turn comes round (which reads
    // as a fine crawling dither). Alternatives that kept more detail in motion measured
    // worse: bicubic history flickered 1.3x as much, and spreading the differences
    // between samples and history instead of the samples themselves 3.6x.
    historyColor = mix(historyColor, mix(clippedColor, spatialColor, upscaleFreshWeight), moving);

    #ifdef SHADOW_LENGTH
    freshShadowLength = mix(freshShadowLength, shadowLengthMean, horizonFilter);
    spatialShadowLength = mix(spatialShadowLength, shadowLengthMean, horizonFilter);
    float clippedShadowLength = clamp(historyShadowLength, shadowLengthMean - shadowLengthSigma * varianceGamma, shadowLengthMean + shadowLengthSigma * varianceGamma);
    historyShadowLength = mix(historyShadowLength, mix(clippedShadowLength, spatialShadowLength, upscaleFreshWeight), moving);
    #endif // SHADOW_LENGTH
  }

  outputColor = mix(historyColor, freshColor, fresh);
  #ifdef SHADOW_LENGTH
  outputShadowLength = mix(historyShadowLength, freshShadowLength, fresh);
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
  resolve.nearClearDepth.value = Math.log2(1 + NEAR_CLEAR_M) / Math.log2(far + 1)
}
const NEAR_HISTORY_M = 400

/** Solid angle (sr) of the glow around a low sun that lights the clouds. */
const TWILIGHT_SOLID_ANGLE = 0.4

/** Sun elevation (deg) at and below which cloud bases are fully lit from beneath, and above which not at all. */
const LOW_SUN_DEG = [1, 9] as const
/** How fast that light falls off with height into a cloud layer (per layer thickness), far from the camera. */
const UNDERSIDE_FALLOFF = 12

/**
 * Scalar irradiance from the glow around a low sun, at the cloud base: the sky's radiance
 * a few degrees above the horizon towards the sun and 30 degrees either side of it, over
 * the solid angle that band fills. Fades out once the sun is well up, when the sky has
 * no warm side.
 */
const TWILIGHT_GLOW = /* glsl */ `
vec3 twilightGlow(const vec3 positionECEF) {
  vec3 up = normalize(positionECEF);
  float elevation = dot(sunDirection, up);
  vec3 toSun = sunDirection - up * elevation;
  float horizontal = length(toSun);
  float lowSun = 1.0 - smoothstep(0.1045, 0.2419, elevation);
  if (horizontal < 1e-4 || lowSun <= 0.0) return vec3(0.0);
  toSun /= horizontal;
  vec3 side = cross(up, toSun);
  vec3 camera = up * (bottomRadius + minHeight) * METER_TO_LENGTH_UNIT;
  vec3 transmittance;
  vec3 radiance = GetSkyRadiance(camera, normalize(toSun + up * 0.035), 0.0, sunDirection, transmittance);
  radiance += GetSkyRadiance(camera, normalize(toSun + up * 0.11), 0.0, sunDirection, transmittance);
  radiance += GetSkyRadiance(camera, normalize(toSun * 0.866 + side * 0.5 + up * 0.07), 0.0, sunDirection, transmittance);
  radiance += GetSkyRadiance(camera, normalize(toSun * 0.866 - side * 0.5 + up * 0.07), 0.0, sunDirection, transmittance);
  return max(radiance, vec3(0.0)) * (0.25 * ${TWILIGHT_SOLID_ANGLE.toFixed(2)} * lowSun);
}
`
/** Density probes across each march cell, and the cell lengths (m) above which two and then one are taken. */
const MARCH_PROBES = 3
const MARCH_PROBE_CELLS = [150, 400] as const

/** sampleWeather() for another height at a weather-map sample already read. */
const WEATHER_AT_HEIGHT = /* glsl */ `
WeatherSample weatherAtHeight(const vec4 localWeather, const float height) {
  WeatherSample weather;
  weather.heightFraction = remapClamped(vec4(height), minLayerHeights, maxLayerHeights);
  vec4 heightScale = shapeAlteringFunction(weather.heightFraction, shapeAlteringBiases);
  vec4 factor = 1.0 - coverage * heightScale;
  weather.density = remapClamped(
    mix(localWeather, vec4(1.0), coverageFilterWidths),
    factor,
    factor + coverageFilterWidths
  );
  return weather;
}
`

/**
 * Distances from the camera at which every ray is sampled: cell n starts at t(n), with
 * t(n + 1) = t(n) + min(maxStepSize, minStepSize + (perspectiveStepScale - 1) t(n)).
 * Returns the start of the cell containing t.
 */
const MARCH_LATTICE = /* glsl */ `
float marchLatticeFloor(const float t) {
  float growth = perspectiveStepScale - 1.0;
  if (growth < 1e-5) return floor(t / minStepSize) * minStepSize;
  float rate = log(perspectiveStepScale);
  // Steps grow geometrically up to cell "capped", then stay at maxStepSize.
  float capped = ceil(log(maxStepSize / minStepSize) / rate);
  float cappedStart = minStepSize / growth * (exp(capped * rate) - 1.0);
  if (t >= cappedStart) return cappedStart + floor((t - cappedStart) / maxStepSize) * maxStepSize;
  float cell = floor(log(1.0 + max(t, 0.0) * growth / minStepSize) / rate);
  return minStepSize / growth * (exp(cell * rate) - 1.0);
}

`

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
    material.uniforms.nearClearDepth = new Uniform(0)
    material.uniforms.upscaleFreshWeight = new Uniform(0.08)
    material.uniforms.upscaleDebug = new Uniform(0)
    material.uniforms.freshRows = new Uniform(new Vector2(0, 1))
    material.uniforms.halfJitter = new Uniform(new Vector4())
    material.uniforms.halfSplit = new Uniform(0.5)
    material.uniforms.viewFromClip = new Uniform(new Matrix4())
    material.uniforms.historyClipFromView = new Uniform(new Matrix4())
    material.uniforms.cloudDriftView = new Uniform(new Vector3())
  }
  material.uniforms.resetHistory = new Uniform(true)
  material.fragmentShader = source
  material.needsUpdate = true
}

type ArrayPass = { render(renderer: WebGLRenderer, input: unknown, output: WebGLRenderTarget, ...rest: unknown[]): void }

/**
 * The library attaches the layers of an array render target by its GL texture, which it
 * looks up before asking three to bind the target. A target that was just resized has no
 * GL texture yet, so its first render after every resize drew nothing at all. The cloud
 * shadow maps resize with the adaptive cloud level and ping-pong between two targets, so
 * each change of level dropped the cloud shadows for two frames: a full-screen flash of
 * sunlit ground and unshadowed cloud. Binding the target first lets three create it.
 */
function allocateBeforeRender(pass: ArrayPass) {
  const render = pass.render
  pass.render = function (renderer, input, output, ...rest) {
    renderer.setRenderTarget(output)
    render.call(this, renderer, input, output, ...rest)
  }
}

/**
 * Clouds drift slowly, and so does everything that lights them, so the expensive cloud
 * passes take turns instead of all running every frame. A cycle is three frames: the
 * lower half of the cloud march, its upper half, then the shadow cascades. On every frame
 * the resolve carries the finished cloud image along with the camera and the wind, which
 * costs a twentieth of a march. A full refresh of the cloud image therefore takes 48
 * frames instead of 16, and no frame carries more than half a march. (With the whole
 * march on one frame, that frame alone missed the display's deadline from cruise
 * altitude and the adaptive detail fell to its lowest level to pay for it.)
 * Nothing waits for a turn after a cut, a resize or a floating-origin rebase.
 */
interface CloudCadence {
  tick: number
  marchFrame: number
  shadowFrame: number
  /** Run everything on the next frame. */
  force: boolean
  shadowTurn: boolean
  /** Which part of the march runs this frame. */
  march: 'none' | 'lower' | 'upper' | 'all'
  /** The sample position (march frame) each half of the march target currently holds. */
  lowerFrame: number
  upperFrame: number
  /** Last frame's camera, for the resolve's reprojection. */
  previousView: Matrix4 | null
  readonly previousProjection: Matrix4
  /** Wind drift of the cloud field since the last frame (ECEF, m). */
  readonly drift: Vector3
}

/** The library's order of visiting the sixteen pixels of a 4x4 block, by position. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

/** Sample offset of a march frame within its 4x4 block (pixels from the block centre), per axis. */
function phaseJitter(frame: number, axis: 0 | 1) {
  const at = BAYER.indexOf(((frame % 16) + 16) % 16)
  return (axis === 0 ? at % 4 : at >> 2) + 0.5 - 2
}

type CadencePass = { update(renderer: WebGLRenderer, frame: number, deltaTime: number): void }

function paceClouds(effect: CloudsEffect): CloudCadence {
  const cadence: CloudCadence = {
    tick: 0, marchFrame: 0, shadowFrame: 0, force: true, shadowTurn: true, march: 'all', lowerFrame: 0, upperFrame: 0,
    previousView: null, previousProjection: new Matrix4(), drift: new Vector3(),
  }
  const resolve = effect.cloudsPass.resolveMaterial.uniforms
  const shadowResolve = effect.shadowPass.resolveMaterial.uniforms

  // The cascades are fitted first in every effect update: decide the frame's turns here.
  const maps = effect.shadowMaps
  const fit = maps.update
  maps.update = function (...args) {
    const reset = cadence.force || resolve.resetHistory.value === true
    cadence.force = false
    if (reset) {
      // Start a fresh cycle with everything drawn, so the halves always pair up.
      cadence.tick = 2
      cadence.march = 'all'
    } else {
      cadence.tick = (cadence.tick + 1) % 3
      cadence.march = cadence.tick === 0 ? 'lower' : cadence.tick === 1 ? 'upper' : 'none'
    }
    cadence.shadowTurn = reset || shadowResolve.resetHistory.value === true || cadence.tick === 2
    // A skipped turn keeps the cascades its shadow maps were drawn with.
    if (cadence.shadowTurn) fit.apply(this, args)
  }

  const shadowPass = effect.shadowPass as unknown as CadencePass
  const drawShadows = shadowPass.update
  shadowPass.update = function (renderer, _frame, deltaTime) {
    if (cadence.shadowTurn) drawShadows.call(this, renderer, ++cadence.shadowFrame, deltaTime)
  }

  const pass = effect.cloudsPass as unknown as {
    currentPass: { render(...args: unknown[]): void }
    currentRenderTarget: WebGLRenderTarget
  }
  const march = pass.currentPass
  const drawMarch = march.render
  march.render = function (...args) {
    if (cadence.march === 'none') return
    // Half a march is the same march with the other half of the target scissored away:
    // those rows keep the samples of the same position from a frame ago.
    const target = pass.currentRenderTarget
    const split = target.height >> 1
    target.scissorTest = cadence.march !== 'all'
    if (cadence.march === 'lower') target.scissor.set(0, 0, target.width, split)
    else if (cadence.march === 'upper') target.scissor.set(0, split, target.width, target.height - split)
    else target.scissor.set(0, 0, target.width, target.height)
    drawMarch.apply(this, args)
    target.scissorTest = false
  }
  const cloudsPass = effect.cloudsPass as unknown as CadencePass
  const drawClouds = cloudsPass.update
  cloudsPass.update = function (renderer, _frame, deltaTime) {
    const camera = effect.mainCamera as Camera & { projectionMatrix: Matrix4; projectionMatrixInverse: Matrix4 }
    // The sample position (and the noise fixed to it) advances once per whole march.
    if (cadence.march === 'lower' || cadence.march === 'all') cadence.marchFrame++
    if (cadence.march === 'lower' || cadence.march === 'all') cadence.lowerFrame = cadence.marchFrame
    if (cadence.march === 'upper' || cadence.march === 'all') cadence.upperFrame = cadence.marchFrame
    const jitter = resolve.halfJitter.value as Vector4
    jitter.set(phaseJitter(cadence.lowerFrame, 0), phaseJitter(cadence.lowerFrame, 1), phaseJitter(cadence.upperFrame, 0), phaseJitter(cadence.upperFrame, 1))
    // Rows of the march target (as a fraction of its height) that hold new samples.
    const target = pass.currentRenderTarget
    const split = target.height > 0 ? (target.height >> 1) / target.height : 0.5
    resolve.halfSplit.value = split
    ;(resolve.freshRows.value as Vector2).set(
      cadence.march === 'upper' ? split : cadence.march === 'none' ? 2 : 0,
      cadence.march === 'lower' ? split : cadence.march === 'none' ? 2 : 1)
    ;(resolve.viewFromClip.value as Matrix4).copy(camera.projectionMatrixInverse)
    const history = resolve.historyClipFromView.value as Matrix4
    if (cadence.previousView) history.copy(cadence.previousProjection).multiply(cadence.previousView).multiply(camera.matrixWorld)
    else history.copy(camera.projectionMatrix)
    ;(resolve.cloudDriftView.value as Vector3).copy(cadence.drift)
      .transformDirection(_oldFromWorld.copy(effect.worldToECEFMatrix).invert())
      .transformDirection(camera.matrixWorldInverse)
      .multiplyScalar(cadence.drift.length())
    drawClouds.call(this, renderer, cadence.marchFrame, deltaTime)
    cadence.previousView = (cadence.previousView ?? new Matrix4()).copy(camera.matrixWorldInverse)
    cadence.previousProjection.copy(camera.projectionMatrix)
  }
  return cadence
}

export function stabilizeClouds(effect: CloudsEffect) {
  const clouds = effect.cloudsPass.currentMaterial
  // Store the marker on the material: a module-local WeakSet is lost during
  // Fast Refresh while R3F can retain the already-patched effect instance.
  if (clouds.userData.geoflightStableClouds) return
  const shadow = effect.shadowPass.currentMaterial
  stabilizeDensity(clouds)
  stabilizeDensity(shadow)
  const fieldOffset = new Uniform(new Vector3())
  clouds.uniforms.cloudFieldOffset = fieldOffset
  shadow.uniforms.cloudFieldOffset = fieldOffset
  // The march visits the sixteen positions of each 4x4 block in turn (the library's
  // own frame counter), so the full cloud resolution is covered every sixteen frames.
  // What must not change from frame to frame is the result for a given pixel: see the
  // fixed noise below and the resolve above.
  // Each sample must also land on exactly one pixel. In a cloud image that is not a
  // multiple of four pixels across, samples fall between pixels and two of the sixteen
  // positions share each pixel, which then alternates between their two answers for ever
  // (3/255 along every cloud edge in a still view). Round the image up instead; it is
  // only ever read through normalized coordinates.
  const sized = effect.cloudsPass as unknown as { width: number; height: number; setSize(width: number, height: number): void }
  const setSize = sized.setSize
  sized.setSize = function (width, height) {
    setSize.call(this, Math.ceil(width / 4) * 4, Math.ceil(height / 4) * 4)
  }
  if (sized.width > 0 && sized.height > 0) sized.setSize(sized.width, sized.height)
  // RawShaderMaterial does not inherit Three's high precision sampler defaults.
  // Depth and motion textures must retain precision on the Metal/WebKit path.
  for (const material of [clouds, shadow, effect.cloudsPass.resolveMaterial, effect.shadowPass.resolveMaterial]) {
    material.fragmentShader = `precision highp sampler2D;\n${material.fragmentShader}`
  }

  let source = clouds.fragmentShader
  // Our reconstruction samples the entire low-resolution image in normalized
  // UVs. The stock depth lookup instead assumes the resolve crops off padded
  // rows/columns. Mixing those conventions moves depth silhouettes relative
  // to the rays, leaving displaced aircraft outlines and a horizon stripe.
  source = replace(source, 'vUv * targetUvScale + temporalJitter', 'vUv + temporalJitter')
  source = replace(source, 'uniform mat4 viewMatrix;', 'uniform mat4 viewMatrix;\nuniform mat4 inverseViewMatrix;')
  source = `uniform highp float nightLighting;\nuniform highp float moonPhase;\nuniform highp vec3 nightMoonDirection;\n${source}`
  // Lighting rays used a random sample count and random first step. At the
  // detail transition this alternated between different integration lengths,
  // making the sunlit cloud face flash even when its density did not change.
  // Use a fixed midpoint quadrature and smoothly blend to the distant estimate.
  source = replace(source, `int iterationCount = int(
    max(0.0, remap(mipLevel, 0.0, 1.0, float(maxIterationCount + 1), 1.0) - jitter)
  );
  if (iterationCount == 0) {`, `float lightingDetail = 1.0 - smoothstep(0.5, 1.5, mipLevel);
  int iterationCount = maxIterationCount;
  if (iterationCount == 0 || lightingDetail == 0.0) {`)
  source = replace(source, 'float nextDistance = stepSize * jitter;', 'float nextDistance = stepSize * 0.5;')
  source = replace(source, 'return opticalDepth;\n}', 'return mix(0.5, opticalDepth, lightingDetail);\n}')
  // The stock march starts its steps where each ray enters the cloud shell and hides the
  // resulting bands with per-frame noise. Without that noise the bands show: seen from the
  // ground the entry point moves 40 m along the ray from one pixel row to the next, so
  // 50-140 m steps sample each wisp at a different phase on every row and the clouds come
  // out combed into fine horizontal ripples. Here every ray instead samples the same
  // fixed shells of distance from the camera (MARCH_LATTICE), so neighbouring pixels
  // sample neighbouring points and the image is as smooth as the cloud itself. The first
  // and last cells are clipped to the ray, which also integrates rays that end on nearby
  // geometry (the aircraft from the chase camera) exactly instead of all-or-nothing.
  const marchStart = source.indexOf('vec4 marchClouds(')
  const marchEnd = source.indexOf('float marchShadowLength(', marchStart)
  if (marchStart < 0 || marchEnd < marchStart) throw new Error('Cloud shader changed: missing primary march')
  let march = source.slice(marchStart, marchEnd)
  march = replace(march, `  float stepSize = minStepSize + (perspectiveStepScale - 1.0) * rayNearFar.x;
  // I don't understand why spatial aliasing remains unless doubling the jitter.
  float rayDistance = stepSize * jitter * 2.0;

  for (int i = 0; i < maxIterationCount; ++i) {
    if (rayDistance > maxRayDistance) {
      break; // Termination
    }
`, /* glsl */ `
  float growth = perspectiveStepScale - 1.0;
  float cellStart = marchLatticeFloor(rayNearFar.x);
  float rewindTo = -1.0;
  float fineUntil = -1.0;
  float stepSize = 0.0;
  float rayDistance = 0.0;

  for (int i = 0; i < maxIterationCount; ++i) {
    float cellFrom = cellStart;
    float cellStep = min(maxStepSize, minStepSize + growth * cellFrom);
    cellStart += cellStep;
    float segmentStart = max(cellFrom, rayNearFar.x);
    if (segmentStart >= rayNearFar.y) {
      break; // Termination
    }
    stepSize = min(cellStart, rayNearFar.y) - segmentStart;
    if (stepSize <= 0.0) {
      continue;
    }
    rayDistance = segmentStart + 0.5 * stepSize - rayNearFar.x;
`)
  // Between the cloud layers there is nothing to sample: cross those gaps in long strides,
  // then go back over the last stride cell by cell, so a stride never decides where the
  // next layer begins. Inside a layer every cell is visited. (Striding over cloud-free
  // weather there, as the library does, finds or misses a thin cloud depending on where
  // the ray happened to enter the layer: contour lines along every shell.)
  if (march.split('rayDistance += mix(stepSize, maxStepSize, min(1.0, mipLevel));').length !== 3) throw new Error('Cloud shader changed: missing empty-space strides')
  march = replace(march, `      stepSize *= perspectiveStepScale;
      rayDistance += mix(stepSize, maxStepSize, min(1.0, mipLevel));
      continue;
    }
    #endif // !defined(DEBUG_MARCH_INTERVALS)
`, /* glsl */ `
      if (cellStart >= fineUntil) {
        float strideEnd = segmentStart + maxStepSize;
        float strideStart = cellStart;
        for (int k = 0; k < 24; ++k) {
          float next = min(maxStepSize, minStepSize + growth * cellStart);
          if (cellStart + next > strideEnd) break;
          cellStart += next;
        }
        rewindTo = cellStart > strideStart ? strideStart : -1.0;
      }
      continue;
    }
    #endif // !defined(DEBUG_MARCH_INTERVALS)
    if (rewindTo >= 0.0) {
      fineUntil = cellStart;
      cellStart = rewindTo;
      rewindTo = -1.0;
      continue;
    }
`)
  march = replace(march, `      stepSize *= perspectiveStepScale;
      rayDistance += mix(stepSize, maxStepSize, min(1.0, mipLevel));
      continue;`, '      continue;')
  march = replace(march, `    // Take a shorter step because we've already hit the clouds.
    stepSize *= perspectiveStepScale;
    rayDistance += stepSize;
`, '')
  // Cloud this dense turns opaque within metres, far less than a cell: lit at its
  // midpoint, each cell shows as a terrace with its own shading, and the terraces' edges
  // draw contour lines over every cloud. So the density is probed several times across
  // the cell and the cell is lit once, at the depth its visible cloud actually lies at
  // (the opacity-weighted mean of the probes). That depth moves continuously across the
  // image, the lighting with it, and the finer probes also resolve more of the detail.
  march = replace(march, 'MediaSample media = sampleMedia(weather, position, uv, mipLevel, jitter, stepSize, sampleCount);', /* glsl */ `
    MediaSample media;
    float seenExtinction = 0.0;
    {
      // Fewer probes in the long cells far away, where a terrace is a pixel or two.
      int probeCount = cellStep > ${MARCH_PROBE_CELLS[1].toFixed(1)} ? 1 : cellStep > ${MARCH_PROBE_CELLS[0].toFixed(1)} ? 2 : ${MARCH_PROBES};
      float probes = float(probeCount);
      float probeStep = stepSize / probes;
      float through = 1.0;
      float seen = 0.0;
      float seenDistance = 0.0;
      float opticalDepth = 0.0;
      float scattering = 0.0;
      vec4 weight = vec4(0.0);
      for (int probeIndex = 0; probeIndex < ${MARCH_PROBES}; ++probeIndex) {
        if (probeIndex >= probeCount) break;
        float probeDistance = segmentStart + (float(probeIndex) + 0.5) * probeStep - rayNearFar.x;
        vec3 probePosition = probeDistance * rayDirection + rayOrigin;
        float probeHeight = length(probePosition) - bottomRadius;
        // The weather map (hundreds of metres a texel) is read once per cell; each
        // probe only applies its own height within the layers.
        WeatherSample probeWeather = weatherAtHeight(cellWeather, probeHeight);
        MediaSample probe = sampleMedia(probeWeather, probePosition, uv, mipLevel, jitter, cellStep / probes, sampleCount);
        // Integrated properly, an overcast hides everything past a few tens of metres, the
        // aircraft in the chase view included. Thin the cloud around the camera so the
        // aircraft and cockpit stay readable while the view beyond still closes in.
        float nearClear = smoothstep(0.0, ${NEAR_CLEAR_M.toFixed(1)}, rayNearFar.x + probeDistance);
        probe.extinction *= nearClear;
        probe.scattering *= nearClear;
        float probeDepth = probe.extinction * probeStep;
        float probeTransmittance = exp(-probeDepth);
        float opacity = through * (1.0 - probeTransmittance);
        through *= probeTransmittance;
        seen += opacity;
        seenDistance += opacity * probeDistance;
        seenExtinction += opacity * probe.extinction;
        opticalDepth += probeDepth;
        scattering += probe.scattering;
        weight += probe.extinction * probe.weight;
      }
      media.extinction = opticalDepth / stepSize;
      media.scattering = scattering / probes;
      media.weight = weight / max(opticalDepth / probeStep, 1e-7);
      if (seen > 1e-6) {
        seenExtinction /= seen;
        rayDistance = seenDistance / seen;
        position = rayDistance * rayDirection + rayOrigin;
        height = length(position) - bottomRadius;
        weather.heightFraction = remapClamped(vec4(height), minLayerHeights, maxLayerHeights);
      }
    }`)
  march = replace(march, 'exp(-media.extinction * powderExponent)', 'exp(-seenExtinction * powderExponent)')
  march = replace(march, 'WeatherSample weather = sampleWeather(uv, height, mipLevel);',
    'WeatherSample weather = sampleWeather(uv, height, mipLevel);\n    vec4 cellWeather = lastLocalWeather;')
  march = MARCH_LATTICE + march
  source = source.slice(0, marchStart) + march + source.slice(marchEnd)
  source = replace(source, 'WeatherSample sampleWeather(', 'vec4 lastLocalWeather;\n\nWeatherSample sampleWeather(')
  source = replace(source, '  #ifdef SHADOW\n  localWeather *= shadowLayerMask;\n  #endif // SHADOW\n', '  #ifdef SHADOW\n  localWeather *= shadowLayerMask;\n  #endif // SHADOW\n  lastLocalWeather = localWeather;\n')
  source = replace(source, 'vec4 getLayerDensity(', `${WEATHER_AT_HEIGHT}\nvec4 getLayerDensity(`)
  source = replace(source, 'float getViewZ(', /* glsl */ `
float solarVisibility() {
  return smoothstep(-0.26, -0.12, dot(normalize(vCameraPosition + altitudeCorrection), sunDirection));
}

// Blue noise fixed to the full-resolution pixel a ray is marched through. The stock
// lookup changes every frame and repeats per 4x4 block, so the same pixel never got
// the same answer twice and no still view could settle.
float stableNoise() {
  vec3 scale = 1.0 / vec3(textureSize(stbnTexture, 0));
  return texture(stbnTexture, vec3(gl_FragCoord.xy * 4.0 + temporalJitter * resolution, 0.5) * scale).r;
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
      float shadowDepth = 0.0;
      if (height < shadowTopHeight && nightDepthWeight < 1.0) {
        // The shadow cascades follow the sun, so they only shade its contribution.
        shadowDepth = (1.0 - nightDepthWeight) * sampleShadowOpticalDepth(`)
  // Low sun. The shadow map carries the light through the whole deck between a cloud
  // and the sun, and within a few degrees of the horizon that is tens of kilometres of
  // cloud: nothing under the deck is lit, and from the ground a sunset is a flat dark
  // sheet. In fact light that low reaches the undersides: it slips in beneath the deck
  // (and, a little higher, through the gaps the shadow map averages away). So as the sun
  // nears the horizon, cloud with a clear view downward (the bases, and thin edges)
  // sheds the far shadow and keeps only the cloud right in front of it; cloud with more
  // cloud beneath it stays in the deck's shadow, as do the tops seen from above.
  source = replace(source, 'float opticalDepthToGround = marchOpticalDepth(', 'float opticalDepthToGround = groundOpticalDepth = marchOpticalDepth(')
  source = replace(source, '#ifdef GROUND_BOUNCE\nvec3 approximateRadianceFromGround(', 'float groundOpticalDepth = 0.0;\n\n#ifdef GROUND_BOUNCE\nvec3 approximateRadianceFromGround(')
  source = replace(source, `        vec3 groundRadiance = approximateRadianceFromGround(
          position,
          surfaceNormal,
          height,
          mipLevel,
          jitter
        );
`, '')
  source = replace(source, 'vec3 radiance = sunIrradiance * approximateMultipleScattering(opticalDepth, cosTheta);', /* glsl */ `
      vec3 groundRadiance = vec3(0.0);
      // How open the view downward is: from the height within the layer, or, near the
      // camera, from the optical depth the ground-bounce march finds below.
      float underside = exp(-${UNDERSIDE_FALLOFF.toFixed(1)} * dot(weather.heightFraction, media.weight));
      #ifdef GROUND_BOUNCE
      if (height < shadowTopHeight && mipLevel < 0.5) {
        groundRadiance = approximateRadianceFromGround(position, surfaceNormal, height, mipLevel, jitter);
        underside = mix(exp(-groundOpticalDepth), underside, smoothstep(0.3, 0.5, mipLevel));
      }
      #endif // GROUND_BOUNCE
      float localDepth = opticalDepth;
      float lowSun = 1.0 - smoothstep(${Math.sin(LOW_SUN_DEG[0] * Math.PI / 180).toFixed(4)}, ${Math.sin(LOW_SUN_DEG[1] * Math.PI / 180).toFixed(4)}, dot(sunDirection, surfaceNormal));
      opticalDepth += shadowDepth * (1.0 - lowSun * underside);
      vec3 radiance = sunIrradiance * approximateMultipleScattering(opticalDepth, cosTheta);`)
  // Sky light arrives here as one colour from every direction, and at sunset that colour
  // is the average of a blue zenith and an orange horizon: mauve, on every side of every
  // cloud. Split the glow around the setting sun (TWILIGHT_GLOW, estimated per frame in
  // the vertex shader) off from the rest: it lights what faces it (undersides, and
  // cloud with little cloud between it and the sun) while the cooler remainder keeps
  // the library's top-down gradient. The total is unchanged; the clouds gain the warm
  // and cool sides a low sun gives them.
  source = replace(source, 'in CloudsIrradiance vCloudsIrradiance;', 'in CloudsIrradiance vCloudsIrradiance;\nin vec3 vTwilightGlow;')
  source = replace(source, 'radiance += skyIrradiance * RECIPROCAL_PI4 * skyGradient * skyLightScale;', /* glsl */ `
      vec3 warmSky = min(vTwilightGlow, skyIrradiance);
      float facingGlow = max(underside, exp(-localDepth));
      radiance += ((skyIrradiance - warmSky) * skyGradient + warmSky * mix(0.25, 2.2, facingGlow)) * RECIPROCAL_PI4 * skyLightScale;`)
  let vertex = clouds.vertexShader
  vertex = replace(vertex, 'out CloudsIrradiance vCloudsIrradiance;', 'out CloudsIrradiance vCloudsIrradiance;\nout vec3 vTwilightGlow;')
  vertex = replace(vertex, 'void main() {', `${TWILIGHT_GLOW}\nvoid main() {`)
  vertex = replace(vertex, 'sampleSunSkyIrradiance(vCameraPosition + altitudeCorrection);',
    'sampleSunSkyIrradiance(vCameraPosition + altitudeCorrection);\n  vTwilightGlow = twilightGlow(vCameraPosition + altitudeCorrection);')
  clouds.vertexShader = vertex
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
  source = replace(source, 'float stbn = getSTBN();', 'float stbn = stableNoise();')
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
  // The planar exponential approximation divides by the grazing angle and
  // subtracts nearly equal exponentials. At the horizon that quantizes into
  // bands, and above the haze it uses the camera's density for the whole ray.
  // Integrate the curved atmosphere instead; quadratic spacing resolves nearby
  // haze while keeping long horizon rays cheap and continuous through zero slope.
  const hazeStart = source.indexOf('  float density = modulation * hazeDensityScale')
  const hazeEnd = source.indexOf('  vec3 skyIrradiance = vGroundIrradiance.sky;', hazeStart)
  if (hazeStart < 0 || hazeEnd < hazeStart) throw new Error('Cloud shader changed: missing haze integration')
  source = source.slice(0, hazeStart) + /* glsl */ `
  float opticalDepth = 0.0;
  float shadowOpticalDepth = 0.0;
  for (int i = 0; i < 12; ++i) {
    float a = float(i) / 12.0;
    float b = float(i + 1) / 12.0;
    float start = a * a * maxRayDistance;
    float end = b * b * maxRayDistance;
    float distance = (start + end) * 0.5;
    float height = max(0.0, length(rayOrigin + rayDirection * distance) - bottomRadius);
    float density = modulation * hazeDensityScale * exp(-height * hazeExponent);
    opticalDepth += density * (end - start);
    shadowOpticalDepth += density * max(0.0, end - max(start, shadowLength));
  }
  float transmittance = 1.0 - exp(-opticalDepth);
  float shadowTransmittance = 1.0 - exp(-shadowOpticalDepth);

` + source.slice(hazeEnd)
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
    'return vec4(inscatter, transmittance) * solarVisibility();')
  // approximateHaze already integrates radiance over opacity (premultiplied).
  // Multiplying it by alpha again turns thin sunset haze into a dark stripe.
  source = replace(source, 'color.rgb = mix(color.rgb, haze.rgb, haze.a);',
    'color.rgb = color.rgb * (1.0 - haze.a) + haze.rgb;')
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
  const shadowPasses = effect.shadowPass as unknown as { currentPass: ArrayPass; resolvePass: ArrayPass }
  allocateBeforeRender(shadowPasses.currentPass)
  allocateBeforeRender(shadowPasses.resolvePass)
  effect.cloudsPass.resolveMaterial.uniforms.temporalAlpha.value = 0.2
  clouds.userData.geoflightCadence = paceClouds(effect)
  clouds.userData.geoflightStableClouds = true
}

export function setCloudNightLighting(effect: CloudsEffect, darkness: number, moonDirection: Vector3, moonPhase: number) {
  const { uniforms } = effect.cloudsPass.currentMaterial
  uniforms.nightLighting.value = darkness
  uniforms.moonPhase.value = moonPhase ** 1.7
  ;(uniforms.nightMoonDirection.value as Vector3).copy(moonDirection)
}

/** Translate the cached cloud field in metres; never animate its noise layers independently. */
export function driftCloudField(effect: CloudsEffect, windECEF: Vector3, dt: number) {
  effect.shapeVelocity.setScalar(0)
  effect.shapeDetailVelocity.setScalar(0)
  const material = effect.cloudsPass.currentMaterial
  const cadence = material.userData.geoflightCadence as CloudCadence | undefined
  cadence?.drift.setScalar(0)
  if (!Number.isFinite(dt) || dt <= 0) return
  // The field is sampled at position + offset, so the clouds themselves move by -offset.
  _drift.copy(windECEF).multiplyScalar(Math.min(dt, 0.1))
  ;(material.uniforms.cloudFieldOffset.value as Vector3).sub(_drift)
  cadence?.drift.copy(_drift)
}

const _drift = new Vector3()
const _oldFromWorld = new Matrix4()
const _rebaseRotation = new Quaternion()

/**
 * Invalidate both histories on cuts, teleports and resize. Coverage easing towards live
 * weather moves far less than 0.01 a frame and keeps its history.
 *
 * A floating-origin rebase (every 3 km, so every 20 s in cruise) keeps its history too:
 * discarding it showed as a burst of coarse, unconverged cloud each time. The passes only
 * remember last frame's matrices in world space, so `rebase` moves those into the new frame.
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
  private shadowWidth = 0
  private shadowHeight = 0
  private readonly position = new Vector3()
  private readonly rotation = new Quaternion()
  private readonly sunDirection = new Vector3()

  /** Carry last frame's reprojection into the re-anchored world (`frame.onRebase`). */
  rebase(worldFromOld: Matrix4, origin: number) {
    const effect = this.effect
    // Anything but the very next origin after the last rendered frame resets as before.
    if (!effect || origin !== this.origin + 1 || worldFromOld.elements.some((v) => !Number.isFinite(v))) return
    _oldFromWorld.copy(worldFromOld).invert()
    // The view the resolve reprojects through (and, private in the library's types, the
    // one its march writes velocities against).
    const cadence = effect.cloudsPass.currentMaterial.userData.geoflightCadence as CloudCadence | undefined
    if (!cadence?.previousView) return
    cadence.previousView.multiply(_oldFromWorld)
    // The cascades are world-space: a march must not read them through the old origin.
    cadence.force = true
    const march = effect.cloudsPass.currentMaterial as unknown as { previousViewMatrix?: Matrix4 }
    march.previousViewMatrix?.multiply(_oldFromWorld)
    const cascades = effect.shadowPass.currentMaterial.uniforms.reprojectionMatrices.value as Matrix4[]
    for (const cascade of cascades) cascade.multiply(_oldFromWorld)
    this.position.applyMatrix4(worldFromOld)
    this.rotation.premultiply(_rebaseRotation.setFromRotationMatrix(worldFromOld))
    this.origin = origin
  }

  update(effect: CloudsEffect, camera: Camera, origin: number, mode: string, quality: string) {
    // Assets can arrive after the effect mounts. Generate the volume mip chain
    // once on upload, before the march asks for footprint-filtered samples.
    for (const texture of [effect.shapeTexture, effect.shapeDetailTexture]) {
      if (texture instanceof Data3DTexture && !texture.generateMipmaps) {
        texture.generateMipmaps = true
        texture.minFilter = LinearMipmapLinearFilter
        texture.needsUpdate = true
      }
    }
    const { width, height } = effect.resolution
    const darkness = (effect.cloudsPass.currentMaterial.uniforms.nightLighting?.value as number | undefined) ?? 0
    const reset = effect !== this.effect || origin !== this.origin || mode !== this.mode || quality !== this.quality ||
      width !== this.width || height !== this.height || Math.abs(effect.coverage - this.coverage) > 0.01 ||
      Math.abs(darkness - this.darkness) > 0.05 ||
      this.sunDirection.distanceToSquared(effect.sunDirection) > 0.0025 ||
      this.position.distanceToSquared(camera.position) > 100 * 100 ||
      Math.abs(this.rotation.dot(camera.quaternion)) < 0.9
    // The shadow maps resize with the adaptive cloud level, on their own schedule.
    const shadowSize = effect.shadowMaps.mapSize
    const shadowReset = reset || shadowSize.x !== this.shadowWidth || shadowSize.y !== this.shadowHeight
    this.shadowWidth = shadowSize.x
    this.shadowHeight = shadowSize.y
    syncUpscaleInputs(effect, camera)
    effect.cloudsPass.resolveMaterial.uniforms.resetHistory.value = reset
    effect.shadowPass.resolveMaterial.uniforms.resetHistory.value = shadowReset
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
