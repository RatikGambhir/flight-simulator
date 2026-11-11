// Ocean surface for the open-data world. Raster DEM terrain includes
// bathymetry, so a water shell at mean sea level (the geoid) floods exactly
// the areas below sea level. The mesh is a curved, camera-centred disc with
// exponentially spaced rings (fine detail nearby, 250 km reach) and an
// animated two-layer normal map in world space for waves and sun glint.

import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  Quaternion,
  Vector3,
} from 'three'
import { frame, geodeticToEcef } from '../world/frame'
import { WaterMaterial } from './WaterMaterial'

const EARTH_R = 6371000

function makeDisc(maxRadius: number, rings = 72, segments = 96) {
  const pos: number[] = []
  const idx: number[] = []
  pos.push(0, 0, 0)
  const r0 = 2
  for (let i = 1; i <= rings; i++) {
    const r = r0 * Math.pow(maxRadius / r0, (i - 1) / (rings - 1))
    const drop = (r * r) / (2 * EARTH_R)
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * Math.PI * 2
      pos.push(Math.cos(a) * r, -drop, Math.sin(a) * r)
    }
  }
  for (let j = 0; j < segments; j++) idx.push(0, 1 + ((j + 1) % segments), 1 + j)
  for (let i = 0; i < rings - 1; i++) {
    const a0 = 1 + i * segments
    const b0 = a0 + segments
    for (let j = 0; j < segments; j++) {
      const a = a0 + j
      const a1 = a0 + ((j + 1) % segments)
      const b = b0 + j
      const b1 = b0 + ((j + 1) % segments)
      idx.push(a, a1, b, a1, b1, b)
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  const normals = new Float32Array(pos.length)
  for (let i = 0; i < normals.length; i += 3) {
    const nx = pos[i] / EARTH_R
    const nz = pos[i + 2] / EARTH_R
    const length = Math.hypot(nx, 1, nz)
    normals[i] = nx / length
    normals[i + 1] = 1 / length
    normals[i + 2] = nz / length
  }
  g.setAttribute('normal', new Float32BufferAttribute(normals, 3))
  g.setAttribute('uv', new Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2))
  g.setIndex(idx)
  return g
}

const _p = new Vector3()
const _e = new Vector3()
const _n = new Vector3()
const _u = new Vector3()

export class Ocean {
  readonly mesh: Mesh

  constructor(lightingLayer: number) {
    const mat = new WaterMaterial()
    this.mesh = new Mesh(makeDisc(250000), mat)
    this.mesh.frustumCulled = false
    this.mesh.receiveShadow = true
    this.mesh.renderOrder = -1
    this.mesh.layers.enable(lightingLayer)
  }

  /** Centres the disc under the camera at mean sea level. */
  update(cameraWorld: Vector3, geoid: number, time: number) {
    (this.mesh.material as WaterMaterial).update(time)
    frame.worldToEcef(cameraWorld, _p)
    const r = Math.hypot(_p.x, _p.y)
    const lat = (Math.atan2(_p.z, r * (1 - 0.00669438)) * 180) / Math.PI
    const lon = (Math.atan2(_p.y, _p.x) * 180) / Math.PI
    geodeticToEcef(lat, lon, geoid, _p)
    frame.ecefToWorld(_p.x, _p.y, _p.z, this.mesh.position)
    frame.enuInWorld(lat, lon, _e, _n, _u)
    this.mesh.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), _u))
  }

  dispose() {
    this.mesh.geometry.dispose()
    const m = this.mesh.material as WaterMaterial
    m.dispose()
  }
}
