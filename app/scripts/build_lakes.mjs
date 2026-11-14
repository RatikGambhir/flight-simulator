// Natural Earth 1:10m lakes (public domain), with EGM96 offsets from our
// bundled NGA grid. Pass the downloaded ne_10m_lakes.geojson as the argument.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const source = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const geoid = readFileSync(new URL('../data/geoid_1deg.bin', import.meta.url))
// Representative MSL levels, not a live water-level feed. Michigan and Huron
// share a level. NOAA GLERL: https://apps.glerl.noaa.gov/coastwatch/webdata/statistic/physical.html
const levels = { 'Lake Michigan': 177, 'Lake Huron': 177, 'Lake Superior': 183.5, 'Lake Erie': 174, 'Lake Ontario': 75 }
const lakes = source.features.filter(f => f.properties.name in levels).map(f => {
  const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
  const points = polygons.flat(2)
  const bounds = [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
    Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))]
  const west = Math.floor(bounds[0]), north = Math.ceil(bounds[3])
  const columns = Math.ceil(bounds[2]) - west + 1, rows = north - Math.floor(bounds[1]) + 1
  const values = []
  for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
    values.push(geoid.readInt16LE(((90 - north + row) * 361 + west + 180 + col) * 2) / 10)
  }
  return { name: f.properties.name, levelM: levels[f.properties.name], bounds,
    polygons, geoid: { west, north, columns, rows, values } }
})
const dir = new URL('../public/water/', import.meta.url)
mkdirSync(dir, { recursive: true })
writeFileSync(new URL('great-lakes.json', dir), JSON.stringify(lakes))
console.log(`Wrote ${lakes.length} lake shorelines with local geoid grids.`)
