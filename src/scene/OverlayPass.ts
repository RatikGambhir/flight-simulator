// Emissive world-space overlays (the landing guide) drawn after post-process
// lighting, so they glow the same by day and night.
//
// These cues are transparent and write no depth. Drawn in the main scene, they
// either received aerial sun/sky lighting (dark at night) or, when kept out of it
// through the lighting-mask layer, punched a hole in the mask: the mask pass
// draws its selection with a depth-writing override material, so the terrain
// *behind* the guide skipped night lighting and showed its raw daylight imagery.
// Here they composite over the finished HDR image and test against the
// composer's detached scene-depth texture.

import { Pass } from 'postprocessing'
import {
  Scene, Uniform,
  type Camera, type Material, type Texture,
  type WebGLRenderer, type WebGLRenderTarget,
} from 'three'

const DEPTH_TEST = /* glsl */ `
{
  vec2 overlayUv = gl_FragCoord.xy / vec2(textureSize(overlayDepth, 0));
  float sceneDepth = texelFetch(overlayDepth, ivec2(gl_FragCoord.xy), 0).r;
  float overlayFragDepth = gl_FragCoord.z;
  #ifdef USE_LOGARITHMIC_DEPTH_BUFFER
  if (vIsPerspective != 0.0) overlayFragDepth = log2(vFragDepth) * logDepthBufFC * 0.5;
  #endif
  // Hidden by terrain, buildings or the aircraft in front of it.
  if (sceneDepth < 1.0 && overlayFragDepth > sceneDepth + 2e-7) discard;
  // Seen through a cloud: fade by the cloud's own coverage of this pixel.
  overlayCloudFade = hasOverlayClouds ? 1.0 - clamp(texture2D(overlayClouds, overlayUv).a, 0.0, 1.0) : 1.0;
}`

export class OverlayPass extends Pass {
  /** Objects drawn by this pass; keep them out of the main scene. */
  readonly overlay = new Scene()
  private readonly uniforms = {
    overlayDepth: new Uniform<Texture | null>(null),
    overlayClouds: new Uniform<Texture | null>(null),
    hasOverlayClouds: new Uniform(false),
  }

  private readonly view: Camera
  private readonly getCloudOverlay?: () => Texture | null

  constructor(view: Camera, getCloudOverlay?: () => Texture | null) {
    super('OverlayPass')
    this.view = view
    this.getCloudOverlay = getCloudOverlay
    this.needsSwap = false
    this.needsDepthTexture = true
  }

  /** Converts a material to draw in this pass: manual depth test, no depth writes. */
  prepare(material: Material) {
    material.depthTest = false
    material.depthWrite = false
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms)
      const head = 'uniform highp sampler2D overlayDepth;\nuniform sampler2D overlayClouds;\nuniform bool hasOverlayClouds;\n'
      shader.fragmentShader = head + shader.fragmentShader
        .replace('void main() {', 'void main() {\n  float overlayCloudFade = 1.0;')
        .replace('#include <logdepthbuf_fragment>', `#include <logdepthbuf_fragment>\n${DEPTH_TEST}`)
        .replace('#include <opaque_fragment>', '#include <opaque_fragment>\n  gl_FragColor.a *= overlayCloudFade;')
    }
    material.customProgramCacheKey = () => 'geoflight-overlay'
    material.needsUpdate = true
  }

  // Pass is typed as returning Texture, but the composer also uses null when detached.
  override getDepthTexture() { return this.uniforms.overlayDepth.value! }

  override setDepthTexture(depthTexture: Texture | null) {
    this.uniforms.overlayDepth.value = depthTexture
  }

  override render(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget | null) {
    let visible = false
    for (const child of this.overlay.children) visible ||= child.visible
    if (!visible || !inputBuffer || !this.uniforms.overlayDepth.value) return
    const clouds = this.getCloudOverlay?.() ?? null
    this.uniforms.overlayClouds.value = clouds
    this.uniforms.hasOverlayClouds.value = clouds !== null
    const autoClear = renderer.autoClear
    const shadows = renderer.shadowMap.autoUpdate
    renderer.autoClear = false
    renderer.shadowMap.autoUpdate = false
    try {
      renderer.setRenderTarget(this.renderToScreen ? null : inputBuffer)
      renderer.render(this.overlay, this.view)
    } finally {
      renderer.autoClear = autoClear
      renderer.shadowMap.autoUpdate = shadows
    }
  }
}
