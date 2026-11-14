// Owns the streamed 3D Tiles layers: per-frame updates under the floating
// origin, ground-height probing and collision rays.

import { BufferGeometry, Mesh, Raycaster, Sphere, Vector3, type Intersection, type Object3D, type PerspectiveCamera, type Scene, type WebGLRenderer } from 'three'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'
import { sim } from '../sim/simClient'
import type { Settings } from '../state/store'
import { createLayers, type StaticAttribution, type TileLayer } from './providers'
import { ecefToGeodetic, frame, geodeticToEcef } from './frame'
import { FlightPrefetch } from './flightPrefetch'
import { RunwayScenery } from './RunwayScenery'

// BVH-accelerated raycasts; trees are built lazily only for tiles under the aircraft.
BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
Mesh.prototype.raycast = acceleratedRaycast

export interface Attribution {
  text: string
  image?: string
}

const _origin = new Vector3()
const _target = new Vector3()
const _dir = new Vector3()
const _sphere = new Sphere()
const _ecef = new Vector3()

export class WorldSystem {
  readonly layers: TileLayer[]
  private readonly staticAttributions: StaticAttribution[]
  private readonly raycaster = new Raycaster()
  private readonly hits: Intersection[] = []
  private readonly candidates: Mesh[] = []
  private readonly prefetch = new FlightPrefetch()
  private readonly runways = new RunwayScenery((query) => sim.query(query))
  private prefetchActive = false
  private readonly prefetchResolution: number
  failed = false
  lastError: string | null = null
  /** World-space surface normal of the most recent ray hit. */
  lastHitNormal: Vector3 | null = null

  constructor(
    settings: Settings,
    private renderer: WebGLRenderer,
    private camera: PerspectiveCamera,
    private scene: Scene,
  ) {
    this.prefetchResolution = { low: 64, medium: 96, high: 128, ultra: 192 }[settings.quality]
    const { layers, attributions } = createLayers(settings, renderer)
    this.layers = layers
    this.staticAttributions = attributions
    ;(this.raycaster as Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true
    scene.add(this.runways.group)
    for (const l of layers) {
      // The streaming view can activate tiles outside the visible camera.
      // Let Three cull those meshes before submitting them to the GPU.
      l.tiles.autoDisableRendererCulling = false
      l.tiles.setCamera(camera)
      l.tiles.setResolutionFromRenderer(camera, renderer)
      l.tiles.addEventListener('load-model', ({ scene }) => this.runways.prepareScenery(scene))
      l.tiles.addEventListener('load-error', (e: { error: Error; url: string | URL }) => {
        const msg = String(e.error?.message ?? e.error)
        // Root tileset failures (bad key, API not enabled) are fatal for the layer.
        if (/root|tileset|401|403|API key|forbidden|unauthor/i.test(msg) || String(e.url).includes('root.json')) {
          this.failed = true
          this.lastError = msg
        }
      })
      scene.add(l.tiles.group)
    }
    this.syncTransforms()
  }

  /**
   * Geoid undulation near the origin (m). Raster DEM terrain stores heights
   * above mean sea level, while the mesh plugin places them above the
   * ellipsoid; lifting those layers by N makes them true ellipsoid heights.
   */
  geoidOffset = 0
  private syncedVersion = -1
  private syncedGeoid = NaN

  /**
   * Places the tile groups in the current floating-origin frame. Forcing a world-matrix
   * update walks every loaded tile mesh, so it runs only when the origin or geoid moved;
   * the renderer keeps newly loaded tiles current on its own.
   */
  syncTransforms() {
    this.runways.sync()
    if (frame.version === this.syncedVersion && this.geoidOffset === this.syncedGeoid) return
    this.syncedVersion = frame.version
    this.syncedGeoid = this.geoidOffset
    for (const l of this.layers) {
      l.tiles.group.matrix.copy(frame.worldFromEcef)
      // World Y is "up" at the origin, so this shifts the layer along the local vertical.
      if (l.mslHeights) l.tiles.group.matrix.elements[13] += this.geoidOffset
      l.tiles.group.updateMatrixWorld(true)
    }
  }

  /**
   * Relaxes the detail target while the ground is sweeping past quickly (low and
   * fast), where full-resolution tiles would fly out of view before they finish
   * downloading and the queue never catches up. 1 = full detail.
   */
  detailScale = 1
  private readonly baseErrorTargets = new Map<TileLayer, number>()

  setFlightPath(position: Vector3, velocity: Vector3, up: Vector3, agl: number, enabled: boolean) {
    const active = this.prefetch.update(position, velocity, up, agl, enabled)
    if (active === this.prefetchActive) return
    this.prefetchActive = active
    for (const { tiles } of this.layers) {
      if (active) {
        tiles.setCamera(this.prefetch.camera)
        // Coarse data only: the visible camera still requests full detail.
        // Both views share the existing bounded queues and memory budget.
        tiles.setResolution(this.prefetch.camera, this.prefetchResolution, this.prefetchResolution)
      } else {
        tiles.deleteCamera(this.prefetch.camera)
      }
    }
  }

  update() {
    this.syncTransforms()
    for (const l of this.layers) {
      let base = this.baseErrorTargets.get(l)
      if (base === undefined) {
        base = l.tiles.errorTarget
        this.baseErrorTargets.set(l, base)
      }
      l.tiles.errorTarget = base * this.detailScale
      l.tiles.setResolutionFromRenderer(this.camera, this.renderer)
      l.tiles.update()
    }
  }

  updateRunways(lat: number, lon: number, agl: number, airport: string | null) {
    this.runways.update(lat, lon, agl, airport)
  }

  /** 0..1 progress of currently requested tiles. */
  get loadProgress() {
    let p = 1
    for (const l of this.layers) p = Math.min(p, l.tiles.loadProgress)
    return p
  }

  get rootLoaded() {
    return this.layers.every((l) => l.tiles.root !== null)
  }

  private castRay(origin: Vector3, dir: Vector3, far: number): Intersection | null {
    this.raycaster.set(origin, dir)
    this.raycaster.near = 0
    this.raycaster.far = far
    const ray = this.raycaster.ray
    this.hits.length = 0
    for (const l of this.layers) {
      if (!l.ground) continue
      if (l.bvh) {
        // Build BVHs lazily, only for photogrammetry tiles the ray can touch.
        const cands = this.candidates
        cands.length = 0
        l.tiles.group.traverseVisible((o: Object3D) => {
          const m = o as Mesh
          if (!m.isMesh || !m.geometry || m.geometry.boundsTree) return
          const g = m.geometry
          if (!g.boundingSphere) g.computeBoundingSphere()
          if (!g.boundingSphere) return
          _sphere.copy(g.boundingSphere).applyMatrix4(m.matrixWorld)
          if (ray.intersectsSphere(_sphere) && g.attributes.position && g.attributes.position.count > 500) cands.push(m)
        })
        // A BVH over a dense photogrammetry tile takes several milliseconds. Build at
        // most one per ray (the probes run 10-30 times a second); unbuilt meshes
        // still raycast correctly, just without acceleration.
        if (cands.length > 0) {
          let largest = cands[0]
          for (const m of cands) if (m.geometry.attributes.position.count > largest.geometry.attributes.position.count) largest = m
          try {
            largest.geometry.computeBoundsTree()
          } catch {
            // brute-force raycast fallback
          }
        }
      }
      // TilesGroup.raycast defers to TilesRenderer.raycast, which also handles
      // plugin-generated (GPU-displaced) terrain.
      ;(this.raycaster as Raycaster & { firstHitOnly: boolean }).firstHitOnly = true
      const end = this.hits.length
      l.tiles.group.raycast(this.raycaster, this.hits)
      if (this.hits.length > end && this.runways.clears(this.hits[end].point)) {
        // A removed scan fragment can be the first hit in this layer.
        // Retry only in that case to find solid terrain or a tall obstruction.
        this.hits.length = end
        ;(this.raycaster as Raycaster & { firstHitOnly: boolean }).firstHitOnly = false
        l.tiles.group.raycast(this.raycaster, this.hits)
        for (let i = this.hits.length - 1; i >= end; --i) {
          if (this.runways.clears(this.hits[i].point)) this.hits.splice(i, 1)
        }
      }
    }
    this.raycaster.intersectObjects(this.runways.group.children, false, this.hits)
    if (this.hits.length === 0) return null
    let best = this.hits[0]
    for (const h of this.hits) if (h.distance < best.distance) best = h
    if (best.face) {
      this.lastHitNormal = (this.lastHitNormal ?? new Vector3()).copy(best.face.normal).transformDirection(best.object.matrixWorld)
    } else {
      this.lastHitNormal = null
    }
    return best
  }

  /**
   * Height of the first surface (ellipsoid meters) below a geodetic point,
   * casting downward from `fromHeight`, plus the geometric error of the tile
   * that was hit (coarse tiles can sit far below the true surface).
   */
  probeGround(lat: number, lon: number, fromHeight: number, maxDepth = 12000): { height: number; error: number } | null {
    geodeticToEcef(lat, lon, fromHeight, _ecef)
    frame.ecefToWorld(_ecef.x, _ecef.y, _ecef.z, _origin)
    geodeticToEcef(lat, lon, fromHeight - 1000, _ecef)
    frame.ecefToWorld(_ecef.x, _ecef.y, _ecef.z, _target)
    _dir.subVectors(_target, _origin).normalize()
    const hit = this.castRay(_origin, _dir, maxDepth)
    if (!hit) return null
    frame.worldToEcef(hit.point, _ecef)
    const tile = (hit.object?.userData as { tile?: { geometricError?: number } } | undefined)?.tile
    return { height: ecefToGeodetic(_ecef.x, _ecef.y, _ecef.z).height, error: tile?.geometricError ?? 0 }
  }

  /** Distance to scenery along a world-space segment, or null if clear. */
  probeSegment(from: Vector3, dir: Vector3, length: number): number | null {
    const hit = this.castRay(from, dir, length)
    return hit ? hit.distance : null
  }

  attributions(): Attribution[] {
    const out: Attribution[] = []
    const seen = new Set<string>()
    for (const l of this.layers) {
      for (const a of l.tiles.getAttributions()) {
        const v = String(a.value ?? '')
        if (!v || seen.has(v)) continue
        seen.add(v)
        if (a.type === 'image') out.push({ text: '', image: v })
        else if (a.type === 'string') out.push({ text: v })
        else if (a.type === 'html') out.push({ text: v.replace(/<[^>]+>/g, '') })
      }
    }
    for (const a of this.staticAttributions) out.push({ text: a.text })
    return out
  }

  dispose() {
    this.scene.remove(this.runways.group)
    this.runways.dispose()
    for (const l of this.layers) {
      this.scene.remove(l.tiles.group)
      l.tiles.dispose()
    }
  }
}
