import type { SkyMaterial, StarsMaterial } from '@takram/three-atmosphere'
import { Matrix3, Matrix4, Uniform, Vector3, Vector4, type Texture } from 'three'
import { EARTH_POLAR_RATIO, type CelestialState, type LunarView } from './celestial'

function replace(source: string, from: string | RegExp, to: string) {
  if (!(typeof from === 'string' ? source.includes(from) : from.test(source))) {
    throw new Error(`Celestial shader changed: missing ${from}`)
  }
  return source.replace(from, to)
}

const lunarRay = /* glsl */ `
uniform highp mat3 moonRayFromApparent;
uniform highp vec3 moonGeometricDirection;
vec3 lunarRay(vec3 apparentRay) {
  return normalize(moonRayFromApparent * apparentRay);
}
`

/** Correct the atmospheric limb, antialias the Sun, and texture the phase-lit Moon. */
export function prepareSky(material: SkyMaterial, texture: Texture) {
  if (material.userData.geoflightMoon) return
  let source = material.fragmentShader
  source = replace(source, 'vec3 getLunarRadiance(', /* glsl */ `
${lunarRay}
uniform sampler2D lunarMap;
uniform mat4 moonFixedFromECEF;
uniform vec3 moonSunDirection;
uniform vec4 moonHorizon;

vec3 getLunarRadiance(`)
  // SafeSqrt clamps a negative discriminant to zero. From above the LUT's
  // atmosphere, that turns every downward ray that misses the shell into a
  // phantom tangent ray and paints an extra blue band at the local horizontal.
  source = replace(source,
    'Length distance_to_top_atmosphere_boundary = -rmu -\n      SafeSqrt(rmu * rmu - r * r +\n          atmosphere.top_radius * atmosphere.top_radius);',
    `float topDiscriminant = rmu * rmu - (r - atmosphere.top_radius) * (r + atmosphere.top_radius);
      Length distance_to_top_atmosphere_boundary =
        topDiscriminant >= 0.0 ? -rmu - SafeSqrt(topDiscriminant) : -1.0 * m;`)
  // The top rows of the scattering LUT have poor angular resolution. Near
  // the top of the atmosphere they can leak blue into short, skyward rays,
  // leaving a black gap above the real limb. Fade only the scattering of
  // rays that never pass through denser air, before adding the Sun and Moon.
  source = replace(source, '  // Rendering celestial objects without perspective doesn\'t make sense.', /* glsl */ `
  float closestT = max(-dot(cameraPosition, rayDirection), 0.0);
  float tangentAltitude = length(cameraPosition + rayDirection * closestT) - ATMOSPHERE.bottom_radius;
  radiance *= 1.0 - smoothstep(36000.0 * METER_TO_LENGTH_UNIT, 56000.0 * METER_TO_LENGTH_UNIT, tangentAltitude);

  // Rendering celestial objects without perspective doesn't make sense.`)
  source = replace(source, 'float antialias = smoothstep(\n      ATMOSPHERE.sun_angular_radius,\n      ATMOSPHERE.sun_angular_radius - fragmentAngle,\n      angle\n    );', /* glsl */ `
    float radius = ATMOSPHERE.sun_angular_radius;
    float antialias = 1.0 - smoothstep(max(0.0, radius - max(fragmentAngle, 1e-5)), radius, angle);`)
  source = replace(source, 'float fragmentAngle = length(dRDdx + dRDdy) / length(rayDirection);',
    'float fragmentAngle = max(length(dRDdx), length(dRDdy));')
  source = replace(source, /float intersection = intersectSphere\(rayDirection, moonDirection, moonAngularRadius\);[\s\S]*?(?=#endif \/\/ MOON)/, /* glsl */ `
  // Raycast the sphere in angular units, which keeps depth and Earth-scale
  // translations out of the intersection. Cross products retain precision at the limb.
  if (moonAngularRadius > 0.0 && dot(rayDirection, moonDirection) > 0.999) {
    vec3 ray = lunarRay(rayDirection);
    float radius = sin(moonAngularRadius);
    vec3 axis = cross(ray, moonGeometricDirection);
    float distanceToCenter = length(axis);
    float pixelWidth = max(fragmentAngle, 1e-6);
    float edge = min(0.5 * pixelWidth, radius);
    vec3 scaledRay = normalize(vec3(rayDirection.xy, rayDirection.z / ${EARTH_POLAR_RATIO}));
    float clearance = dot(scaledRay, moonHorizon.xyz) - moonHorizon.w;
    if (distanceToCenter < radius + edge && clearance > 0.0) {
      float chord = sqrt(max(0.0, radius * radius - dot(axis, axis)));
      vec3 normal = normalize(cross(ray, axis) - ray * chord);
      vec3 surface = mat3(moonFixedFromECEF) * normal;
      vec2 lunarUv = vec2(atan(surface.y, surface.x) / (2.0 * PI) + 0.5,
        asin(clamp(surface.z, -1.0, 1.0)) / PI + 0.5);
      // Derivatives inside this small, divergent branch are undefined. Estimate
      // the map footprint from the screen ray and its foreshortening at the limb.
      float footprint = float(textureSize(lunarMap, 0).x) * pixelWidth /
        (2.0 * PI * radius * max(0.15, dot(normal, -ray)));
      vec3 albedo = textureLod(lunarMap, lunarUv, max(0.0, log2(footprint))).rgb;
      float coverage = (1.0 - smoothstep(radius - edge, radius + edge, distanceToCenter)) *
        min(1.0, 4.0 * radius * radius / (pixelWidth * pixelWidth));
      float diffuse = orenNayarDiffuse(moonSunDirection, -ray, normal);
      // Surface radiance is independent of range. Only the solid angle changes.
      radiance += transmittance * getLunarRadiance(0.00452) * lunarRadianceScale * albedo *
        diffuse * coverage * smoothstep(0.0, pixelWidth, clearance);
    }
  }
  `)
  material.fragmentShader = source
  material.uniforms.lunarMap = new Uniform(texture)
  material.uniforms.moonFixedFromECEF = new Uniform(new Matrix4())
  material.uniforms.moonSunDirection = new Uniform(new Vector3())
  material.uniforms.moonGeometricDirection = new Uniform(new Vector3())
  material.uniforms.moonRayFromApparent = new Uniform(new Matrix3())
  material.uniforms.moonHorizon = new Uniform(new Vector4())
  material.userData.geoflightMoon = true
  material.needsUpdate = true
}

export function setSkyMoon(material: SkyMaterial, view: LunarView, celestial: CelestialState) {
  material.moonDirection.copy(view.apparentDirection)
  material.moonAngularRadius = view.angularRadius
  material.uniforms.moonGeometricDirection.value = view.direction
  material.uniforms.moonRayFromApparent.value = view.rayFromApparent
  material.uniforms.moonHorizon.value = view.horizon
  material.uniforms.moonFixedFromECEF.value = celestial.moonFixedFromECEF
  material.uniforms.moonSunDirection.value = celestial.moonSunDirection
}

/** Soft, small stellar discs, preserving the catalog's magnitudes and colors. */
export function prepareStars(material: StarsMaterial) {
  if (material.userData.geoflightStars) return
  let source = material.fragmentShader
  // RawShaderMaterial's precision statement is inside the original source.
  source = replace(source, 'void main() {', /* glsl */ `
${lunarRay}
uniform highp vec3 starMoonDirection;
uniform highp float starMoonSinRadius;
void main() {`)
  source = replace(source, 'vec3 rayDirection = normalize(vRayDirection);', `
    vec3 rayDirection = normalize(vRayDirection);
    if (dot(rayDirection, starMoonDirection) > 0.999 &&
        length(cross(lunarRay(rayDirection), moonGeometricDirection)) < starMoonSinRadius) discard;
    float radius = length(gl_PointCoord - 0.5) * 2.0;
    if (radius > 1.0) discard;
    float profile = exp(-radius * radius * 3.0);
  `)
  source = replace(source, 'radiance += transmittance * vColor;', 'radiance += transmittance * vColor * profile;')
  material.fragmentShader = source
  material.vertexShader = replace(material.vertexShader,
    'projectionMatrix * viewMatrix * vec4(cameraPosition + worldDirection * cameraFar, 1.0);',
    'projectionMatrix * viewMatrix * vec4(cameraPosition + worldDirection * cameraFar, 1.0);\n  gl_Position.z = gl_Position.w;')
  material.uniforms.starMoonDirection = new Uniform(new Vector3())
  material.uniforms.starMoonSinRadius = new Uniform(0)
  material.uniforms.moonGeometricDirection = new Uniform(new Vector3())
  material.uniforms.moonRayFromApparent = new Uniform(new Matrix3())
  // Background points must not enter terrain depth reconstruction.
  material.depthWrite = false
  material.userData.geoflightStars = true
  material.needsUpdate = true
}

export function setStarMoon(material: StarsMaterial, view: LunarView) {
  material.uniforms.starMoonDirection.value = view.apparentDirection
  material.uniforms.starMoonSinRadius.value = Math.sin(view.angularRadius)
  material.uniforms.moonGeometricDirection.value = view.direction
  material.uniforms.moonRayFromApparent.value = view.rayFromApparent
}
