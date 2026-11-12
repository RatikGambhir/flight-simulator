// Geographic data providers. Each returns one or more 3D Tiles layers that
// stream real-world terrain, imagery and buildings around the camera.
//
//  google  — Google Maps Platform Photorealistic 3D Tiles (Map Tiles API).
//            Best realism: photogrammetry of cities, terrain and landmarks.
//  cesium  — Cesium ion: either Google Photorealistic 3D Tiles via ion
//            (asset 2275207) or Cesium World Terrain + Bing Maps Aerial +
//            Cesium OSM Buildings.
//  open    — No key required: AWS Terrain Tiles (Terrarium DEM) draped with
//            Esri World Imagery or EOX Sentinel-2 cloudless. Real geography,
//            but no 3D buildings.

import { TilesRenderer } from '3d-tiles-renderer'
import {
  CesiumIonAuthPlugin,
  CesiumIonOverlay,
  GLTFExtensionsPlugin,
  GoogleCloudAuthPlugin,
  ImageOverlayPlugin,
  TerrariumMeshPlugin,
  TileCompressionPlugin,
  TilesFadePlugin,
  UnloadTilesPlugin,
  XYZTilesOverlay,
} from '3d-tiles-renderer/plugins'
import { LinearFilter, LinearMipmapLinearFilter, Matrix4, Sphere, type Mesh, type MeshBasicMaterial, type Object3D, type WebGLRenderer } from 'three'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import type { Quality, Settings } from '../state/store'

export interface TileLayer {
  tiles: TilesRenderer
  /** Whether ground probing should raycast this layer. */
  ground: boolean
  /** Build BVHs on demand for faster raycasts (regular mesh tiles only). */
  bvh: boolean
  /** Heights are relative to mean sea level rather than the ellipsoid. */
  mslHeights?: boolean
  cacheShare?: number
  errorScale?: number
  label: string
}

export interface StaticAttribution {
  text: string
  url?: string
}

const QUALITY: Record<Quality, { errorTarget: number; bytes: number; jobs: number }> = {
  low: { errorTarget: 28, bytes: 220e6, jobs: 12 },
  medium: { errorTarget: 16, bytes: 350e6, jobs: 18 },
  high: { errorTarget: 10, bytes: 550e6, jobs: 24 },
  ultra: { errorTarget: 6, bytes: 900e6, jobs: 30 },
}

let draco: DRACOLoader | null = null
function getDraco() {
  if (!draco) {
    draco = new DRACOLoader()
    draco.setDecoderPath(`${import.meta.env.BASE_URL}draco/`)
    draco.preload()
  }
  return draco
}

export function setTileQuality({ tiles, cacheShare = 1, errorScale = 1 }: TileLayer, q: Quality) {
  const cfg = QUALITY[q]
  tiles.errorTarget = Math.max(2, cfg.errorTarget * errorScale)
  tiles.lruCache.maxBytesSize = cfg.bytes * cacheShare
  tiles.lruCache.minBytesSize = tiles.lruCache.maxBytesSize * 0.6
  tiles.downloadQueue.maxJobsPerOrigin = cfg.jobs
}

function photogrammetryPlugins(tiles: TilesRenderer) {
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: getDraco() }))
  // Normals are needed for post-process sun/sky lighting; compression halves GPU memory.
  tiles.registerPlugin(new TileCompressionPlugin({ generateNormals: true, disableMipmaps: false }))
  tiles.registerPlugin(new TilesFadePlugin())
  tiles.registerPlugin(new UnloadTilesPlugin({ delay: 4000 }))
}

/**
 * Draped imagery arrives without mipmaps or anisotropic filtering, which makes
 * the ground shimmer and smear towards the horizon. Enable both as tiles load.
 */
function sharpenImagery(tiles: TilesRenderer, renderer: WebGLRenderer) {
  const anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy())
  tiles.addEventListener('load-model', (e) => {
    ;(e as unknown as { scene: Object3D }).scene.traverse((o) => {
      const material = (o as Mesh).material
      if (!material) return
      for (const m of Array.isArray(material) ? material : [material]) {
        const map = (m as MeshBasicMaterial).map
        if (!map || map.isRenderTargetTexture) continue
        // GLTF maps usually already have mipmaps, but still need anisotropy.
        // Compressed textures carry their own mip chain; do not regenerate it.
        if (!('isCompressedTexture' in map)) {
          map.generateMipmaps = true
          map.minFilter = LinearMipmapLinearFilter
        }
        map.magFilter = LinearFilter
        map.anisotropy = anisotropy
        map.needsUpdate = true
      }
    })
  })
}

export const IMAGERY = {
  esri: {
    label: 'Esri World Imagery',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    levels: 19,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  },
  eox: {
    label: 'Sentinel-2 cloudless (EOX)',
    url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/{z}/{y}/{x}.jpg',
    levels: 15,
    attribution: 'Sentinel-2 cloudless – https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2023)',
  },
} as const

export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

export function createLayers(settings: Settings, renderer: WebGLRenderer): { layers: TileLayer[]; attributions: StaticAttribution[] } {
  switch (settings.provider) {
    case 'google': {
      const tiles = new TilesRenderer()
      tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: settings.googleApiKey.trim(), autoRefreshToken: true }))
      photogrammetryPlugins(tiles)
      sharpenImagery(tiles, renderer)
      return { layers: [{ tiles, ground: true, bvh: true, label: 'Google Photorealistic 3D Tiles' }], attributions: [] }
    }
    case 'cesium': {
      const token = settings.cesiumToken.trim()
      if (settings.cesiumMode === 'photorealistic') {
        const tiles = new TilesRenderer()
        tiles.registerPlugin(new CesiumIonAuthPlugin({ apiToken: token, assetId: '2275207', autoRefreshToken: true }))
        photogrammetryPlugins(tiles)
        sharpenImagery(tiles, renderer)
        return { layers: [{ tiles, ground: true, bvh: true, label: 'Google Photorealistic 3D Tiles (via Cesium ion)' }], attributions: [] }
      }
      const terrain = new TilesRenderer()
      terrain.registerPlugin(new CesiumIonAuthPlugin({ apiToken: token, assetId: '1', autoRefreshToken: true }))
      terrain.registerPlugin(
        new ImageOverlayPlugin({ renderer, overlays: [new CesiumIonOverlay({ assetId: 2, apiToken: token, autoRefreshToken: true })] }),
      )
      terrain.registerPlugin(new UnloadTilesPlugin({ delay: 4000 }))
      sharpenImagery(terrain, renderer)
      const buildings = new TilesRenderer()
      buildings.registerPlugin(new CesiumIonAuthPlugin({ apiToken: token, assetId: '96188', autoRefreshToken: true }))
      photogrammetryPlugins(buildings)
      sharpenImagery(buildings, renderer)
      return {
        layers: [
          { tiles: terrain, ground: true, bvh: false, cacheShare: 0.6, label: 'Cesium World Terrain + Bing Maps Aerial' },
          { tiles: buildings, ground: true, bvh: true, cacheShare: 0.4, errorScale: 1.5, label: 'Cesium OSM Buildings' },
        ],
        attributions: [],
      }
    }
    case 'open':
    default: {
      const img = IMAGERY[settings.openImagery] ?? IMAGERY.esri
      const tiles = new TilesRenderer()
      const overlay = new XYZTilesOverlay({ url: img.url, levels: img.levels, tileDimension: 256 })
      tiles.registerPlugin(
        new TerrariumMeshPlugin({ url: TERRARIUM_URL, maxZoom: 15, overlay, applyOverlayTexture: true, unlit: true }),
      )
      tiles.registerPlugin(new UnloadTilesPlugin({ delay: 4000 }))
      sharpenImagery(tiles, renderer)
      // The DEM plugin displaces a sea-level mesh on the GPU. Use its measured,
      // skirt-inclusive tile bounds so the main view can cull prefetch-only terrain.
      tiles.addEventListener('load-model', ({ scene, tile }) => {
        const volume = (tile as { engineData?: { boundingVolume?: { getSphere(target: Sphere): void } } }).engineData?.boundingVolume
        const sphere = new Sphere()
        const localFromTiles = new Matrix4()
        const tilesFromWorld = new Matrix4()
        scene.updateWorldMatrix(true, true)
        if (scene.parent) tilesFromWorld.copy(tiles.group.matrixWorld).invert()
        volume?.getSphere(sphere)
        scene.traverse((object) => {
          const mesh = object as Mesh
          if (!mesh.isMesh) return
          if (!volume || !(sphere.radius > 0) || !Number.isFinite(sphere.radius)) {
            mesh.frustumCulled = false
            return
          }
          localFromTiles.multiplyMatrices(tilesFromWorld, mesh.matrixWorld).invert()
          mesh.geometry.boundingSphere = sphere.clone().applyMatrix4(localFromTiles)
        })
      })
      // A terrain tile's "parse" step is mostly waiting on its elevation and imagery
      // downloads, so the default of 4 concurrent parses throttles the network.
      tiles.parseQueue.maxJobs = 16
      return {
        layers: [{ tiles, ground: true, bvh: false, mslHeights: true, errorScale: 0.6, label: `AWS Terrain Tiles + ${img.label}` }],
        attributions: [
          { text: img.attribution },
          { text: 'Elevation: AWS Terrain Tiles (Mapzen) — SRTM, GMTED2010, ETOPO1, NED and other public sources' },
        ],
      }
    }
  }
}
