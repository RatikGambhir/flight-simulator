import { Data3DTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, RGBAFormat } from 'three'

export const WEATHER_PERIOD = 216000
export const SPACING_PERIOD = 41000
export const SHAPE_PERIOD = 13100
export const DETAIL_PERIOD = 1450

const SIZE = 80
const mix = (a: number, b: number, t: number) => a + (b - a) * t
const fade = (t: number) => t * t * (3 - 2 * t)

function lattice(cells: number, seed: number) {
  const values = new Float32Array(cells ** 3)
  for (let i = 0; i < values.length; ++i) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    values[i] = seed / 2 ** 32
  }
  return (x: number, y: number, z: number) => {
    x *= cells
    y *= cells
    z *= cells
    const a = Math.floor(x)
    const b = Math.floor(y)
    const c = Math.floor(z)
    const u = fade(x - a)
    const v = fade(y - b)
    const w = fade(z - c)
    const row = (j: number, k: number) => {
      const start = ((k % cells) * cells + j % cells) * cells
      return mix(values[start + a % cells], values[start + (a + 1) % cells], u)
    }
    return mix(mix(row(b, c), row(b + 1, c), v), mix(row(b, c + 1), row(b + 1, c + 1), v), w)
  }
}

function billows(cells: number, seed: number) {
  const px = lattice(cells, seed)
  const py = lattice(cells, seed + 519)
  const pz = lattice(cells, seed + 4911)
  const radius = lattice(cells, seed + 716)
  const points = new Float32Array(cells ** 3 * 5)
  let i = 0
  for (let z = 0; z < cells; ++z) {
    for (let y = 0; y < cells; ++y) {
      for (let x = 0; x < cells; ++x) {
        points[i++] = 0.1 + 0.8 * px(x / cells, y / cells, z / cells)
        points[i++] = 0.1 + 0.8 * py(x / cells, y / cells, z / cells)
        points[i++] = 0.1 + 0.8 * pz(x / cells, y / cells, z / cells)
        const size = radius(x / cells, y / cells, z / cells)
        points[i++] = 1.38 - 0.65 * size
        points[i++] = 0.77 + 0.50 * size
      }
    }
  }
  return (x: number, y: number, z: number) => {
    x *= cells
    y *= cells
    z *= cells
    const bx = Math.floor(x)
    const by = Math.floor(y)
    const bz = Math.floor(z)
    let distanceSq = 3
    for (let k = bz - 1; k <= bz + 1; ++k) {
      const slice = ((k + cells) % cells) * cells
      for (let j = by - 1; j <= by + 1; ++j) {
        const row = (slice + (j + cells) % cells) * cells
        for (let l = bx - 1; l <= bx + 1; ++l) {
          const p = (row + (l + cells) % cells) * 5
          const dx = (l + points[p] - x) * points[p + 4]
          const dy = j + points[p + 1] - y
          const dz = (k + points[p + 2] - z) / points[p + 4]
          distanceSq = Math.min(distanceSq, (dx * dx + dy * dy + dz * dz) * points[p + 3])
        }
      }
    }
    return Math.max(0, 1 - Math.sqrt(distanceSq))
  }
}

// Pack periodic weather, shape, erosion and cloud-type fields into one volume.
// Each is sampled at its own physical scale, without reseeding during a flight.
export function createCloudField() {
  const regional = lattice(5, 127)
  const patches = lattice(13, 941)
  const lobes = billows(7, 703)
  const scallops = billows(17, 398)
  const ripples = lattice(29, 654)
  const detail = billows(5, 503)
  const grain = lattice(13, 103)
  const type = lattice(7, 811)
  const data = new Uint8Array(SIZE ** 3 * 4)
  let i = 0
  for (let k = 0; k < SIZE; ++k) {
    for (let j = 0; j < SIZE; ++j) {
      for (let l = 0; l < SIZE; ++l) {
        const x = (l + 0.5) / SIZE
        const y = (j + 0.5) / SIZE
        const z = (k + 0.5) / SIZE
        data[i++] = Math.round(255 * (0.63 * regional(x, y, z) + 0.37 * patches(x, y, z)))
        data[i++] = Math.round(255 * (0.55 * lobes(x, y, z) + 0.34 * scallops(x, y, z) + 0.11 * ripples(x, y, z)))
        data[i++] = Math.round(255 * (0.68 * detail(x, y, z) + 0.32 * grain(x, y, z)))
        data[i++] = Math.round(255 * type(x, y, z))
      }
    }
  }
  const texture = new Data3DTexture(data, SIZE, SIZE, SIZE)
  texture.name = 'GeoFlight cloud noise'
  texture.format = RGBAFormat
  texture.minFilter = LinearMipmapLinearFilter
  texture.magFilter = LinearFilter
  texture.generateMipmaps = true
  texture.wrapS = texture.wrapT = texture.wrapR = RepeatWrapping
  texture.needsUpdate = true
  return texture
}
