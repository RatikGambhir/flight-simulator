// Emissive world-space overlays (the landing guide) drawn after post-process
// lighting, so they glow the same by day and night.
//
// These cues are transparent and write no depth. Drawn in the main scene, they
// either received aerial sun/sky lighting (dark at night) or, when kept out of it
// through the lighting-mask layer, punched a hole in the mask: the mask pass
// draws its selection with a depth-writing override material, so the terrain
// *behind* the guide skipped night lighting and showed its raw daylight imagery.
// Here they composite over the finished HDR image instead, tested by hand
// against a packed copy of the scene depth (the composer's depth texture may be
// attached to the buffer we draw into, so it cannot be sampled directly).

import { DepthCopyPass, Pass } from 'postprocessing'
import {
  BasicDepthPacking, RGBADepthPacking, Scene, Uniform, Vector2,
  type Camera, type DepthPackingStrategies, type Material, type Texture, type TextureDataType,
  type WebGLRenderer, type WebGLRenderTarget,
} from 'three'

const DEPTH_TEST = /* glsl */ `
{
  vec2 overlayUv = gl_FragCoord.xy / overlaySize;
  float sceneDepth = unpackRGBAToDepth(texture2D(overlayDepth, overlayUv));
  #ifdef USE_LOGARITHMIC_DEPTH_BUFFER
  float overlayFragDepth = log2(vFragDepth) * logDepthBufFC * 0.5;
  #else
  float overlayFragDepth = gl_FragCoord.z;
  #endif
  // Hidden by terrain, buildings or the aircraft in front of it.
  if (sceneDepth < 1.0 && overlayFragDepth > sceneDepth + 2e-7) discard;
  // Seen through a cloud: fade by the cloud's own coverage of this pixel.
  overlayCloudFade = hasOverlayClouds ? 1.0 - clamp(texture2D(overlayClouds, overlayUv).a, 0.0, 1.0) : 1.0;
}`

export class OverlayPass extends Pass {
  /** Objects drawn by this pass; keep them out of the main scene. */
  readonly overlay = new Scene()
  private readonly depthCopy = new DepthCopyPass({ depthPacking: RGBADepthPacking })
  private readonly uniforms = {
    overlayDepth: new Uniform<Texture | null>(null),
    overlaySize: new Uniform(new Vector2(1, 1)),
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
    this.uniforms.overlayDepth.value = this.depthCopy.texture
  }

  /** Converts a material to draw in this pass: manual depth test, no depth writes. */
  prepare(material: Material) {
    material.depthTest = false
    material.depthWrite = false
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms)
      const head = `${shader.fragmentShader.includes('#include <packing>') ? '' : '#include <packing>\n'}` +
        'uniform highp sampler2D overlayDepth;\nuniform vec2 overlaySize;\nuniform sampler2D overlayClouds;\nuniform bool hasOverlayClouds;\n'
      shader.fragmentShader = head + shader.fragmentShader
        .replace('void main() {', 'void main() {\n  float overlayCloudFade = 1.0;')
        .replace('#include <logdepthbuf_fragment>', `#include <logdepthbuf_fragment>\n${DEPTH_TEST}`)
        .replace('#include <opaque_fragment>', '#include <opaque_fragment>\n  gl_FragColor.a *= overlayCloudFade;')
    }
    material.customProgramCacheKey = () => 'geoflight-overlay'
    material.needsUpdate = true
  }

  override setDepthTexture(depthTexture: Texture, depthPacking: DepthPackingStrategies = BasicDepthPacking) {
    this.depthCopy.setDepthTexture(depthTexture, depthPacking)
  }

  override initialize(renderer: WebGLRenderer, alpha: boolean, frameBufferType: TextureDataType) {
    this.depthCopy.initialize(renderer, alpha, frameBufferType)
  }

  override setSize(width: number, height: number) {
    this.depthCopy.setSize(width, height)
  }

  override render(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget | null) {
    let visible = false
    for (const child of this.overlay.children) visible ||= child.visible
    if (!visible || !inputBuffer) return
    const clouds = this.getCloudOverlay?.() ?? null
    this.uniforms.overlayClouds.value = clouds
    this.uniforms.hasOverlayClouds.value = clouds !== null
    this.depthCopy.render(renderer, null, null)
    this.uniforms.overlaySize.value.set(inputBuffer.width, inputBuffer.height)
    const autoClear = renderer.autoClear
    const shadows = renderer.shadowMap.autoUpdate
    renderer.autoClear = false
    renderer.shadowMap.autoUpdate = false
    renderer.setRenderTarget(this.renderToScreen ? null : inputBuffer)
    renderer.render(this.overlay, this.view)
    renderer.autoClear = autoClear
    renderer.shadowMap.autoUpdate = shadows
  }

  override dispose() {
    this.depthCopy.dispose()
    super.dispose()
  }
}
