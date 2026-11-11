// Ocean surface for the open-data world. Raster DEM terrain includes
// bathymetry, so a water shell at mean sea level (the geoid) floods exactly
// the areas below sea level. The mesh is a curved, camera-centred disc with
// exponentially spaced rings (fine detail nearby, 250 km reach) and an
// animated two-layer normal map in world space for waves and sun glint.

import {
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  LinearMipmapLinearFilter,
  Mesh,
  MeshPhysicalMaterial,
  NoColorSpace,
  Quaternion,
  RepeatWrapping,
  Vector3,
  type IUniform,
} from 'three'
import { frame, geodeticToEcef } from '../world/frame'

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
  for (let i = 0; i < normals.length; i += 3) normals[i + 1] = 1
  g.setAttribute('normal', new Float32BufferAttribute(normals, 3))
  g.setAttribute('uv', new Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2))
  g.setIndex(idx)
  return g
}

/** Tileable procedural wave normal map (sum of directional sines). */
function makeWaveNormals(size = 512) {
  const h = new Float32Array(size * size)
  const waves: [number, number, number, number][] = []
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let i = 0; i < 28; i++) {
    const fx = Math.round((rnd() - 0.5) * 2 * (2 + i * 0.9))
    const fy = Math.round((rnd() - 0.5) * 2 * (2 + i * 0.9))
    if (fx === 0 && fy === 0) continue
    waves.push([fx, fy, 1 / Math.sqrt(fx * fx + fy * fy), rnd() * Math.PI * 2])
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0
      for (const [fx, fy, amp, ph] of waves) v += amp * Math.sin(((fx * x + fy * y) / size) * Math.PI * 2 + ph)
      h[y * size + x] = v
    }
  }
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const g = c.getContext('2d')!
  const img = g.createImageData(size, size)
  const k = 2.2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = h[y * size + ((x + 1) % size)] - h[y * size + ((x - 1 + size) % size)]
      const dy = h[((y + 1) % size) * size + x] - h[((y - 1 + size) % size) * size + x]
      const n = new Vector3(-dx * k, -dy * k, 1).normalize()
      const i = (y * size + x) * 4
      img.data[i] = (n.x * 0.5 + 0.5) * 255
      img.data[i + 1] = (n.y * 0.5 + 0.5) * 255
      img.data[i + 2] = (n.z * 0.5 + 0.5) * 255
      img.data[i + 3] = 255
    }
  }
  g.putImageData(img, 0, 0)
  const t = new CanvasTexture(c)
  t.wrapS = t.wrapT = RepeatWrapping
  t.colorSpace = NoColorSpace
  t.minFilter = LinearMipmapLinearFilter
  t.anisotropy = 8
  return t
}

const _p = new Vector3()
const _e = new Vector3()
const _n = new Vector3()
const _u = new Vector3()

export class Ocean {
  readonly mesh: Mesh
  private uniforms: { uTime: IUniform<number> } = { uTime: { value: 0 } }

  constructor(lightingLayer: number) {
    const normalMap = makeWaveNormals()
    const mat = new MeshPhysicalMaterial({
      color: new Color('#04202f'),
      roughness: 0.05,
      metalness: 0,
      normalMap,
      ior: 1.333,
      specularIntensity: 1,
      envMapIntensity: 0.85,
    })
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uniforms.uTime
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWaterWorld;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWaterWorld;\nuniform float uTime;')
        .replace(
          '#include <normal_fragment_maps>',
          /* glsl */ `
          // Two scrolling wave layers sampled in world space; detail fades with distance.
          vec2 wp = vWaterWorld.xz;
          float dist = length(vViewPosition);
          vec3 n1 = texture2D(normalMap, wp / 38.0 + vec2(uTime * 0.011, uTime * 0.007)).xyz * 2.0 - 1.0;
          vec3 n2 = texture2D(normalMap, wp / 210.0 - vec2(uTime * 0.004, -uTime * 0.006)).xyz * 2.0 - 1.0;
          vec3 n3 = texture2D(normalMap, wp / 1400.0 + vec2(uTime * 0.0012, 0.0)).xyz * 2.0 - 1.0;
          float fade = clamp(1.0 - dist / 9000.0, 0.0, 1.0);
          vec3 wn = normalize(vec3((n1.xy * 0.55 * fade + n2.xy * 0.45 + n3.xy * 0.35), 1.0));
          // Tangent space here is world XZ with Y up; convert to view space.
          vec3 worldN = normalize(vec3(wn.x, wn.z, wn.y));
          normal = normalize((viewMatrix * vec4(worldN, 0.0)).xyz);
          `,
        )
    }
    this.mesh = new Mesh(makeDisc(250000), mat)
    this.mesh.frustumCulled = false
    this.mesh.receiveShadow = true
    this.mesh.renderOrder = -1
    this.mesh.layers.enable(lightingLayer)
  }

  /** Centres the disc under the camera at mean sea level. */
  update(cameraWorld: Vector3, geoid: number, time: number) {
    this.uniforms.uTime.value = time
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
    const m = this.mesh.material as MeshPhysicalMaterial
    m.normalMap?.dispose()
    m.dispose()
  }
}
