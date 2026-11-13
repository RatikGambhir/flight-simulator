import { CanvasTexture, LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping, Vector3 } from 'three'

/** Tileable procedural wave normal map (sum of directional sines). */
export function makeWaveNormals(size = 512) {
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

