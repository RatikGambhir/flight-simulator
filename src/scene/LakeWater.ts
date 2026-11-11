import { Group, Mesh } from 'three'
import { frame } from '../world/frame'
import { buildLakeGeometry, distanceToLake, type LakeDefinition } from './lakeGeometry'
import { WaterMaterial } from './WaterMaterial'

/** Provider-independent water for inland lakes, at their own MSL elevations. */
export class LakeWater {
  readonly root = new Group()
  private readonly material = new WaterMaterial()
  private readonly meshes = new Map<LakeDefinition, Mesh>()
  private definitions: LakeDefinition[] = []
  private disposed = false
  private lastOrigin = -1
  private readonly abort = new AbortController()

  constructor(private lightingLayer: number) {
    this.root.name = 'Inland lake water'
    this.root.matrixAutoUpdate = false
    fetch(`${import.meta.env.BASE_URL}water/great-lakes.json`, { signal: this.abort.signal })
      .then(response => {
        if (!response.ok) throw new Error(`Lake shorelines: ${response.status}`)
        return response.json() as Promise<LakeDefinition[]>
      })
      .then(definitions => { if (!this.disposed) this.definitions = definitions })
      .catch(error => { if (!this.disposed) console.warn('Lake surfaces unavailable', error) })
  }

  update(lat: number, lon: number, time: number) {
    this.material.update(time)
    for (const lake of this.definitions) {
      const distance = distanceToLake(lake, lat, lon)
      let mesh = this.meshes.get(lake)
      if (distance < 150_000 && !mesh) {
        const { geometry, origin } = buildLakeGeometry(lake)
        mesh = new Mesh(geometry, this.material)
        mesh.name = lake.name
        mesh.position.copy(origin)
        mesh.layers.enable(this.lightingLayer)
        mesh.receiveShadow = true
        this.root.add(mesh)
        this.meshes.set(lake, mesh)
      } else if (distance > 200_000 && mesh) {
        this.root.remove(mesh)
        mesh.geometry.dispose()
        this.meshes.delete(lake)
      }
    }
    if (this.lastOrigin !== frame.version) {
      this.lastOrigin = frame.version
      this.root.matrix.copy(frame.worldFromEcef)
      this.root.updateMatrixWorld(true)
    }
  }

  dispose() {
    this.disposed = true
    this.abort.abort()
    for (const mesh of this.meshes.values()) mesh.geometry.dispose()
    this.meshes.clear()
    this.root.clear()
    this.material.dispose()
  }
}
