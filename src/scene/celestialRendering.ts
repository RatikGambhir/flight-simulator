import type { SkyMaterial, StarsMaterial } from '@takram/three-atmosphere'
import { Matrix4, Uniform, Vector3, type Texture } from 'three'

function replace(source: string, from: string, to: string) {
  if (!source.includes(from)) throw new Error(`Celestial shader changed: missing ${from}`)
  return source.replace(from, to)
}

/** Add NASA's lunar surface map to the atmosphere's existing phase-lit Moon. */
export function prepareMoon(material: SkyMaterial, texture: Texture) {
  if (material.userData.geoflightMoon) return
  let source = material.fragmentShader
  source = `uniform highp sampler2D lunarMap;\nuniform highp mat4 moonFixedFromECEF;\nuniform highp vec3 moonSunDirection;\n${source}`
  source = replace(source, 'float diffuse = orenNayarDiffuse(-sunDirection, rayDirection, normal);', `
    float diffuse = orenNayarDiffuse(-moonSunDirection, rayDirection, normal);
    vec3 surface = normalize(mat3(moonFixedFromECEF) * -normal);
    vec2 lunarUv = vec2(atan(surface.y, surface.x) / (2.0 * PI) + 0.5,
      asin(clamp(surface.z, -1.0, 1.0)) / PI + 0.5);
    vec3 albedo = texture(lunarMap, lunarUv).rgb;
  `)
  source = replace(source, 'float antialias = smoothstep(moonAngularRadius, moonAngularRadius - fragmentAngle, angle);',
    'float antialias = 1.0 - smoothstep(max(0.0, moonAngularRadius - fragmentAngle), moonAngularRadius, angle);')
  source = replace(source, 'lunarRadianceScale *\n      diffuse *', 'lunarRadianceScale * albedo *\n      diffuse *')
  material.fragmentShader = source
  material.uniforms.lunarMap = new Uniform(texture)
  material.uniforms.moonFixedFromECEF = new Uniform(new Matrix4())
  material.uniforms.moonSunDirection = new Uniform(new Vector3())
  material.userData.geoflightMoon = true
  material.needsUpdate = true
}

/** Soft, small stellar discs, preserving the catalog's magnitudes and colors. */
export function prepareStars(material: StarsMaterial) {
  if (material.userData.geoflightStars) return
  let source = material.fragmentShader
  source = `uniform highp vec3 starMoonDirection;\nuniform highp float starMoonCosRadius;\n${source}`
  source = replace(source, 'vec3 rayDirection = normalize(vRayDirection);', `
    vec3 rayDirection = normalize(vRayDirection);
    if (dot(rayDirection, starMoonDirection) > starMoonCosRadius) discard;
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
  material.uniforms.starMoonCosRadius = new Uniform(1)
  // Background points must not enter terrain depth reconstruction.
  material.depthWrite = false
  material.userData.geoflightStars = true
  material.needsUpdate = true
}
