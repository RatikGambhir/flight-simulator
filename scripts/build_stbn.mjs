// Generates public/clouds/stbn.bin: a 128x128x64 R8 spatio-temporal noise
// volume used by the volumetric clouds for ray-march jitter. Takram's
// original blue-noise file lives in Git LFS; this substitute uses
// interleaved gradient noise with a golden-ratio temporal offset per slice,
// which gives similarly low-discrepancy jitter once temporally accumulated.
import { writeFileSync, mkdirSync } from 'node:fs'
const W = 128, H = 128, D = 64
const buf = new Uint8Array(W * H * D)
const fract = (x) => x - Math.floor(x)
for (let z = 0; z < D; z++) {
  const ox = (z * 5.588238) % W
  const oy = (z * 5.588238 * 1.618) % H
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ign = fract(52.9829189 * fract(0.06711056 * (x + ox) + 0.00583715 * (y + oy)))
      const v = fract(ign + z * 0.61803398875)
      buf[z * W * H + y * W + x] = Math.min(255, Math.floor(v * 256))
    }
  }
}
mkdirSync(new URL('../public/clouds/', import.meta.url), { recursive: true })
writeFileSync(new URL('../public/clouds/stbn.bin', import.meta.url), buf)
console.log('stbn.bin', buf.length)
