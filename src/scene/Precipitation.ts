// Rain and snow as a screen-space effect.
//
// In the camera's frame every drop moves along one direction: its fall speed
// plus the wind, minus the camera's own velocity. The shader samples a field
// of streaks parallel to that axis on a few cylinders around the eye, so
// streaks fall straight down when parked and converge on the flight path at
// speed, with no particles to simulate. It runs after tone mapping (display
// referred), so it does not disturb the post-process lighting, and it is
// depth tested per shell so the cockpit interior stays dry.

import { BlendFunction, Effect, EffectAttribute } from 'postprocessing'
import { Quaternion, Uniform, Vector2, Vector3, type PerspectiveCamera } from 'three'

const frag = /* glsl */ `
uniform float intensity;
uniform float snow;
uniform vec3 axis;
uniform vec3 basisU;
uniform vec3 basisV;
uniform float travel;
uniform float streak;
uniform vec2 halfFov;
uniform float pixelAngle;
uniform float light;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// One cylinder of streaks, "rho" metres from the motion axis through the eye.
// A streak is a line parallel to that axis, so on screen it keeps its azimuth
// around the axis and runs towards the vanishing point. Returns coverage 0..1.
float shell(const vec3 dir, const float sinT, const float cosT, const float phi, const float rho, const float columns, const float sceneZ, const float seed) {
  float dist = rho / sinT;
  if (dist > 70.0 || sceneZ < dist * -dir.z) return 0.0;
  float x = phi * columns / 6.2831853 + seed * 13.7;
  float id = floor(x);
  float h = hash21(vec2(id, seed));
  // Heavier precipitation fills more columns.
  if (h > intensity * 0.85 + 0.1) return 0.0;
  float centre = (hash21(vec2(id, seed + 3.1)) - 0.5) * 0.6;
  // Flakes flutter sideways as they fall; drops do not.
  centre += snow * 0.22 * sin(time * (1.1 + h * 1.3) + h * 40.0);
  float arc = abs(fract(x) - 0.5 - centre) * (6.2831853 * rho / columns);
  // Never thinner than a pixel; a drop is ~2 mm, a flake ~1 cm.
  float footprint = dist * pixelAngle;
  float radius = max(mix(0.002, 0.005, snow), footprint * 0.6);
  float line = 1.0 - smoothstep(radius * 0.6, radius * 1.6, arc);
  // Dashes along the motion axis, scrolling with the distance travelled.
  float period = streak * mix(3.0, 6.0, hash21(vec2(id, seed + 4.1)));
  // Drop sizes differ, so neighbouring streaks fall at slightly different speeds.
  float pace = mix(0.82, 1.18, hash21(vec2(id, seed + 6.3)));
  float along = fract((rho * cosT / sinT - travel * pace) / period + h * 7.0);
  float duty = streak / period;
  float dash = smoothstep(0.0, duty * 0.3, along) * (1.0 - smoothstep(duty * 0.7, duty, along));
  // Sub-pixel drops deposit proportionally less light.
  float energy = clamp(mix(0.004, 0.012, snow) / (footprint * 1.2), 0.2, 1.0);
  // Towards the vanishing point a dash shrinks below a pixel and would alias into a dot lattice.
  float dashPixels = streak * sinT * sinT / (rho * pixelAngle);
  return line * dash * energy * smoothstep(0.8, 2.5, dashPixels);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  if (intensity < 0.004) {
    outputColor = inputColor;
    return;
  }
  vec3 dir = normalize(vec3((uv * 2.0 - 1.0) * halfFov, -1.0));
  // At the far plane the view-depth conversion divides by zero in single precision.
  float sceneZ = depth >= 0.9999999 ? 1e9 : -getViewZ(depth);
  float cosT = dot(dir, axis);
  float sinT = max(length(cross(dir, axis)), 1e-3);
  float phi = atan(dot(dir, basisV), dot(dir, basisU));
  float a = 0.0;
  a += shell(dir, sinT, cosT, phi, 0.7, 44.0, sceneZ, 0.0);
  a += shell(dir, sinT, cosT, phi, 1.5, 60.0, sceneZ, 1.0) * 0.9;
  a += shell(dir, sinT, cosT, phi, 3.2, 84.0, sceneZ, 2.0) * 0.8;
  a += shell(dir, sinT, cosT, phi, 6.5, 120.0, sceneZ, 3.0) * 0.7;
  a += shell(dir, sinT, cosT, phi, 13.0, 180.0, sceneZ, 4.0) * 0.6;
  a = clamp(a, 0.0, 1.0) * mix(0.16, 0.5, snow);
  vec3 tint = mix(vec3(0.72, 0.78, 0.86), vec3(0.96, 0.97, 1.0), snow) * light;
  // Falling water between the eye and distant scenery washes it out a little.
  float veil = intensity * 0.12 * smoothstep(30.0, 600.0, sceneZ);
  vec3 c = mix(inputColor.rgb, vec3(0.55, 0.58, 0.62) * light, veil);
  // Streaks only ever brighten: a drop scatters light towards the eye, even against a bright sky.
  vec3 lit = max(tint, c + (1.0 - c) * 0.3 * light);
  outputColor = vec4(mix(c, lit, a), inputColor.a);
}`

const EAST = new Vector3(1, 0, 0)
const _rel = new Vector3()
const _ref = new Vector3()
const _inv = new Quaternion()

/**
 * Terminal fall speeds (m/s). Raindrops grow with rainfall rate: drizzle (0.5 mm
 * drops) settles at about 2-4 m/s, a downpour (3-5 mm) at about 9. Snowflakes
 * are all drag and drift down at 1-1.5 m/s, so they follow the wind far more.
 */
const RAIN_FALL_LIGHT = 4
const RAIN_FALL_HEAVY = 9
const SNOW_FALL = 1.3
/** Apparent streak length = speed x how long the eye integrates. */
const RAIN_EXPOSURE = 1 / 110
const SNOW_EXPOSURE = 1 / 600

export class PrecipitationEffect extends Effect {
  constructor() {
    super('PrecipitationEffect', frag, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, Uniform>([
        ['intensity', new Uniform(0)],
        ['snow', new Uniform(0)],
        ['axis', new Uniform(new Vector3(0, -1, 0))],
        ['basisU', new Uniform(new Vector3(1, 0, 0))],
        ['basisV', new Uniform(new Vector3(0, 0, 1))],
        ['travel', new Uniform(0)],
        ['streak', new Uniform(0.3)],
        ['halfFov', new Uniform(new Vector2(1, 1))],
        ['pixelAngle', new Uniform(0.001)],
        ['light', new Uniform(1)],
      ]),
    })
  }

  /**
   * @param intensity 0 dry .. 1 heavy
   * @param snow 0 rain .. 1 snow
   * @param wind air velocity in world space (m/s)
   * @param cameraVelocity camera velocity in world space (m/s)
   * @param up local vertical in world space
   * @param light 0 night .. 1 full daylight
   */
  setFrame(camera: PerspectiveCamera, dt: number, intensity: number, snow: number, wind: Vector3, cameraVelocity: Vector3, up: Vector3, light: number, viewportHeight: number) {
    const u = this.uniforms
    u.get('intensity')!.value = intensity
    if (intensity < 0.004) return
    u.get('snow')!.value = snow
    u.get('light')!.value = light

    const rainFall = RAIN_FALL_LIGHT + (RAIN_FALL_HEAVY - RAIN_FALL_LIGHT) * Math.min(1, intensity)
    const fall = rainFall + (SNOW_FALL - rainFall) * snow
    _rel.copy(wind).addScaledVector(up, -fall).sub(cameraVelocity)
    const speed = Math.max(_rel.length(), 0.5)
    _rel.divideScalar(speed)
    const exposure = RAIN_EXPOSURE + (SNOW_EXPOSURE - RAIN_EXPOSURE) * snow
    u.get('streak')!.value = Math.min(1.4, Math.max(snow > 0.5 ? 0.012 : 0.12, speed * exposure))
    // Distance travelled along the axis; wrapped to keep float precision in the shader.
    const travel = u.get('travel')!
    travel.value = (travel.value + speed * dt) % 4096

    // A perpendicular basis that turns smoothly with the axis.
    _ref.copy(Math.abs(_rel.dot(up)) > 0.9 ? EAST : up)
    const basisU = (u.get('basisU')!.value as Vector3).crossVectors(_rel, _ref).normalize()
    const basisV = (u.get('basisV')!.value as Vector3).crossVectors(_rel, basisU)
    const axis = (u.get('axis')!.value as Vector3).copy(_rel)

    // The shader works in view space.
    _inv.copy(camera.quaternion).invert()
    axis.applyQuaternion(_inv)
    basisU.applyQuaternion(_inv)
    basisV.applyQuaternion(_inv)

    const tan = Math.tan((camera.fov * Math.PI) / 360)
    ;(u.get('halfFov')!.value as Vector2).set(tan * camera.aspect, tan)
    u.get('pixelAngle')!.value = (2 * tan) / Math.max(1, viewportHeight)
  }
}
