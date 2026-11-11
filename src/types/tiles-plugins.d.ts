// Type declarations for 3d-tiles-renderer plugins that ship without .d.ts entries.
import type { ImageOverlay } from '3d-tiles-renderer/plugins'

declare module '3d-tiles-renderer/plugins' {
  export class TerrainRGBMeshPlugin {
    constructor(options: {
      url: string
      tileDimension?: number
      maxZoom?: number
      heightScale?: number
      overlay?: ImageOverlay | null
      applyOverlayTexture?: boolean
      unlit?: boolean
      projection?: 'ellipsoid' | 'source' | string
      endCaps?: boolean
      useRecommendedSettings?: boolean
    })
    heightScale: number
  }
  export class TerrariumMeshPlugin extends TerrainRGBMeshPlugin {}
}
