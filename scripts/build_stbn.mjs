// Restore the pinned upstream spatiotemporal blue-noise volume. The old IGN
// substitute produced coherent diagonal/checker patterns in moving clouds.
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'

const revision = '9627216cc50057994c98a2118f3c4a23765d43b9'
const url = `https://media.githubusercontent.com/media/takram-design-engineering/three-geospatial/${revision}/packages/core/assets/stbn.bin`
const sha256 = '51f52f21e5578384585050390821a0a486dcb81e11a716fa7b92fbb6515ba852'
const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
if (!response.ok) throw new Error(`STBN download failed: HTTP ${response.status}`)
const bytes = Buffer.from(await response.arrayBuffer())
if (bytes.length !== 128 * 128 * 64 || createHash('sha256').update(bytes).digest('hex') !== sha256) {
  throw new Error('STBN download has the wrong size or checksum; keeping the existing texture')
}
await mkdir(new URL('../public/clouds/', import.meta.url), { recursive: true })
await writeFile(new URL('../public/clouds/stbn.bin', import.meta.url), bytes)
console.log(`Restored upstream STBN: ${bytes.length} bytes, SHA-256 ${sha256}`)
