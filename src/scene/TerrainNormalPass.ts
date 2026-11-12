// Smooth view-space normals for GPU-displaced DEM terrain.
//
// Raster DEM tiles (TerrariumMeshPlugin, unlit) displace a smooth surface on the
// GPU and carry no usable normals, so the aerial-perspective lighting used to
// reconstruct them from depth derivatives: flat per triangle and stepped per 2x2
// pixel quad, which showed as faceted, serrated slopes. This pass draws only the
// terrain tile groups with each tile's own displacement map and a bump gradient
// from the same elevation texture (central differences across texels, scaled to
// the physical slope, as the library's lit terrain material does).
//
// Aircraft and water are already lit and excluded from post-process lighting by
// the surface mask, so the terrain behind them never needs to be hidden here.
import { Pass } from 'postprocessing'
import {
  Color, MeshNormalMaterial, UnsignedByteType, WebGLRenderTarget,
  type Camera, type Material, type Mesh, type Object3D, type Texture, type WebGLRenderer,
} from 'three'

/** The library's physical-slope bump gradient (TerrainLambertMaterial), shared by every tile material. */
const TERRAIN_BUMP = /* glsl */ `
#ifdef USE_BUMPMAP
uniform sampler2D bumpMap;
uniform float bumpScale;
const float DEGENERATE_DET_EPSILON = 1e-3;
vec2 dHdxy_fwd() {
  vec2 dSTdx = dFdx(vBumpMapUv);
  vec2 dSTdy = dFdy(vBumpMapUv);
  vec2 texelSize = 1.0 / vec2(textureSize(bumpMap, 0));
  vec2 dx = vec2(texelSize.x, 0.0);
  vec2 dy = vec2(0.0, texelSize.y);
  float gradU = (texture2D(bumpMap, vBumpMapUv + dx).x - texture2D(bumpMap, vBumpMapUv - dx).x) / (2.0 * texelSize.x);
  float gradV = (texture2D(bumpMap, vBumpMapUv + dy).x - texture2D(bumpMap, vBumpMapUv - dy).x) / (2.0 * texelSize.y);
  return bumpScale * vec2(gradU * dSTdx.x + gradV * dSTdx.y, gradU * dSTdy.x + gradV * dSTdy.y);
}
vec3 perturbNormalArb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection) {
  vec3 vSigmaX = dFdx(surf_pos.xyz);
  vec3 vSigmaY = dFdy(surf_pos.xyz);
  vec3 R1 = cross(vSigmaY, surf_norm);
  vec3 R2 = cross(surf_norm, vSigmaX);
  float fDet = dot(vSigmaX, R1) * faceDirection;
  // Edge-on geometry (tile skirts) would amplify the gradient into garbage.
  if (abs(fDet) < DEGENERATE_DET_EPSILON * length(vSigmaX) * length(vSigmaY)) return surf_norm;
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(fDet) * surf_norm - vGrad);
}
#endif
`

interface DisplacedMaterial extends Material {
  displacementMap?: Texture | null
  displacementScale?: number
  displacementBias?: number
}

const CLEAR = new Color(0, 0, 0)

export class TerrainNormalPass extends Pass {
  private readonly target = new WebGLRenderTarget(1, 1, { type: UnsignedByteType, depthBuffer: true })
  private readonly materials = new WeakMap<Material, MeshNormalMaterial>()
  private readonly swapped: Mesh[] = []
  private readonly originals: Material[] = []
  private readonly previousClear = new Color()
  /** Objects to draw (the terrain tile groups); set by the owner as layers change. */
  roots: Object3D[] = []

  private readonly view: Camera

  constructor(view: Camera) {
    super('TerrainNormalPass')
    this.view = view
    this.needsSwap = false
    this.target.texture.name = 'Terrain normals'
  }

  get texture() { return this.target.texture }

  override setSize(width: number, height: number) {
    this.target.setSize(width, height)
  }

  private normalMaterial(source: DisplacedMaterial) {
    let material = this.materials.get(source)
    if (!material) {
      material = new MeshNormalMaterial()
      material.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace('#include <bumpmap_pars_fragment>', TERRAIN_BUMP)
      }
      material.customProgramCacheKey = () => 'geoflight-terrain-normal'
      this.materials.set(source, material)
      source.addEventListener('dispose', () => {
        material!.dispose()
        this.materials.delete(source)
      })
    }
    const map = source.displacementMap ?? null
    if (material.displacementMap !== map || material.bumpMap !== map) {
      material.displacementMap = map
      material.bumpMap = map
      material.needsUpdate = true
    }
    material.displacementScale = source.displacementScale ?? 1
    material.displacementBias = source.displacementBias ?? 0
    material.bumpScale = source.displacementScale ?? 1
    return material
  }

  override render(renderer: WebGLRenderer) {
    const { swapped, originals } = this
    for (const root of this.roots) {
      root.traverseVisible((object) => {
        const mesh = object as Mesh
        if (!mesh.isMesh || Array.isArray(mesh.material)) return
        const material = mesh.material as DisplacedMaterial
        if (!material.displacementMap) return
        swapped.push(mesh)
        originals.push(material)
        mesh.material = this.normalMaterial(material)
      })
    }
    const autoClear = renderer.autoClear
    const shadows = renderer.shadowMap.autoUpdate
    const clearAlpha = renderer.getClearAlpha()
    renderer.getClearColor(this.previousClear)
    try {
      renderer.autoClear = false
      renderer.shadowMap.autoUpdate = false
      renderer.setRenderTarget(this.target)
      // Zero normals mark "no terrain" (sky); the aerial shader treats them as degenerate.
      renderer.setClearColor(CLEAR, 0)
      renderer.clear(true, true, false)
      for (const root of this.roots) renderer.render(root, this.view)
    } finally {
      for (let i = 0; i < swapped.length; i++) swapped[i].material = originals[i]
      swapped.length = originals.length = 0
      renderer.setClearColor(this.previousClear, clearAlpha)
      renderer.shadowMap.autoUpdate = shadows
      renderer.autoClear = autoClear
    }
  }

  override dispose() {
    this.target.dispose()
    super.dispose()
  }
}
