import { BufferGeometry, Float32BufferAttribute, ShapeUtils, Vector2, Vector3 } from 'three'

export interface LakeDefinition {
  name: string
  levelM: number
  bounds: [number, number, number, number]
  polygons: number[][][][]
  geoid: { west: number; north: number; columns: number; rows: number; values: number[] }
}

export function lakeGeoid(lake: LakeDefinition, lon: number, lat: number) {
  const g = lake.geoid
  const x = Math.max(0, Math.min(g.columns - 1.000001, lon - g.west))
  const y = Math.max(0, Math.min(g.rows - 1.000001, g.north - lat))
  const col = Math.floor(x), row = Math.floor(y), fx = x - col, fy = y - row
  const i = row * g.columns + col
  return (g.values[i] * (1 - fx) + g.values[i + 1] * fx) * (1 - fy) +
    (g.values[i + g.columns] * (1 - fx) + g.values[i + g.columns + 1] * fx) * fy
}

export function distanceToLake(lake: LakeDefinition, lat: number, lon: number) {
  const [west, south, east, north] = lake.bounds
  const dx = Math.max(west - lon, 0, lon - east) * Math.cos(lat * Math.PI / 180)
  const dy = Math.max(south - lat, 0, lat - north)
  return Math.hypot(dx, dy) * 111_320
}

function ecef(lon: number, lat: number, height: number, out = new Vector3()) {
  const phi = lat * Math.PI / 180, theta = lon * Math.PI / 180
  const sin = Math.sin(phi), cos = Math.cos(phi)
  const n = 6378137 / Math.sqrt(1 - 0.0066943799901413165 * sin * sin)
  return out.set((n + height) * cos * Math.cos(theta), (n + height) * cos * Math.sin(theta),
    (n * (1 - 0.0066943799901413165) + height) * sin)
}

/** Shoreline-clipped, geoid-corrected curved surface, including island holes. */
export function buildLakeGeometry(lake: LakeDefinition, maxEdgeM = 2000) {
  const [west, south, east, north] = lake.bounds
  const lon = (west + east) / 2, lat = (south + north) / 2
  const origin = ecef(lon, lat, lake.levelM + lakeGeoid(lake, lon, lat))
  const coords: Vector2[] = []
  const indices: number[] = []
  const midpoints = new Map<string, number>()
  const maxEdgeSq = maxEdgeM * maxEdgeM
  const edgeLengthSq = (a: number, b: number) => {
    const p = coords[a], q = coords[b]
    const dx = (p.x - q.x) * Math.cos((p.y + q.y) * Math.PI / 360) * 111_320
    const dy = (p.y - q.y) * 111_320
    return dx * dx + dy * dy
  }
  const midpoint = (a: number, b: number) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`
    let index = midpoints.get(key)
    if (index === undefined) {
      index = coords.length
      coords.push(coords[a].clone().add(coords[b]).multiplyScalar(0.5))
      midpoints.set(key, index)
    }
    return index
  }
  const subdivide = (a: number, b: number, c: number) => {
    const ab = edgeLengthSq(a, b), bc = edgeLengthSq(b, c), ca = edgeLengthSq(c, a)
    if (Math.max(ab, bc, ca) <= maxEdgeSq) { indices.push(a, b, c); return }
    // Longest-edge subdivision bounds curvature error without turning an entire
    // lake into one flat triangle hundreds of kilometres across.
    if (ab >= bc && ab >= ca) {
      const m = midpoint(a, b); subdivide(a, m, c); subdivide(m, b, c)
    } else if (bc >= ca) {
      const m = midpoint(b, c); subdivide(a, b, m); subdivide(a, m, c)
    } else {
      const m = midpoint(c, a); subdivide(a, b, m); subdivide(m, b, c)
    }
  }
  for (const polygon of lake.polygons) {
    const rings = polygon.map(ring => ring.slice(0, -1).map(p => new Vector2(p[0], p[1])))
    const offset = coords.length
    coords.push(...rings.flat())
    for (const [a, b, c] of ShapeUtils.triangulateShape(rings[0], rings.slice(1))) {
      subdivide(offset + a, offset + b, offset + c)
    }
  }
  const positions = new Float32Array(coords.length * 3)
  const normals = new Float32Array(positions.length)
  const p = new Vector3()
  coords.forEach(({ x, y }, i) => {
    // A small clearance prevents coincident provider water triangles fighting
    // the new surface; the geographic polygon, not a sea-level disc, bounds it.
    ecef(x, y, lake.levelM + lakeGeoid(lake, x, y) + 0.75, p).sub(origin).toArray(positions, i * 3)
    const phi = y * Math.PI / 180, theta = x * Math.PI / 180
    normals.set([Math.cos(phi) * Math.cos(theta), Math.cos(phi) * Math.sin(theta), Math.sin(phi)], i * 3)
  })
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new Float32BufferAttribute(new Float32Array(coords.length * 2), 2))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return { geometry, origin }
}
