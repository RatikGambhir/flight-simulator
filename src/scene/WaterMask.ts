import type { Effect } from 'postprocessing'
import { CanvasTexture, LinearFilter, Uniform, Vector4, type Vector3 } from 'three'

import { makeWaveNormals } from './waveNormals'
import { WaterCoordinates } from './WaterCoordinates'
import { frame } from '../world/frame'

const COORDINATE_SCALE = 10_000
const HALF_LATITUDE = 3.5

interface Ring {
  ocean: boolean
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
        rings.push({ ocean: layer === 0, west, south, east, north, coordinates })
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
uniform float waterSeaLevel;
uniform bool hasWaterSeaLevel;

float seaSurfaceWater(const vec3 ecef) {
  if (!hasWaterSeaLevel) return 0.0;
  vec3 ellipsoid = ecef / vec3(6378137.0, 6378137.0, 6356752.314);
  vec3 foot = ecef / length(ellipsoid);
  vec3 up = normalize(foot / vec3(1.0, 1.0, 0.99330562));
  float height = dot(ecef - foot, up);
  return 1.0 - smoothstep(2.0, 5.0, height - waterSeaLevel);
}

float mappedWater(const vec3 ecef) {
  if (!hasWaterCoverage) return 0.0;
  float lon = degrees(atan(ecef.y, ecef.x));
  float lat = degrees(atan(ecef.z, max(1.0, length(ecef.xy)) * 0.99330562));
  vec2 uv = vec2(mod(lon - waterBounds.x + 180.0, 360.0) - 180.0, waterBounds.y - lat);
  uv = uv / waterBounds.zw + vec2(0.5, 0.0);
  vec2 edges = min(uv, 1.0 - uv);
  float edge = min(waterBounds.z >= 360.0 ? 0.1 : edges.x, edges.y);
  // The coarse map is only a hint. The actual tile surface must also be near
  // local sea level; reclaimed runways and buildings are land even where the
  // generalized map still labels them as ocean. Inland lakes keep their level.
  vec2 coverage = texture2D(waterCoverage, uv).rg;
  float surfaceWater = 1.0;
  if (hasWaterSeaLevel && coverage.g > 0.5) {
    surfaceWater = seaSurfaceWater(ecef);
  }
  return surfaceWater * smoothstep(0.0, 0.055, edge) * smoothstep(0.65, 0.98, coverage.r);
}

float waterFromTile(const vec3 ecef, const vec3 albedo) {
  // Tile imagery resolves inlets and reclaimed coastlines that a generalized
  // world map misses. Only confidently blue water at sea level extends that
  // map; neutral tarmac, brown ground and raised geometry retain tile shading.
  float blue = (albedo.b - albedo.r) / max(0.01, max(albedo.r, max(albedo.g, albedo.b)));
  float tileWater = smoothstep(0.12, 0.28, blue) * seaSurfaceWater(ecef);
  return max(mappedWater(ecef), tileWater);
}
`

const WATER_LIGHTING = /* glsl */ `
  #if defined(SUN_LIGHT) || defined(SKY_LIGHT)
  float water = waterFromTile(geographicPosition, inputColor.rgb);
  #ifdef HAS_LIGHTING_MASK
  // Shade both provider water and our sea-level shell identically: their depth
  // ordering changes at tile boundaries. Only nearby aircraft are excluded.
  vec3 aircraftOffset = worldPosition - waterAircraft.xyz;
  if (lightingMask < 0.5) {
    water = dot(aircraftOffset, aircraftOffset) < waterAircraft.w ? 0.0 : 1.0;
  }
  #endif
  if (water > 0.0) {
    vec3 up = normalize(geographicPosition / vec3(1.0, 1.0, 0.99330562));
    vec3 east = normalize(cross(vec3(0.0, 0.001, 1.0), up));
    vec3 north = cross(up, east);
    // Metre-scale, anchored coordinates survive floating-origin shifts. Mipmaps
    // filter subpixel waves; three differently oriented scales hide repetition.
    vec2 wp = (waterFromWorld * vec4(worldPosition, 1.0)).xz;
    vec2 n1 = texture2D(waterNormals, wp / 38.0 + time * vec2(0.011, 0.007)).xy * 2.0 - 1.0;
    vec2 n2 = texture2D(waterNormals, mat2(0.8, -0.6, 0.6, 0.8) * wp / 210.0 + time * vec2(-0.004, 0.006)).xy * 2.0 - 1.0;
    vec2 n3 = texture2D(waterNormals, wp / 1400.0 + time * vec2(0.0012, 0.0)).xy * 2.0 - 1.0;
    float distanceToWater = length(viewPosition);
    vec2 waves = n1 * 0.55 * (1.0 - smoothstep(1000.0, 9000.0, distanceToWater))
      + n2 * 0.45 * (1.0 - smoothstep(6000.0, 35000.0, distanceToWater))
      + n3 * 0.25 * (1.0 - smoothstep(25000.0, 150000.0, distanceToWater));
    vec3 waterNormal = normalize(up + east * waves.x + north * waves.y);
    float ndv = max(0.0, dot(waterNormal, -rayDirection));
    float fresnel = 0.0204 + 0.9796 * pow(1.0 - ndv, 5.0);
    // Preserve coastal color variation from real imagery without retaining the
    // open ocean's baked bathymetry/lighting seams.
    vec3 albedo = mix(vec3(0.006, 0.022, 0.032), clamp(inputColor.rgb, 0.0, 0.16), 0.12 * (1.0 - water));
    vec3 waterLight = getSunSkyIrradiance(positionECEF, waterNormal, albedo, sunTransmittance);
    vec3 reflected = reflect(rayDirection, waterNormal);
    reflected = normalize(reflected + up * max(0.0, 0.02 - dot(reflected, up)));
    vec3 reflectionTransmission;
    vec3 skyReflection = max(GetSkyRadiance(positionECEF + up * 0.01, reflected, 0.0,
      sunDirection, reflectionTransmission), vec3(0.0));
    waterLight = waterLight * (1.0 - fresnel) + skyReflection * fresnel;
    vec3 skyIrradiance;
    vec3 sunIrradiance = GetSunAndSkyIrradiance(positionECEF, up, sunDirection, skyIrradiance);
    vec3 halfVector = normalize(sunDirection - rayDirection);
    float ndh = max(0.0, dot(waterNormal, halfVector));
    float roughness = mix(0.14, 0.32, smoothstep(2000.0, 45000.0, distanceToWater));
    float a2 = pow(roughness, 4.0);
    float denominator = ndh * ndh * (a2 - 1.0) + 1.0;
    float distribution = a2 / max(3.14159265 * denominator * denominator, 1e-6);
    float sunFresnel = 0.0204 + 0.9796 * pow(1.0 - max(0.0, dot(halfVector, -rayDirection)), 5.0);
    waterLight += sunIrradiance * sunTransmittance * distribution * sunFresnel / max(4.0 * ndv, 0.2);
    float day = smoothstep(-0.10, 0.07, dot(up, sunDirection));
    waterLight += (1.0 - day) * mix(vec3(0.00010, 0.00017, 0.00024), vec3(0.00032, 0.00049, 0.00072), fresnel);
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
  private readonly seaLevel = new Uniform(0)
  private readonly hasSeaLevel = new Uniform(false)
  private readonly aircraft = new Uniform(new Vector4())
  private readonly normals = makeWaveNormals()
  private readonly coordinates = new WaterCoordinates()
  private readonly waterFromWorld = new Uniform(this.coordinates.matrix)
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

  update(lat: number, lon: number, seaLevel?: number) {
    this.coordinates.update(frame)
    this.hasSeaLevel.value = seaLevel !== undefined && Number.isFinite(seaLevel)
    if (this.hasSeaLevel.value) this.seaLevel.value = seaLevel!
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
        // Red covers all water; green identifies ocean for tile-height checks.
        ctx.fillStyle = outer.ocean ? '#ffff00' : '#ff0000'
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
    effect.uniforms.set('waterSeaLevel', this.seaLevel)
    effect.uniforms.set('hasWaterSeaLevel', this.hasSeaLevel)
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
    if (!source.includes('float water = waterFromTile(geographicPosition, inputColor.rgb);')) throw new Error('Aerial perspective water shader changed')
    effect.uniforms.set('waterNormals', new Uniform(this.normals))
    effect.uniforms.set('waterFromWorld', this.waterFromWorld)
    effect.uniforms.set('waterAircraft', this.aircraft)
    this.patch(effect, `uniform sampler2D waterNormals;\nuniform mat4 waterFromWorld;\nuniform vec4 waterAircraft;\n${source}`)
  }

  maskNightLights(effect: Effect) {
    const source = effect.getFragmentShader().replace('vec3 raw = max(texture2D(sceneAlbedo, uv).rgb, 0.0);', `
    vec3 raw = max(texture2D(sceneAlbedo, uv).rgb, 0.0);
    if (terrain > 0.0) {
      vec3 ecef = (ecefFromWorld * vec4(eyePosition + ray * viewDepth, 1.0)).xyz;
      terrain *= 1.0 - waterFromTile(ecef, raw);
    }`)
    this.patch(effect, source)
  }

  dispose() {
    this.polygons = []
    this.coverage.value = false
    this.lastLat = this.lastLon = Infinity
    this.texture.dispose()
    this.normals.dispose()
  }
}
