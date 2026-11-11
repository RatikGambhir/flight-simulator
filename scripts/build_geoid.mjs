// Samples the EGM96 geoid (NGA, public domain; via the MIT-licensed
// egm96-universal package) on a 1-degree grid and writes data/geoid_1deg.bin:
// 181 rows (lat 90 -> -90) x 361 cols (lon -180 -> 180), little-endian i16,
// geoid undulation in decimeters.
// Usage: node scripts/build_geoid.mjs <path-to-egm96-universal-esm.js>
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const { meanSeaLevel } = await import(pathToFileURL(process.argv[2]).href)
const buf = Buffer.alloc(181 * 361 * 2)
let i = 0
for (let r = 0; r <= 180; r++) {
  for (let c = 0; c <= 360; c++) {
    const v = Math.round(meanSeaLevel(90 - r, -180 + c) * 10)
    buf.writeInt16LE(v, i)
    i += 2
  }
}
writeFileSync(new URL('../data/geoid_1deg.bin', import.meta.url), buf)
console.log('ok', meanSeaLevel(41.97, -87.9), meanSeaLevel(27.98, 86.92))
