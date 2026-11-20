import {
  LinearFilter, LinearMipmapLinearFilter, Mesh, OrthographicCamera, PlaneGeometry, RedFormat, RepeatWrapping, ShaderMaterial,
  UnsignedByteType, type WebGLRenderer, WebGLRenderTarget,
} from 'three'

export const EARTH_SPACE_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 earthNormal;
  varying float viewDepth;
  void main() {
    earthNormal = normalize(normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    viewDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`

const NOISE = /* glsl */ `
  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  float vnoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }`

const EARTH_COMMON = /* glsl */ `
  uniform float cloudAmount;
  uniform sampler2D cloudMap;
  varying vec3 earthNormal;
  ${NOISE}
  vec2 earthCoord(vec3 n) {
    return vec2(atan(n.y, n.x) / 6.28318530718 + 0.5, asin(clamp(n.z, -1.0, 1.0)) / 3.14159265359 + 0.5);
  }
  /** Equirectangular lookup without the one-pixel mip seam where longitude wraps. */
  vec4 sampleEquirect(sampler2D map, vec2 uv) {
    vec2 dx = dFdx(uv), dy = dFdy(uv);
    float wrapped = fract(uv.x + 0.5);
    vec2 dx2 = vec2(dFdx(wrapped), dx.y), dy2 = vec2(dFdy(wrapped), dy.y);
    if (dot(dx2, dx2) + dot(dy2, dy2) < dot(dx, dx) + dot(dy, dy)) { dx = dx2; dy = dy2; }
    return textureGrad(map, uv, dx, dy);
  }
  /** Baked weather plus two cheap octaves of edge detail for close views. */
  float cloudCover(vec3 n, vec2 uv) {
    if (cloudAmount <= 0.0) return 0.0;
    float margin = (sampleEquirect(cloudMap, uv).r - 0.5) * 0.5;
    margin += (vnoise(n * 640.0) - 0.5) * 0.04 + (vnoise(n * 1400.0) - 0.5) * 0.02;
    return smoothstep(0.0, 0.09, margin) * cloudAmount;
  }`

/**
 * Surface albedo (imagery under procedural clouds). The atmosphere pass lights
 * it exactly like streamed scenery, so the hand-over from tiles is seamless.
 */
export const EARTH_SPACE_FRAGMENT = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D dayMap;
  uniform float brightness;
  ${EARTH_COMMON}
  void main() {
    #include <logdepthbuf_fragment>
    vec3 n = normalize(earthNormal);
    vec2 uv = earthCoord(n);
    vec3 day = sampleEquirect(dayMap, uv).rgb;
    // This map has a blue haze baked in, and the atmosphere pass adds the real
    // one. Strip the veil, lift only the dark land tones towards the brightness
    // of streamed imagery, and keep the open ocean a deep blue.
    float ocean = smoothstep(0.02, 0.032, day.b - day.r) * (1.0 - smoothstep(0.03, 0.08, day.r));
    vec3 land = max(day - vec3(0.004, 0.006, 0.02), 0.0) * vec3(1.0, 1.08, 0.85);
    land *= 1.0 + 1.6 * exp(-land * 12.0);
    vec3 sea = max(day - vec3(0.005, 0.009, 0.012), 0.0);
    day = mix(land, sea, ocean);
    day = mix(day, vec3(0.72, 0.73, 0.75), cloudCover(n, uv));
    gl_FragColor = vec4(day * brightness, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`

/** City lights on the night side, added after atmospheric lighting (which would black them out). */
export const EARTH_NIGHT_FRAGMENT = /* glsl */ `
  uniform sampler2D nightMap;
  uniform vec3 sunECEF;
  uniform float intensity;
  uniform sampler2D uDepth;
  uniform float uHasDepth;
  uniform float uLogFar;
  varying float viewDepth;
  ${EARTH_COMMON}
  void main() {
    if (uHasDepth > 0.5) {
      float d = texelFetch(uDepth, ivec2(gl_FragCoord.xy), 0).r;
      // Hidden by the orbiter, the station or anything nearer than the surface.
      if (d < 1.0 && viewDepth > (exp2(d * uLogFar) - 1.0) * 1.002 + 50.0) discard;
    }
    vec3 n = normalize(earthNormal);
    float dark = 1.0 - smoothstep(-0.15, 0.04, dot(n, sunECEF));
    if (dark <= 0.0) discard;
    vec2 uv = earthCoord(n);
    float night = sampleEquirect(nightMap, uv).r * (1.0 - 0.8 * cloudCover(n, uv));
    gl_FragColor = vec4(vec3(1.0, 0.59, 0.22) * night * dark * intensity, 1.0);
  }`

const CLOUD_BAKE_FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  ${NOISE}
  float fbm(vec3 p, int octaves) {
    float f = 0.0, a = 0.5;
    for (int i = 0; i < 7; i++) {
      if (i >= octaves) break;
      f += a * vnoise(p);
      p = p * 2.03 + vec3(1.7, 9.2, 3.1);
      a *= 0.5;
    }
    return f;
  }
  void main() {
    float lon = (vUv.x - 0.5) * 6.28318530718, lat = (vUv.y - 0.5) * 3.14159265359;
    vec3 n = vec3(cos(lat) * cos(lon), cos(lat) * sin(lon), sin(lat));
    // Swirled cloud fields, a cloudy equator and storm tracks, clear subtropics.
    vec3 p = n * 9.0;
    vec3 warp = vec3(fbm(p + 3.1, 3), fbm(p + 7.7, 3), fbm(p + 1.3, 3));
    float c = fbm(p * 2.1 + warp * 1.1, 7);
    float l = abs(n.z);
    float threshold = 0.56 - 0.1 * exp(-pow(l / 0.12, 2.0)) - 0.09 * exp(-pow((l - 0.78) / 0.14, 2.0)) + 0.07 * exp(-pow((l - 0.42) / 0.11, 2.0));
    // Signed margin above the cloud threshold, 0.5 at the edge of a cloud.
    gl_FragColor = vec4(clamp(0.5 + (c - threshold) * 2.0, 0.0, 1.0), 0.0, 0.0, 1.0);
  }`

/**
 * Renders the global cloud field once into a mipmapped 4096x2048 single-channel
 * map (~11 MB). Evaluating it per pixel cost 16 noise octaves in each of two
 * full-screen globe shaders every frame.
 */
export function bakeCloudMap(renderer: WebGLRenderer) {
  const target = new WebGLRenderTarget(4096, 2048, {
    format: RedFormat, type: UnsignedByteType, depthBuffer: false, generateMipmaps: true,
    minFilter: LinearMipmapLinearFilter, magFilter: LinearFilter, wrapS: RepeatWrapping,
  })
  const material = new ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: CLOUD_BAKE_FRAGMENT,
    depthTest: false, depthWrite: false,
  })
  const quad = new Mesh(new PlaneGeometry(2, 2), material)
  quad.frustumCulled = false
  const previous = renderer.getRenderTarget()
  renderer.setRenderTarget(target)
  renderer.render(quad, new OrthographicCamera(-1, 1, 1, -1, 0, 1))
  renderer.setRenderTarget(previous)
  quad.geometry.dispose()
  material.dispose()
  return target
}
