export const cloudVolumeVertex = /* glsl */ `
out vec2 screenUv;
void main() {
  screenUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

export const cloudVolumeFragment = /* glsl */ `
precision highp float;
precision highp sampler2D;
precision highp sampler3D;

in vec2 screenUv;
uniform sampler3D noiseField;
#ifdef SHADOW_PASS
out vec4 shadowColor;
uniform vec3 sunDirection;
uniform vec3 shadowEast;
uniform vec3 shadowNorth;
#else
out vec4 cloudColor;
uniform sampler2D sceneDepth;
uniform mat4 inverseProjection;
uniform mat3 ecefFromView;
#endif
uniform vec3 eyeScaled;
uniform float eyeRadius;
uniform float eyeAltitude;
uniform vec3 weatherPhase;
uniform vec3 spacingPhase;
uniform vec3 shapePhase;
uniform vec3 detailPhase;
uniform vec3 cirrusPhase;
uniform vec3 lightDirection;
uniform vec3 directLight;
uniform vec3 skyLight;
uniform vec3 hazeColor;
uniform float coverage;
uniform vec4 cloudProfile; // base, top, stratiform fraction, convective fraction
uniform vec3 middleCloud; // base, top, coverage
uniform vec3 highCloud;
uniform float hazeDensity;
uniform float groundHeight;
uniform float cameraFar;
uniform bool logarithmicDepth;
uniform int stepBudget;

const float noHit = 1e9;
const float maxDistance = 160000.0;
const float extinction = 0.008;

vec3 ellipsoidScale(vec3 p) {
  return p * vec3(1.0, 1.0, POLAR_SCALE);
}

float heightAt(vec3 offset) {
  vec3 p = ellipsoidScale(offset);
  // Difference of radii written without subtracting Earth-sized numbers.
  return eyeAltitude + dot(p, 2.0 * eyeScaled + p) / (length(eyeScaled + p) + eyeRadius);
}

vec2 shell(float height, float a, float b) {
  float dh = height - eyeAltitude;
  float c = dh * (2.0 * eyeRadius + dh);
  float disc = b * b + a * c;
  if (disc < 0.0) return vec2(noHit, -noHit);
  float root = sqrt(disc);
  float q = -b - (b < 0.0 ? -root : root);
  float t0 = q / a;
  float t1 = abs(q) > 1e-4 ? -c / q : t0;
  return vec2(min(t0, t1), max(t0, t1));
}

float densityAt(vec3 p, float height, float detailWeight, float shapeLod) {
  float h = (height - cloudProfile.x) / (cloudProfile.y - cloudProfile.x);
  if (h <= 0.0 || h >= 1.0) return 0.0;
  // Sample coverage on the ground beneath the ray. The weather field sets
  // updraft locations and cloud tops independently of the 3D billows.
  vec3 radial = normalize(eyeScaled + ellipsoidScale(p));
  vec3 groundOffset = p - radial * height;
  vec2 weather = textureLod(noiseField, weatherPhase + groundOffset / WEATHER_PERIOD, 0.0).ra;
  float sheet = cloudProfile.z;
  float storm = cloudProfile.w;
  float field = weather.x - mix(0.74, 0.38, coverage);
  if (field < -0.26) return 0.0;
  vec4 spacing = textureLod(noiseField, spacingPhase + groundOffset / SPACING_PERIOD, 0.0);
  // The nearby banks share a smoothly warped coordinate system. Different
  // offsets stretch and tilt their lobes without any time-dependent warping.
  vec3 warp = (spacing.gba - vec3(0.46, 0.45, 0.5)) * vec3(1280.0, 1520.0, 1280.0) * (1.0 - 0.66 * sheet);
  warp += radial * ((spacing.a - 0.5) * 610.0 * h);
  // Tilt and elongate the volume differently in each weather cell. Vertical
  // compression of the coordinates keeps a storm's billows connected.
  vec3 shapePosition = groundOffset + radial * height * (1.0 - 0.64 * storm) + warp;
  float shape = textureLod(noiseField, shapePhase + shapePosition / SHAPE_PERIOD, shapeLod).g;
  // Wetter banks connect nearby puffs. Independent cloud type varies the
  // height profile from broad, low banks to taller convective billows.
  float bank = smoothstep(0.26, 0.67, spacing.r);
  float towers = smoothstep(0.37, 0.79, weather.y * 0.72 + spacing.a * 0.28);
  float top = 0.34 + towers * (0.48 + 0.20 * storm) + (shape - 0.47) * 1.11 + field * 0.25;
  top = clamp(mix(top, 0.69 + 0.18 * spacing.a + 0.18 * field, sheet), 0.21, 1.0);
  if (h >= top) return 0.0;
  float cap = smoothstep(0.0, 0.092, top - h);
  float base = smoothstep(0.0, 0.060 + 0.032 * (1.0 - bank), h);
  float body = (shape - 0.52) * 0.98 + field * 0.46 + (bank - 0.53) * 0.30
    + (coverage - 0.35) * 0.56 - 0.079 * h;
  float sheetBody = (shape - 0.48) * 0.30 + field * 0.76 + (bank - 0.48) * 0.12
    + (coverage - 0.37) * 0.46;
  body = mix(body, sheetBody, sheet);
  body += storm * ((towers - 0.35) * 0.15 - 0.12 * h * (1.0 - towers));
  float smallScale = detailWeight * (1.0 - 0.73 * sheet);
  if (body <= -0.17 * smallScale) return 0.0;
  if (smallScale > 0.0 && body < 0.26) {
    float detail = textureLod(noiseField, detailPhase + (p + warp * 0.35) / DETAIL_PERIOD, shapeLod).b;
    // Ruffle the surface around the density isosurface and erode thin
    // pockets into the billows. Deep interiors keep their coarse density.
    body += (detail - 0.49) * 0.33 * smallScale * (1.0 - smoothstep(0.09, 0.26, body));
  }
  return smoothstep(0.0, 0.155, body) * base * cap;
}

#ifdef SHADOW_PASS
void main() {
  // Each map texel follows a parallel sun ray through the same cloud volume.
  vec2 xy = (screenUv - 0.5) * (2.0 * SHADOW_RANGE);
  vec3 p = shadowEast * xy.x + shadowNorth * xy.y;
  vec3 ray = ellipsoidScale(sunDirection);
  vec3 anchor = eyeScaled + ellipsoidScale(p);
  float dh = heightAt(p) - eyeAltitude;
  float a = dot(ray, ray);
  float b = dot(anchor, ray);
  float outerDelta = cloudProfile.y - eyeAltitude - dh;
  float innerDelta = cloudProfile.x - eyeAltitude - dh;
  float radius = eyeRadius + dh;
  float outer = outerDelta * (radius + radius + outerDelta);
  float inner = innerDelta * (radius + radius + innerDelta);
  // Stable positive-side roots, even when the aircraft is above the deck.
  float end = outer / (b + sqrt(max(0.0, b * b + a * outer)));
  float start = inner / (b + sqrt(max(0.0, b * b + a * inner)));
  int samples = cloudProfile.w > 0.25 ? 18 : 12;
  float ds = (end - start) / float(samples);
  float opticalDepth = 0.0;
  for (int i = 0; i < 18; ++i) {
    if (i >= samples) break;
    vec3 samplePosition = p + sunDirection * (start + (float(i) + 0.5) * ds);
    opticalDepth += densityAt(samplePosition, heightAt(samplePosition), 0.0, 0.65);
  }
  shadowColor = vec4(exp(-opticalDepth * ds * extinction * smoothstep(0.0, 0.10, coverage)), 0.0, 0.0, 1.0);
}
#else
// Each spherical deck can be crossed on the near side, the far side, or both.
// Return the two intervals in ray order, clipped to the scene depth.
vec4 deckIntervals(vec2 deck, float a, float b, float limit) {
  if (deck.y <= deck.x) return vec4(0.0);
  vec2 outer = shell(deck.y, a, b);
  vec2 inner = shell(deck.x, a, b);
  float start = max(0.0, outer.x);
  float end = min(limit, outer.y);
  if (inner.x >= inner.y) return vec4(start, end, 0.0, 0.0);
  return vec4(start, min(end, inner.x), max(start, inner.y), end);
}

// The thinner upper decks share the existing noise texture and overlay. Sample
// them with a short march so they don't need another full-resolution pass.
void marchUpper(vec3 ray, vec2 interval, vec3 deck, bool cirrus, float phase, inout vec4 sum) {
  float span = interval.y - interval.x;
  if (span <= 0.0 || sum.a > 0.992) return;
  int samples = int(clamp(ceil(span / (cirrus ? 1100.0 : 620.0)), 3.0, 12.0));
  float ds = span / float(samples);
  for (int i = 0; i < 12; ++i) {
    if (i >= samples || sum.a > 0.992) break;
    float d = interval.x + (float(i) + 0.5) * ds;
    vec3 p = ray * d;
    float height = heightAt(p);
    float h = clamp((height - deck.x) / (deck.y - deck.x), 0.0, 1.0);
    vec3 radial = normalize(eyeScaled + ellipsoidScale(p));
    vec3 horizontal = p - radial * height;
    vec3 offset = horizontal / SPACING_PERIOD;
    float density;
    if (cirrus) {
      // Elongate the wisps along a fixed Earth-relative direction.
      vec3 axis = normalize(vec3(0.81, 0.47, 0.34));
      vec3 across = offset - 0.86 * dot(offset, axis) * axis;
      float veil = textureLod(noiseField, weatherPhase + horizontal / WEATHER_PERIOD + vec3(0.13, 0.71, 0.45), 0.0).r;
      float fibres = textureLod(noiseField, cirrusPhase + across + vec3(0.18, 0.34, 0.25 * h), 0.8).b;
      density = smoothstep(0.0, 0.24, 0.62 * veil + 0.56 * fibres - mix(0.88, 0.55, deck.z));
    } else {
      float banks = textureLod(noiseField, spacingPhase + offset + vec3(0.61, 0.28, 0.83), 0.0).r;
      float billows = textureLod(noiseField, shapePhase + (horizontal + radial * (height - deck.x)) / SHAPE_PERIOD, 0.8).g;
      density = smoothstep(0.0, 0.23, 0.58 * banks + 0.62 * billows - mix(0.85, 0.49, deck.z));
    }
    float edge = smoothstep(0.0, 0.19, h) * (1.0 - smoothstep(0.62, 1.0, h));
    float distanceFade = 1.0 - smoothstep(45000.0, maxDistance, d);
    float alpha = 1.0 - exp(-ds * density * edge * deck.z * distanceFade * (cirrus ? 0.00025 : 0.0017));
    vec3 light = skyLight * mix(0.62, 0.95, h) + directLight * (cirrus ? 0.64 : 0.45) * phase;
    light = mix(light, hazeColor, 1.0 - exp(-(0.000007 + hazeDensity * 0.22) * d));
    sum += (1.0 - sum.a) * alpha * vec4(light, 1.0);
  }
}

void march(vec3 ray, float start, float end, float phase, float sampleOffset, inout vec4 sum) {
  float span = end - start;
  if (span <= 0.0) return;
  // Spend more of the budget near the start of long, grazing rays. Uniformly
  // dividing those rays used kilometre-wide steps through nearby cloud edges.
  float budget = min(float(stepBudget) * (1.0 + 0.45 * smoothstep(10000.0, 40000.0, span)),
    max(1.0, span / (32.0 + start * 0.007)));
  // Long paths that enter close to the eye need fine steps at the front.
  // For an already distant deck the same bias starves its middle and back.
  float bias = 0.86 * smoothstep(8000.0, 58000.0, span) * (1.0 - smoothstep(14000.0, 55000.0, start));
  float attenuation = extinction * smoothstep(0.0, 0.10, coverage);
  float t = start;
  for (int i = 0; i < 116; ++i) {
    if (float(i) >= budget || t >= end || sum.a > 0.992) break;
    float u = min(1.0, float(i + 1) / budget);
    float next = start + span * mix(u, u * u * u, bias);
    float ds = next - t;
    // A small, continuous shift indexed by the Earth-fixed ray direction
    // breaks up coherent bands without reintroducing per-pixel noise.
    float d = t + ds * (0.5 + sampleOffset);
    if (d >= maxDistance * 0.76) break;
    t = next;
    vec3 p = ray * d;
    float h = heightAt(p);
    float detailWeight = 1.0 - smoothstep(16000.0, 53000.0, d);
    // Match the volume's level of detail to the integration step. Derivatives
    // of texture coordinates inside the divergent march are undefined.
    float lod = clamp(log2(max(1.0, ds * 132.0 / SHAPE_PERIOD)), 0.0, 3.2);
    float density;
    if (ds < 120.0) {
      density = densityAt(p, h, detailWeight, lod);
    } else if (ds < 340.0) {
      // Average quadrature samples over long steps before applying
      // extinction. This removes the screen-space speckles of one jittered
      // sample without blurring the composite across the aircraft silhouette.
      vec3 offset = ray * (ds * 0.288675);
      vec3 nearSample = p - offset;
      vec3 farSample = p + offset;
      float nearDensity = densityAt(nearSample, heightAt(nearSample), detailWeight, lod);
      float farDensity = densityAt(farSample, heightAt(farSample), detailWeight, lod);
      density = 0.5 * (nearDensity + farDensity);
      // Light the sampled cloud, even when the step midpoint is in clear air.
      p += offset * ((farDensity - nearDensity) / max(0.001, nearDensity + farDensity));
      h = heightAt(p);
    } else {
      vec3 offset = ray * (ds * 0.387298);
      vec3 nearSample = p - offset;
      vec3 farSample = p + offset;
      float nearDensity = (5.0 / 18.0) * densityAt(nearSample, heightAt(nearSample), detailWeight, lod);
      float farDensity = (5.0 / 18.0) * densityAt(farSample, heightAt(farSample), detailWeight, lod);
      density = (4.0 / 9.0) * densityAt(p, h, detailWeight, lod) + nearDensity + farDensity;
      p += offset * ((farDensity - nearDensity) / max(0.001, density));
      h = heightAt(p);
    }
    if (density < 0.001) continue;
    vec3 lightProbe = p + lightDirection * 95.0;
    float shadow = 240.0 * densityAt(lightProbe, heightAt(lightProbe), detailWeight, lod);
    lightProbe = p + lightDirection * 350.0;
    shadow += 320.0 * densityAt(lightProbe, heightAt(lightProbe), 0.0, lod);
    lightProbe = p + lightDirection * 795.0;
    shadow += 550.0 * densityAt(lightProbe, heightAt(lightProbe), 0.0, lod);
    // Strong contrast in the first scattering order, with a softer contribution
    // from light that bounced through the cloud before reaching this point.
    float illumination = 0.82 * exp(-shadow * 0.012) + 0.18 * exp(-shadow * 0.0035);
    float ambient = mix(0.19, 0.78, smoothstep(cloudProfile.x, mix(cloudProfile.x, cloudProfile.y, 0.86), h));
    ambient *= mix(0.59, 1.0, exp(-shadow * 0.0026));
    vec3 radiance = skyLight * ambient + directLight * phase * illumination;
    float haze = 1.0 - exp(-(0.000007 + hazeDensity * 0.22) * d);
    radiance = mix(radiance, hazeColor, haze);
    // Fade unresolved distant volumes into the atmosphere before the small
    // structures collapse into visible, evenly spaced horizontal layers.
    float distant = 1.0 - smoothstep(14000.0, maxDistance * 0.76, d);
    float alpha = 1.0 - exp(-ds * density * attenuation * distant * distant);
    sum += (1.0 - sum.a) * alpha * vec4(radiance, 1.0);
  }
}

void main() {
  cloudColor = vec4(0.0);
  if (coverage <= 0.001) return;
  vec4 view = inverseProjection * vec4(screenUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 viewRay = normalize(view.xyz);
  vec3 ray = ecefFromView * viewRay;
  vec3 scaled = ellipsoidScale(ray);
  float a = dot(scaled, scaled);
  float b = dot(scaled, eyeScaled);
  float limit = maxDistance;
  float ground = shell(min(0.0, groundHeight), a, b).x;
  if (ground >= 0.0) limit = min(limit, ground);
  float depth = texture(sceneDepth, screenUv).r;
  if (depth < 1.0) {
    vec4 hit = inverseProjection * vec4(0.0, 0.0, depth * 2.0 - 1.0, 1.0);
    float z = logarithmicDepth
      ? exp2(depth * log2(cameraFar + 1.0)) - 1.0
      : -hit.z / hit.w;
    limit = min(limit, z / -viewRay.z);
  }
  float forward = max(0.0, dot(ray, lightDirection));
  float phase = 0.73 + 0.27 * forward + 1.1 * pow(forward, 12.0);
  float sampleOffset = 0.09 * sin(dot(ray, vec3(190.0, 118.0, -160.0)))
    * sin(dot(ray, vec3(-112.0, 175.0, 148.0)));
  vec4 high = highCloud.z > 0.001 ? deckIntervals(highCloud.xy, a, b, limit) : vec4(0.0);
  vec4 middle = middleCloud.z > 0.001 ? deckIntervals(middleCloud.xy, a, b, limit) : vec4(0.0);
  vec4 low = deckIntervals(cloudProfile.xy, a, b, limit);
  marchUpper(ray, high.xy, highCloud, true, phase, cloudColor);
  marchUpper(ray, middle.xy, middleCloud, false, phase, cloudColor);
  march(ray, low.x, low.y, phase, sampleOffset, cloudColor);
  march(ray, low.z, low.w, phase, sampleOffset, cloudColor);
  marchUpper(ray, middle.zw, middleCloud, false, phase, cloudColor);
  marchUpper(ray, high.zw, highCloud, true, phase, cloudColor);
}
#endif
`
