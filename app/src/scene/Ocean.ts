// Ocean surface for the open-data world. Raster DEM terrain includes
// bathymetry, so a water shell at mean sea level (the geoid) floods exactly
// the areas below sea level. The mesh is a curved, camera-centred disc with
// exponentially spaced rings (fine detail nearby, 550 km reach) and an
// animated two-layer normal map in world space for waves and sun glint.

import {
  BufferGeometry,
  Float32BufferAttribute,
  Matrix4,
  Mesh,
  Vector2,
  Vector3,
} from 'three'
import { ecefToGeodetic, frame, geodeticToEcef, WGS84_A, WGS84_E2 } from '../world/frame'
import { WaterMaterial } from './WaterMaterial'

function makeDisc(maxRadius: number, rings = 88, segments = 96) {
  const pos: number[] = []
  const idx: number[] = []
  pos.push(0, 0, 0)
  const r0 = 2
  for (let i = 1; i <= rings; i++) {
    const r = r0 * Math.pow(maxRadius / r0, (i - 1) / (rings - 1))
    // Stable form of sqrt(R² - r²) - R. The vertex shader adjusts the
    // sphere to the local ellipsoid without rebuilding the mesh.
    const drop = -(r * r) / (WGS84_A + Math.sqrt(WGS84_A ** 2 - r ** 2))
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
    normals[i] = pos[i] / WGS84_A
    normals[i + 1] = 1 + pos[i + 1] / WGS84_A
    normals[i + 2] = pos[i + 2] / WGS84_A
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
const _basis = new Matrix4()

export class Ocean {
  readonly mesh: Mesh
  private readonly curvature = new Vector2(1, 1)

  constructor(lightingLayer: number) {
    const mat = new WaterMaterial(this.curvature)
    this.mesh = new Mesh(makeDisc(550000), mat)
    this.mesh.frustumCulled = false
    this.mesh.receiveShadow = true
    this.mesh.renderOrder = -1
    this.mesh.layers.enable(lightingLayer)
  }

  /** Centres the disc under the camera at mean sea level. */
  update(cameraWorld: Vector3, geoid: number, time: number) {
    (this.mesh.material as WaterMaterial).update(time)
    frame.worldToEcef(cameraWorld, _p)
    const { lat, lon } = ecefToGeodetic(_p.x, _p.y, _p.z)
    // Keep the ocean below zero-elevation DEM cells so the two surfaces
    // do not compete for depth or incorrectly mask the terrain lighting.
    geodeticToEcef(lat, lon, geoid - 0.75, _p)
    frame.ecefToWorld(_p.x, _p.y, _p.z, this.mesh.position)
    frame.enuInWorld(lat, lon, _e, _n, _u)
    this.mesh.quaternion.setFromRotationMatrix(_basis.makeBasis(_e, _u, _n.negate()))
    // Ellipsoid curvature differs east-west and north-south. Fit the water
    // shell to the local radii so the distant ocean and atmosphere meet.
    const sinLat = Math.sin(lat * Math.PI / 180)
    const w = Math.sqrt(1 - WGS84_E2 * sinLat * sinLat)
    this.curvature.set(w, w ** 3 / (1 - WGS84_E2))
  }

  dispose() {
    this.mesh.geometry.dispose()
    const m = this.mesh.material as WaterMaterial
    m.dispose()
  }
}
