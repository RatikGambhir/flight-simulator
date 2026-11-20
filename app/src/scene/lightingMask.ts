import type { LightingMaskPass } from '@takram/three-atmosphere'
import type { ShaderMaterial } from 'three'

/**
 * The stock lighting-mask shader decodes depth as if the buffer were linear
 * perspective depth. With the logarithmic depth buffer every sample collapses
 * to nearly the same value, so a masked object counts as visible even when
 * terrain hides it. Require a match with the visible depth, since the opaque
 * override can also draw windows and other surfaces that never wrote scene depth.
 */
const LIGHTING_MASK_FRAG = /* glsl */ `
#include <common>
#include <packing>
uniform highp sampler2D depthBuffer0;
uniform highp sampler2D depthBuffer1;
uniform bool inverted;
varying vec2 vUv;
void main() {
  float scene = unpackRGBAToDepth(texture2D(depthBuffer0, vUv));
  float selected = unpackRGBAToDepth(texture2D(depthBuffer1, vUv));
  bool keep = scene < 1.0 && selected < 1.0 && abs(selected - scene) <= 2e-7;
  if (inverted) keep = !keep;
  if (!keep) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
}`

export function patchLightingMask(pass: LightingMaskPass | null) {
  const material = (pass as unknown as { depthMaskMaterial?: ShaderMaterial } | null)?.depthMaskMaterial
  if (!material || material.fragmentShader === LIGHTING_MASK_FRAG) return
  material.fragmentShader = LIGHTING_MASK_FRAG
  material.needsUpdate = true
}
