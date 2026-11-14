import type { Effect } from 'postprocessing'
import { WGS84_A, WGS84_F } from '../world/frame'
import { CLOUD_SHADOW_RANGE, type VolumetricCloudPass } from './VolumetricCloudPass'

const SAMPLING = /* glsl */ `
uniform highp sampler2D cloudGroundMap;
uniform vec3 cloudGroundEast;
uniform vec3 cloudGroundNorth;
uniform vec2 cloudGroundOffset;
uniform float cloudGroundStrength;
uniform vec4 cloudGroundProfile;

float cloudGroundTransmission(vec3 viewPosition, vec3 positionECEF) {
  if (cloudGroundStrength <= 0.0) return 1.0;
  // A map texel stores the whole deck's transmission. Fade its effect when
  // a mountain reaches into the clouds, and leave peaks above them in sun.
  vec3 geographicPosition = (positionECEF - vGeometryAltitudeCorrection) / METER_TO_LENGTH_UNIT;
  float surfaceHeight = length(geographicPosition * vec3(1.0, 1.0, ${(1 / (1 - WGS84_F)).toFixed(9)})) - ${WGS84_A.toFixed(1)};
  float below = 1.0 - smoothstep(cloudGroundProfile.x, cloudGroundProfile.y, surfaceHeight);
  vec3 relative = mat3(worldToECEFMatrix) * mat3(inverseViewMatrix) * viewPosition;
  vec2 xy = vec2(dot(relative, cloudGroundEast), dot(relative, cloudGroundNorth)) + cloudGroundOffset;
  vec2 uv = xy / ${(CLOUD_SHADOW_RANGE * 2).toFixed(1)} + 0.5;
  float center = max(abs(uv.x - 0.5), abs(uv.y - 0.5));
  float weight = 1.0 - smoothstep(0.37, 0.50, center);
  return mix(1.0, texture2D(cloudGroundMap, uv).r, cloudGroundStrength * below * weight);
}
`

/** Shadows attenuate direct sun before atmosphere, water and night lighting. */
export function bindCloudGroundLighting(effect: Effect, pass: VolumetricCloudPass) {
  if (effect.uniforms.has('cloudGroundMap')) return
  for (const [name, uniform] of Object.entries(pass.groundShadow)) effect.uniforms.set(name, uniform)
  const source = effect.getFragmentShader()
    .replace('void mainImage(', `${SAMPLING}\nvoid mainImage(`)
    .replace('  #ifdef HAS_SHADOW\n  sunIrradiance *= sunTransmittance;\n  #endif // HAS_SHADOW',
      '  sunIrradiance *= sunTransmittance;')
    .replace('  float sunTransmittance = 1.0;', '  float sunTransmittance = cloudGroundTransmission(viewPosition, positionECEF);')
  if (!source.includes(' = cloudGroundTransmission(viewPosition')) throw new Error('Aerial perspective shadow shader changed')
  const target = effect as unknown as { setFragmentShader(source: string): void }
  target.setFragmentShader(source)
}
