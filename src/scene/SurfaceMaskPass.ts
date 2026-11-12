import { Pass, RenderPass, Selection } from 'postprocessing'
import {
  Color, MeshBasicMaterial, RedFormat, Uniform, WebGLRenderTarget,
  type Camera, type Scene, type Texture, type WebGLRenderer,
} from 'three'

/** Marks already-lit aircraft and water using the same depth as the visible scene. */
export class SurfaceMaskPass extends Pass {
  private readonly target = new WebGLRenderTarget(1, 1, { format: RedFormat, depthBuffer: false })
  private readonly depth = new Uniform<Texture | null>(null)
  private readonly material = new MeshBasicMaterial({ color: 0, depthTest: false, depthWrite: false, toneMapped: false })
  private readonly draw: RenderPass

  constructor(scene: Scene, camera: Camera, layer: number) {
    super('SurfaceMaskPass')
    this.needsDepthTexture = true
    this.needsSwap = false
    this.target.texture.name = 'Already-lit surfaces'
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.sceneDepth = this.depth
      shader.fragmentShader = `uniform highp sampler2D sceneDepth;\n${shader.fragmentShader}`.replace(
        '#include <logdepthbuf_fragment>',
        /* glsl */ `
          float surfaceDepth = gl_FragCoord.z;
          #ifdef USE_LOGARITHMIC_DEPTH_BUFFER
          if (vIsPerspective != 0.0) surfaceDepth = log2(vFragDepth) * logDepthBufFC * 0.5;
          #endif
          float visibleDepth = texelFetch(sceneDepth, ivec2(gl_FragCoord.xy), 0).r;
          if (visibleDepth >= 1.0 || abs(surfaceDepth - visibleDepth) > 2e-7) discard;
        `,
      )
    }

    // The composer already provides a detached depth texture. A color-only target
    // lets the selection test against it directly, with no extra depth copies.
    this.draw = new RenderPass(scene, camera, this.material)
    this.draw.selection = new Selection()
    this.draw.selection.layer = layer
    this.draw.ignoreBackground = true
    this.draw.skipShadowMapUpdate = true
    this.draw.clearPass.setClearFlags(true, false, false)
    this.draw.clearPass.overrideClearColor = new Color(0xffffff)
    this.draw.clearPass.overrideClearAlpha = 1
  }

  get texture() { return this.target.texture }
  // Pass is typed as returning Texture, but the composer also uses null when detached.
  override getDepthTexture() { return this.depth.value! }

  override setDepthTexture(depth: Texture | null) {
    this.depth.value = depth
  }

  override setSize(width: number, height: number) {
    this.target.setSize(width, height)
  }

  override render(renderer: WebGLRenderer) {
    if (!this.depth.value) return
    const autoClear = renderer.autoClear
    renderer.autoClear = false
    try {
      this.draw.render(renderer, this.target, null)
    } finally {
      renderer.autoClear = autoClear
    }
  }
}
