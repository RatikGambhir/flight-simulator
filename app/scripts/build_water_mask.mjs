// Pack Natural Earth 1:10m ocean and lake polygons for the scenery water mask.
import { readFileSync, writeFileSync } from 'node:fs'

const scale = 10_000
const values = [0x31544157] // WAT1
for (const path of process.argv.slice(2, 4)) {
  const { features } = JSON.parse(readFileSync(path, 'utf8'))
  const polygons = features.flatMap(({ geometry }) => (
    geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
  ))
  values.push(polygons.length)
  for (const polygon of polygons) {
    values.push(polygon.length)
    for (const ring of polygon) {
      let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
      const points = []
      for (const [lon, lat] of ring) {
        const x = Math.round(lon * scale), y = Math.round(lat * scale)
        if (x === points.at(-2) && y === points.at(-1)) continue
        points.push(x, y)
        west = Math.min(west, x)
        east = Math.max(east, x)
        south = Math.min(south, y)
        north = Math.max(north, y)
      }
      values.push(west, south, east, north, points.length / 2)
      for (const point of points) values.push(point)
    }
  }
}
const bytes = Buffer.alloc(values.length * 4)
values.forEach((value, i) => bytes.writeInt32LE(value, i * 4))
writeFileSync(new URL('../public/water/shorelines.bin', import.meta.url), bytes)
