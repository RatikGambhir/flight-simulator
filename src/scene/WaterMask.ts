import type { Effect } from 'postprocessing'
import { CanvasTexture, LinearFilter, Uniform, Vector4, type Vector3 } from 'three'

const COORDINATE_SCALE = 10_000
const HALF_LATITUDE = 3.5

interface Ring {
  west: number
  south: number
  east: number
  north: number
  coordinates: Int32Array
  path?: Path2D
}

function readPolygons(buffer: ArrayBuffer) {
  const data = new Int32Array(buffer)
  if (data[0] !== 0x31544157) throw new Error('Invalid water shoreline data')
  let offset = 1
  const polygons: Ring[][] = []
  // Ocean polygons first, followed by lakes. Inner rings are islands.
  for (let layer = 0; layer < 2; layer++) {
    const count = data[offset++]
    if (!(count > 0 && count <= data.length - offset)) throw new Error('Invalid shoreline polygon count')
    for (let i = 0; i < count; i++) {
      const rings: Ring[] = []
      const ringCount = data[offset++]
      if (!(ringCount > 0 && ringCount <= (data.length - offset) / 5)) throw new Error('Invalid shoreline ring count')
      for (let j = 0; j < ringCount; j++) {
        const west = data[offset++] / COORDINATE_SCALE
        const south = data[offset++] / COORDINATE_SCALE
        const east = data[offset++] / COORDINATE_SCALE
        const north = data[offset++] / COORDINATE_SCALE
        const points = data[offset++]
        const end = offset + 2 * points
        if (!(points > 0 && end <= data.length)) throw new Error('Invalid shoreline coordinates')
        const coordinates = data.subarray(offset, end)
        offset = end
        rings.push({ west, south, east, north, coordinates })
      }
      polygons.push(rings)
    }
  }
  return polygons
}

function ringPath(ring: Ring) {
  if (ring.path) return ring.path
  const path = new Path2D()
  const points = ring.coordinates
  path.moveTo(points[0] / COORDINATE_SCALE, points[1] / COORDINATE_SCALE)
  for (let i = 2; i < points.length; i += 2) {
    path.lineTo(points[i] / COORDINATE_SCALE, points[i + 1] / COORDINATE_SCALE)
  }
  path.closePath()
  return ring.path = path
}

const WATER_LOOKUP = /* glsl */ `
uniform sampler2D waterCoverage;
// Centre longitude, north edge, longitude span, latitude span, in degrees.
uniform vec4 waterBounds;
uniform bool hasWaterCoverage;

float mappedWater(const vec3 ecef) {
  if (!hasWaterCoverage) return 0.0;
  float lon = degrees(atan(ecef.y, ecef.x));
  float lat = degrees(atan(ecef.z, max(1.0, length(ecef.xy)) * 0.99330562));
  vec2 uv = vec2(mod(lon - waterBounds.x + 180.0, 360.0) - 180.0, waterBounds.y - lat);
  uv = uv / waterBounds.zw + vec2(0.5, 0.0);
  vec2 edges = min(uv, 1.0 - uv);
  float edge = min(waterBounds.z >= 360.0 ? 0.1 : edges.x, edges.y);
  // Retain the provider's finer shoreline at the boundary of the mask.
  return smoothstep(0.0, 0.055, edge) * smoothstep(0.65, 0.98, texture2D(waterCoverage, uv).r);
}
`

const WATER_LIGHTING = /* glsl */ `
  #if defined(SUN_LIGHT) || defined(SKY_LIGHT)
  float water = mappedWater(geographicPosition);
  #ifdef HAS_LIGHTING_MASK
  vec3 aircraftOffset = worldPosition - waterAircraft.xyz;
  if (lightingMask < 0.5 && dot(aircraftOffset, aircraftOffset) < waterAircraft.w) water = 0.0;
  #endif
  if (water > 0.0) {
    vec3 up = normalize(geographicPosition / vec3(1.0, 1.0, 0.99330562));
    vec3 east = normalize(cross(vec3(0.0, 0.001, 1.0), up));
    vec3 north = cross(up, east);
    vec2 wavePhase = vec2(dot(geographicPosition, vec3(0.035, 0.081, 0.019)),
                          dot(geographicPosition, vec3(-0.047, 0.022, 0.083)));
    vec2 waves = sin(wavePhase + time * vec2(0.85, -0.57)) * 0.021;
    waves *= 1.0 - smoothstep(250.0, 3000.0, length(viewPosition));
    vec3 waterNormal = normalize(up + east * waves.x + north * waves.y);
    float grazing = pow(1.0 - max(0.0, dot(waterNormal, -rayDirection)), 4.0);
    vec3 albedo = mix(vec3(0.011, 0.031, 0.048), vec3(0.036, 0.070, 0.100), grazing);
    vec3 waterLight = getSunSkyIrradiance(positionECEF, waterNormal, albedo, sunTransmittance);
    float day = smoothstep(-0.10, 0.07, dot(up, sunDirection));
    float specular = pow(max(0.0, dot(reflect(-sunDirection, waterNormal), -rayDirection)), 92.0);
    waterLight += day * sunTransmittance * specular * vec3(0.035, 0.028, 0.019);
    waterLight += (1.0 - day) * mix(vec3(0.00010, 0.00017, 0.00024), vec3(0.00032, 0.00049, 0.00072), grazing);
    radiance = mix(radiance, waterLight, water);
  }
  #endif
`

/** Provider-independent water coverage near the aircraft, at shoreline-map resolution. */
export class WaterMask {
  private readonly canvas = document.createElement('canvas')
  private readonly context = this.canvas.getContext('2d')!
  private readonly texture = new CanvasTexture(this.canvas)
  private readonly coverage = new Uniform(false)
  private readonly bounds = new Uniform(new Vector4(0, 0, 1, 1))
  private readonly aircraft = new Uniform(new Vector4())
  private polygons: Ring[][] = []
  private lastLat = Infinity
  private lastLon = Infinity

  constructor() {
    this.canvas.width = this.canvas.height = 2048
    this.texture.name = 'Nearby ocean and lake shorelines'
    this.texture.flipY = false
    this.texture.generateMipmaps = false
    this.texture.minFilter = LinearFilter
  }

  async load(url: string, signal: AbortSignal) {
    try {
      const response = await fetch(url, { signal })
      if (!response.ok) throw new Error(`Shorelines: ${response.status}`)
      const buffer = await response.arrayBuffer()
      if (!signal.aborted) this.polygons = readPolygons(buffer)
    } catch (error) {
      if (!signal.aborted) console.warn('Water shorelines unavailable', error)
    }
  }

  update(lat: number, lon: number) {
    if (this.polygons.length === 0) return
    const latitudeScale = Math.max(0.04, Math.cos(lat * Math.PI / 180))
    const movedLon = Math.abs(((lon - this.lastLon + 540) % 360) - 180)
    if (Math.abs(lat - this.lastLat) < 0.45 && movedLon * latitudeScale < 0.45) return
    this.lastLat = lat
    this.lastLon = lon
    const halfLon = Math.min(180, HALF_LATITUDE / latitudeScale)
    const west = lon - halfLon, east = lon + halfLon
    const south = lat - HALF_LATITUDE, north = lat + HALF_LATITUDE
    const { width, height } = this.canvas
    const ctx = this.context
    ctx.resetTransform()
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, width, height)
    for (const shift of [-360, 0, 360]) {
      const sx = width / (2 * halfLon), sy = height / (2 * HALF_LATITUDE)
      ctx.setTransform(sx, 0, 0, -sy, (shift - west) * sx, north * sy)
      const intersects = (ring: Ring) => ring.west + shift < east && ring.east + shift > west && ring.south < north && ring.north > south
      for (const polygon of this.polygons) {
        const outer = polygon[0]
        if (!intersects(outer)) continue
        ctx.fillStyle = '#fff'
        ctx.fill(ringPath(outer))
        ctx.fillStyle = '#000'
        for (let i = 1; i < polygon.length; i++) {
          const hole = polygon[i]
          if (intersects(hole)) ctx.fill(ringPath(hole))
        }
      }
    }
    this.bounds.value.set(lon, north, 2 * halfLon, 2 * HALF_LATITUDE)
    this.texture.needsUpdate = true
    this.coverage.value = true
  }

  protectAircraft(position: Vector3, radius: number) {
    this.aircraft.value.set(position.x, position.y, position.z, radius * radius)
  }

  private patch(effect: Effect, source: string) {
    effect.uniforms.set('waterCoverage', new Uniform(this.texture))
    effect.uniforms.set('waterBounds', this.bounds)
    effect.uniforms.set('hasWaterCoverage', this.coverage)
    const target = effect as unknown as { setFragmentShader(source: string): void }
    target.setFragmentShader(`${WATER_LOOKUP}\n${source}`)
  }

  shadeAerialPerspective(effect: Effect) {
    if (effect.uniforms.has('waterCoverage')) return
    const source = effect.getFragmentShader()
      .replace('vec3 positionECEF = (worldToECEFMatrix * vec4(worldPosition, 1.0)).xyz;',
        'vec3 geographicPosition = (worldToECEFMatrix * vec4(worldPosition, 1.0)).xyz;\n  vec3 positionECEF = geographicPosition;')
      .replace('applyTransmittanceInscatter(positionECEF, shadowLength, radiance);',
        `${WATER_LIGHTING}\n  applyTransmittanceInscatter(positionECEF, shadowLength, radiance);`)
    if (!source.includes('float water = mappedWater(geographicPosition);')) throw new Error('Aerial perspective water shader changed')
    effect.uniforms.set('waterAircraft', this.aircraft)
    this.patch(effect, `uniform vec4 waterAircraft;\n${source}`)
  }

  maskNightLights(effect: Effect) {
    const source = effect.getFragmentShader().replace('vec3 raw = max(texture2D(sceneAlbedo, uv).rgb, 0.0);', `
    if (terrain > 0.0) {
      vec3 ecef = (ecefFromWorld * vec4(eyePosition + ray * viewDepth, 1.0)).xyz;
      terrain *= 1.0 - mappedWater(ecef);
    }
    vec3 raw = max(texture2D(sceneAlbedo, uv).rgb, 0.0);`)
    this.patch(effect, source)
  }

  dispose() {
    this.polygons = []
    this.coverage.value = false
    this.lastLat = this.lastLon = Infinity
    this.texture.dispose()
  }
}
