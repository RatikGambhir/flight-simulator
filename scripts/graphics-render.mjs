import {
  Color, Data3DTexture, DataTexture, FloatType, HalfFloatType, LinearFilter, Mesh, MeshBasicMaterial,
  PerspectiveCamera, PlaneGeometry, RedFormat, RepeatWrapping, Scene, Texture, TextureLoader, Uniform, Vector3, WebGLRenderer,
} from 'three'
import { BlendFunction, CopyPass, Effect, EffectComposer, EffectPass, RenderPass, ShaderPass, ToneMappingEffect, ToneMappingMode } from 'postprocessing'
import { AerialPerspectiveEffect, PrecomputedTexturesGenerator, SkyMaterial } from '@takram/three-atmosphere'
import { CloudsEffect } from '@takram/three-clouds'
import {
  CloudHistory, setCloudNightLighting, stabilizeAerialPerspective, stabilizeClouds, stabilizeNightClouds,
} from '../src/scene/cloudRendering.ts'
import { prepareSky } from '../src/scene/celestialRendering.ts'
import { NightEffect } from '../src/scene/NightEffect.ts'
import { OverlayPass } from '../src/scene/OverlayPass.ts'
import { SurfaceMaskPass } from '../src/scene/SurfaceMaskPass.ts'
import { TerrainNormalPass } from '../src/scene/TerrainNormalPass.ts'
import { WaterMask } from '../src/scene/WaterMask.ts'
import { Ocean } from '../src/scene/Ocean.ts'
import { frame, geodeticToEcef } from '../src/world/frame.ts'

const WIDTH = 256
const HEIGHT = 160
const results = []

async function loadCloudFixtures(clouds) {
  const fixtures = __CLOUD_FIXTURES__
  const loader = new TextureLoader()
  for (const [name, property] of [['local_weather.png', 'localWeatherTexture'], ['turbulence.png', 'turbulenceTexture']]) {
    const map = await loader.loadAsync(`data:image/png;base64,${fixtures[name]}`)
    map.wrapS = map.wrapT = RepeatWrapping
    clouds[property] = map
  }
  for (const [name, property, width, depth] of [
    ['shape.bin', 'shapeTexture', 128, 128], ['shape_detail.bin', 'shapeDetailTexture', 32, 32], ['stbn.bin', 'stbnTexture', 128, 64],
  ]) {
    const bytes = Uint8Array.from(atob(fixtures[name]), c => c.charCodeAt(0))
    const map = new Data3DTexture(bytes, width, width, depth)
    map.format = RedFormat
    if (name !== 'stbn.bin') map.minFilter = map.magFilter = LinearFilter
    map.wrapS = map.wrapT = map.wrapR = RepeatWrapping
    map.needsUpdate = true
    clouds[property] = map
  }
}

function check(condition, message) {
  if (!condition) throw new Error(message)
  results.push(message)
  document.querySelector('pre').textContent = results.join('\n')
}

function texture(bytes, width = 1, height = 1) {
  const result = new DataTexture(bytes, width, height)
  result.needsUpdate = true
  return result
}

async function checkCoastalCoverage(renderer) {
  const coast = new WaterMask()
  const point = new Vector3()
  const albedo = new Vector3(0.2, 0.2, 0.2)
  const probe = new Effect('WaterCoverageProbe', `uniform vec3 testPoint; uniform vec3 testAlbedo;
    void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
      outputColor = vec4(vec3(waterFromTile(testPoint, testAlbedo)), 1.0);
    }`, { blendFunction: BlendFunction.SRC, uniforms: new Map([['testPoint',new Uniform(point)], ['testAlbedo',new Uniform(albedo)]]) })
  coast.maskNightLights(probe)
  const composer = new EffectComposer(renderer)
  composer.addPass(new EffectPass(new PerspectiveCamera(), probe))
  const bytes = Uint8Array.from(atob(__WATER_FIXTURE__), c => c.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes]))
  try {
    await coast.load(url, new AbortController().signal)
    coast.update(35.55, 139.79, 37)
    const value = (lat, lon, ellipsoidHeight) => {
      geodeticToEcef(lat,lon,ellipsoidHeight,point)
      composer.render(1 / 60)
      const gl = renderer.getContext(), pixel = new Uint8Array(4)
      gl.readPixels(10, 10, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
      return pixel[0]
    }
    // Actual runway endpoints from the bundled Haneda data, including the
    // reclaimed offshore runway. Coastline generalization must not flood them.
    const points = [[35.565897,139.78655,6.7], [35.53969,139.805142,6.1], [35.560452,139.768734,6.1],
      [35.536591,139.785672,6.1], [35.524001,139.803469,14], [35.540598,139.822125,16.8], [35.55,139.79,10.7]]
    const runwayCoverage = points.map(([lat,lon,height]) => value(lat,lon,height+37))
    check(runwayCoverage.every(v => v < 166), `Haneda runways and apron retain tile imagery instead of water (${runwayCoverage})`)
    check(value(35.48,139.9,37) > 250, 'Open Tokyo Bay retains animated water shading')
    check(value(35.48,139.9,47) < 2, 'Actual tile elevation protects land even inside a coarse ocean polygon')
    // A location outside the coarse ocean polygon: tiles can add real coastal
    // water, but neutral or brown land at the same elevation must stay dry.
    albedo.set(0.01,0.04,0.08)
    check(value(35.6,139.7,37) > 250, 'Sea-level blue tile imagery refines water beyond the coarse map')
    check(value(35.6,139.7,47) < 2, 'Raised blue surfaces are not mistaken for sea-level water')
    albedo.set(0.2,0.2,0.2)
    check(value(35.6,139.7,37) < 2, 'Neutral tile imagery keeps low coastal tarmac dry')
    albedo.set(0.2,0.12,0.07)
    check(value(35.6,139.7,37) < 2, 'Brown tile imagery keeps low coastal ground dry')
    coast.update(43, -87.3, 0)
    check(value(43,-87.3,177) > 250, 'Elevated inland lakes retain water shading above sea level')
  } finally {
    URL.revokeObjectURL(url)
    coast.dispose()
    composer.dispose()
  }
}

/** Opacity must converge even when a dark sunset cloud has no RGB contrast. */
function checkCloudResolve(renderer) {
  const effect = new CloudsEffect(new PerspectiveCamera())
  stabilizeClouds(effect)
  const resolve = effect.cloudsPass.resolveMaterial
  resolve.shadowLength = false
  resolve.setSize(WIDTH, HEIGHT)
  const make = rgba => texture(new Float32Array(rgba))
  const current = make([0.02, 0.02, 0.02, 0])
  const history = make([0.02, 0.02, 0.02, 1])
  const velocity = make([1000, 0, 0, 0])
  const depth = make([1, 0, 0, 0])
  for (const map of [current, history, velocity, depth]) map.type = FloatType
  Object.assign(resolve.uniforms.colorBuffer, { value: current })
  resolve.uniforms.colorHistoryBuffer.value = history
  resolve.uniforms.depthVelocityBuffer.value = velocity
  resolve.uniforms.sceneDepthBuffer.value = depth
  resolve.uniforms.nearClearDepth.value = 0.3
  resolve.uniforms.nearHistoryDepth.value = 0.4
  resolve.uniforms.resetHistory.value = false
  const pass = new ShaderPass(resolve)
  pass.renderToScreen = true
  const gl = renderer.getContext()
  const rgba = new Uint8Array(4)
  const alpha = () => {
    pass.render(renderer, null, null)
    gl.readPixels(WIDTH / 2, HEIGHT / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba)
    return rgba[3]
  }
  for (let f = 0; f < 16; f++) {
    resolve.uniforms.frame.value = f
    check(alpha() < 2, `Dark cloud opacity clears stale history at temporal phase ${f}`)
  }
  current.image.data[3] = 1
  current.needsUpdate = true
  history.image.data[3] = 0
  history.needsUpdate = true
  check(alpha() > 253, 'A newly opaque dark cloud cannot inherit a clear hole from the aircraft')
  depth.image.data[0] = 0.2
  depth.needsUpdate = true
  for (const reset of [false, true]) {
    resolve.uniforms.resetHistory.value = reset
    check(alpha() < 2, `Near aircraft stays clear of stale cloud, including history reset=${reset}`)
  }
  for (const map of [current, history, velocity, depth]) map.dispose()
  pass.dispose()
  effect.dispose()
}

function checkOcclusion(renderer, pixel) {
  const scene = new Scene()
  const camera = new PerspectiveCamera(60, WIDTH / HEIGHT, 0.3, 2e7)
  const layer = 2
  camera.layers.enable(layer)
  const surface = new Mesh(new PlaneGeometry(6, 3), new MeshBasicMaterial({ color: 0x00ff00 }))
  surface.position.z = -8
  surface.layers.enable(layer)
  const terrain = new Mesh(new PlaneGeometry(1.5, 2), new MeshBasicMaterial({ color: 0xff0000 }))
  terrain.position.set(-0.75, 0, -4)
  scene.add(surface, terrain)

  const mask = new SurfaceMaskPass(scene, camera, layer)
  const probe = new EffectPass(camera, new Effect('MaskProbe', `
    uniform sampler2D mask;
    void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
      outputColor = vec4(vec3(texture2D(mask, uv).r), 1.0);
    }`, { blendFunction: BlendFunction.SRC, uniforms: new Map([['mask', new Uniform(mask.texture)]]) }))
  const overlay = new OverlayPass(camera)
  const guide = new Mesh(new PlaneGeometry(6, 1), new MeshBasicMaterial({ color: 0x0000ff, transparent: true }))
  guide.position.z = -6
  overlay.prepare(guide.material)
  overlay.overlay.add(guide)

  const composer = new EffectComposer(renderer, { multisampling: 0 })
  for (const pass of [new RenderPass(scene, camera), mask, probe, overlay, new CopyPass()]) composer.addPass(pass)
  overlay.enabled = false
  composer.render(1 / 60)
  check(pixel(0.4, 0.5)[0] > 245 && pixel(0.6, 0.5)[0] < 10, 'The surface mask only marks visible aircraft and water')
  probe.enabled = false
  overlay.enabled = true
  composer.render(1 / 60)
  const hidden = pixel(0.4, 0.5)
  const visible = pixel(0.6, 0.5)
  check(hidden[0] > 245 && hidden[2] < 10 && visible[2] > 245, 'The landing guide respects foreground depth')
  composer.dispose()
  for (const mesh of [surface, terrain, guide]) {
    mesh.geometry.dispose()
    mesh.material.dispose()
  }
}

/** Displaced DEM terrain must produce smooth, correctly tilted normals on the WebKit GPU path. */
function checkTerrainNormals(renderer) {
  const camera = new PerspectiveCamera(40, WIDTH / HEIGHT, 0.3, 2e7)
  camera.position.z = 30
  camera.updateMatrixWorld()
  const size = 64
  const ramp = new Float32Array(size * size)
  // Height rises 10 m across the 20 m wide tile along +x: a 26.6 degree slope.
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) ramp[y * size + x] = 10 * x / (size - 1)
  const heights = new DataTexture(ramp, size, size, RedFormat, FloatType)
  heights.minFilter = heights.magFilter = LinearFilter
  heights.needsUpdate = true
  const material = new MeshBasicMaterial()
  Object.assign(material, { displacementMap: heights, displacementScale: 1, displacementBias: 0 })
  const tile = new Mesh(new PlaneGeometry(20, 20, 32, 32), material)
  const pass = new TerrainNormalPass(camera)
  pass.roots = [tile]
  pass.setSize(WIDTH, HEIGHT)
  pass.render(renderer)
  const target = pass.target
  const read = (x, y) => {
    const rgba = new Uint8Array(4)
    renderer.readRenderTargetPixels(target, Math.floor(WIDTH * x), Math.floor(HEIGHT * y), 1, 1, rgba)
    return [...rgba].map((v) => v / 127.5 - 1)
  }
  const samples = [0.42, 0.46, 0.5, 0.54, 0.58].map((x) => read(x, 0.5))
  const expected = -Math.sin(Math.atan(0.5))
  check(samples.every((n) => Math.abs(n[0] - expected) < 0.08 && Math.abs(n[1]) < 0.06),
    `Terrain normals follow the displaced slope (${samples.map((n) => n[0].toFixed(2))} vs ${expected.toFixed(2)})`)
  check(Math.max(...samples.map((n) => n[0])) - Math.min(...samples.map((n) => n[0])) < 0.04,
    'Terrain normals are smooth across triangles and pixel quads')
  check(read(0.02, 0.02).every((v) => v < -0.99), 'Pixels without terrain keep a zero (degenerate) normal')
  pass.dispose()
  tile.geometry.dispose()
  material.dispose()
  heights.dispose()
}

async function renderChecks() {
  const renderer = new WebGLRenderer({ logarithmicDepthBuffer: true, preserveDrawingBuffer: true })
  renderer.setSize(WIDTH, HEIGHT)
  await checkCoastalCoverage(renderer)
  renderer.toneMappingExposure = 10
  document.body.append(renderer.domElement)
  const errors = []
  renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
    errors.push(gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment))
  }
  const gl = renderer.getContext()
  const link = gl.linkProgram.bind(gl)
  gl.linkProgram = (program) => {
    link(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) errors.push(gl.getProgramInfoLog(program))
  }

  const atmosphere = await new PrecomputedTexturesGenerator(renderer).update()
  frame.setOrigin(6378137, 0, 0)
  const ocean = new Ocean(2)
  const oceanPositions = ocean.mesh.geometry.getAttribute('position')
  const outer = new Vector3().fromBufferAttribute(oceanPositions, oceanPositions.count - 1)
  const earthRadius = 6371000
  const cruiseHeight = 45000 * 0.3048
  const horizonRadius = earthRadius * Math.sqrt(1 - (earthRadius / (earthRadius + cruiseHeight)) ** 2)
  check(Math.hypot(outer.x, outer.z) > horizonRadius, 'Ocean mesh extends past the horizon even at 45,000 ft')
  check(Math.abs(Math.hypot(outer.x, earthRadius + outer.y, outer.z) - earthRadius) < 0.1,
    'Distant ocean geometry follows the curved Earth instead of a truncated flat approximation')
  ocean.dispose()
  const scene = new Scene()
  const camera = new PerspectiveCamera(58, WIDTH / HEIGHT, 0.3, 2e7)
  camera.position.y = 100
  camera.updateMatrixWorld()

  const sky = new SkyMaterial(atmosphere)
  sky.worldToECEFMatrix.copy(frame.ecefFromWorld)
  prepareSky(sky, new Texture())
  const skyQuad = new Mesh(new PlaneGeometry(2, 2), sky)
  skyQuad.frustumCulled = false
  skyQuad.renderOrder = -100
  scene.add(skyQuad)

  const terrain = new Mesh(new PlaneGeometry(2000, 2000), new MeshBasicMaterial({ color: new Color(0.6, 0.6, 0.6) }))
  terrain.rotation.x = -Math.PI / 2
  terrain.position.z = -1000
  scene.add(terrain)

  // The right tile has no normal in the auxiliary pass. Both tiles have the
  // same albedo and main-scene depth. Sample well inside their shared edges.
  const normals = texture(new Uint8Array([128, 255, 128, 255, 0, 0, 0, 255]), 2)
  const lightingMask = texture(new Uint8Array([255, 255, 255, 255]))
  const noise = new Data3DTexture(new Uint8Array(4 * 4 * 4).fill(127), 4, 4, 4)
  noise.format = RedFormat
  noise.needsUpdate = true
  const emptyWeather = texture(new Uint8Array(4))
  const aerial = new AerialPerspectiveEffect(camera, {
    ...atmosphere, sunLight: true, skyLight: true, albedoScale: 0.45,
  })
  // Match the React wrapper. The constructor initializes the uniform but
  // assigning the property also enables the shader's HAS_NORMALS branch.
  aerial.normalBuffer = normals
  aerial.stbnTexture = noise
  aerial.worldToECEFMatrix.copy(frame.ecefFromWorld)
  aerial.lightingMask = { map: lightingMask, channel: 'r' }
  stabilizeAerialPerspective(aerial, () => cloudPass.enabled ? clouds : null)
  const water = new WaterMask()
  water.shadeAerialPerspective(aerial)

  const clouds = new CloudsEffect(camera, { resolutionScale: 0.5 })
  stabilizeClouds(clouds)
  Object.assign(clouds, atmosphere)
  clouds.qualityPreset = 'high'
  clouds.shadow.mapSize.set(32, 32)
  // Production marches with temporal upscaling (1/16 of pixels per frame).
  clouds.temporalUpscale = true
  clouds.localWeatherTexture = emptyWeather
  clouds.shapeTexture = noise
  clouds.shapeDetailTexture = noise
  clouds.turbulenceTexture = emptyWeather
  clouds.stbnTexture = noise
  clouds.coverage = 0
  clouds.clouds.hazeDensityScale = 0.01
  clouds.worldToECEFMatrix.copy(frame.ecefFromWorld)

  const night = new NightEffect(frame.ecefFromWorld, undefined, () => cloudPass.enabled ? clouds.atmosphereOverlay?.map ?? null : null)
  stabilizeNightClouds(night)
  water.maskNightLights(night)
  night.setLightingMask(lightingMask)

  const composer = new EffectComposer(renderer, { frameBufferType: HalfFloatType, multisampling: 0 })
  const renderPass = new RenderPass(scene, camera)
  const cloudPass = new EffectPass(camera, clouds)
  const aerialPass = new EffectPass(camera, aerial)
  composer.addPass(renderPass)
  composer.addPass(cloudPass)
  composer.addPass(night.albedoPass)
  composer.addPass(aerialPass)
  composer.addPass(new EffectPass(camera, night))
  composer.addPass(new EffectPass(camera, new ToneMappingEffect({ mode: ToneMappingMode.AGX })))
  const history = new CloudHistory()
  const up = new Vector3(0, 1, 0)
  const sun = new Vector3()

  function render(elevation, darkness, weather = false, frames = 5) {
    sun.set(0, Math.sin(elevation), -Math.cos(elevation)).transformDirection(frame.ecefFromWorld)
    sky.sunDirection.copy(sun)
    clouds.sunDirection.copy(sun)
    aerial.sunDirection.copy(sun)
    setCloudNightLighting(clouds, darkness, new Vector3(0, 1, 0), 0)
    night.setFrame(camera, darkness, 0, up, [], camera.position.y)
    cloudPass.enabled = weather
    for (let i = 0; i < frames; i++) {
      history.update(clouds, camera, frame.version, 'chase', 'high')
      sky.shadowLength = aerial.shadowLength
      composer.render(1 / 60)
    }
    if (errors.length) throw new Error(errors.filter(Boolean).join('\n') || 'A WebGL shader failed to link')
    const error = gl.getError()
    if (error !== gl.NO_ERROR) throw new Error(`WebGL error 0x${error.toString(16)}`)
  }

  function pixel(x, y) {
    const rgba = new Uint8Array(4)
    gl.readPixels(Math.floor(WIDTH * x), Math.floor(HEIGHT * y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba)
    return [...rgba.slice(0, 3)]
  }
  const brightness = (rgb) => rgb[0] * 0.213 + rgb[1] * 0.715 + rgb[2] * 0.072
  const terrainLight = () => [brightness(pixel(0.4, 0.25)), brightness(pixel(0.6, 0.25))]
  const delta = (a, b) => Math.max(...a.map((value, i) => Math.abs(value - b[i])))

  for (const reconstructNormal of [false, true]) {
    const label = reconstructNormal ? 'Raster depth normals' : 'Photogrammetry normals'
    aerial.reconstructNormal = reconstructNormal
    render(0.65, 0)
    const day = terrainLight()
    check(Math.min(...day) > 75 && Math.abs(day[0] - day[1]) < 10, `${label}: daylight tiles are lit uniformly (${day.map(Math.round)})`)
    render(-0.55, 1)
    const dark = terrainLight()
    check(Math.max(...dark) < Math.min(...day) * 0.5 && Math.abs(dark[0] - dark[1]) < 10,
      `${label}: missing normals cannot expose daytime imagery (${dark.map(Math.round)})`)
  }

  // A synthetic ocean polygon exercises the actual shoreline lookup and water
  // shader, without depending on a network imagery service during the test.
  const shoreline = new Int32Array([
    0x31544157, 1, 1, -10000, -10000, 10000, 10000, 5,
    -10000, -10000, 10000, -10000, 10000, 10000, -10000, 10000, -10000, -10000,
    1, 1, 100000, 100000, 110000, 110000, 5,
    100000, 100000, 110000, 100000, 110000, 110000, 100000, 110000, 100000, 100000,
  ])
  const shorelineUrl = URL.createObjectURL(new Blob([shoreline]))
  await water.load(shorelineUrl, new AbortController().signal)
  URL.revokeObjectURL(shorelineUrl)
  render(0.65, 0)
  const dry = pixel(0.4, 0.25)
  water.update(0, 0)
  render(0.65, 0)
  const wet = pixel(0.4, 0.25)
  check(delta(dry, wet) > 20 && wet[2] > wet[0], `Mapped water has blue reflected sky instead of flat terrain (${wet})`)
  // Provider tiles and the physical sea shell can trade depth ordering as LOD
  // changes. Their water must match rather than exposing rectangular seams.
  lightingMask.image.data.fill(0)
  lightingMask.needsUpdate = true
  render(0.65, 0)
  check(delta(wet, pixel(0.4, 0.25)) < 2, 'Provider water and the ocean shell have identical lighting across tile boundaries')
  water.protectAircraft(new Vector3(0, 0, 0), 2000)
  render(0.65, 0)
  const protectedWater = pixel(0.4, 0.25)
  aerial.uniforms.get('hasWaterCoverage').value = false
  render(0.65, 0)
  check(delta(protectedWater, pixel(0.4, 0.25)) < 2, 'Water coverage preserves aircraft materials')
  lightingMask.image.data.fill(255)
  lightingMask.needsUpdate = true

  render(0.01, 0)
  const sunset = pixel(0.5, 0.56)
  check(sunset[0] > sunset[2] + 8, `Sunset retains its warm sky color (${sunset})`)
  render(0.012, 0)
  check(delta(sunset, pixel(0.5, 0.56)) < 14, 'Small sunset time changes keep horizon color continuous')

  terrain.visible = false
  camera.position.y = 8500
  camera.updateMatrixWorld()
  render(-0.55, 1)
  const horizonRows = [0.43, 0.46, 0.49]
  const clearHorizon = horizonRows.map(y => pixel(0.5, y))
  render(-0.55, 1, true)
  if (!aerial.defines.has('HAS_OVERLAY') || !aerial.defines.has('HAS_SHADOW_LENGTH')) {
    throw new Error('The cloud fixture did not enable overlay and light-shaft composition')
  }
  check(clearHorizon.every((rgb, i) => delta(rgb, pixel(0.5, horizonRows[i])) < 5),
    'A night haze shell above the clouds leaves no visible horizon band')

  // Exercise all shader combinations on the same WebGL context as the desktop app.
  render(0.01, 0, true)
  check(brightness(pixel(0.5, 0.56)) > 20, 'Sunset with clouds and cloud shadows renders a visible sky')
  render(0.01, 0, false, 1)
  check(['HAS_OVERLAY', 'HAS_SHADOW', 'HAS_SHADOW_LENGTH'].every(define => !aerial.defines.has(define)),
    'Disabling clouds clears all aerial cloud inputs on the first frame')

  // Use the real production density/noise fields for horizon and temporal checks.
  await loadCloudFixtures(clouds)
  clouds.coverage = 0.8
  clouds.clouds.hazeDensityScale = 3e-5
  for (const height of [5, 150, 740, 760, 1500, 8500]) {
    camera.position.set(0, height, 0)
    camera.updateMatrixWorld()
    for (const elevation of [-0.04, 0.01, 0.08]) {
      render(elevation, 0, true, 20)
      const name = `horizon-${height}-${elevation}`
      const dip = Math.acos(6360000 / (6360000 + height))
      const horizon = Math.ceil((0.5 - 0.5 * Math.tan(dip) / Math.tan(camera.fov * Math.PI / 360)) * HEIGHT)
      let darkest = 255
      for (const x of [0.2, 0.4, 0.6, 0.8]) {
        for (let y = horizon + 1; y < horizon + 10; y++) darkest = Math.min(darkest, brightness(pixel(x, y / HEIGHT)))
      }
      check(darkest > 2, `Sunset sky has no black horizon stripe at ${height} m, sun ${elevation} rad (${darkest.toFixed(1)})`)
      window.webkit?.messageHandlers?.graphics?.postMessage({ snapshot: name, data: renderer.domElement.toDataURL().split(',')[1] })
    }
  }
  clouds.coverage = 0.45
  camera.position.set(0, 1000, 0)
  camera.updateMatrixWorld()
  render(0.01, 0, true, 32)
  let previousPixels = null
  let largestChange = 0
  for (let f = 0; f < 48; f++) {
    camera.position.x += 4
    camera.position.z -= 8
    camera.rotation.y += 0.001
    camera.updateMatrixWorld()
    render(0.01, 0, true, 1)
    const pixels = new Uint8Array(WIDTH * HEIGHT * 4)
    gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    if (previousPixels) {
      let change = 0
      for (let i = 0; i < pixels.length; i += 4) {
        for (let c = 0; c < 3; c++) change += Math.abs(pixels[i + c] - previousPixels[i + c])
      }
      largestChange = Math.max(largestChange, change / (WIDTH * HEIGHT * 3))
    }
    previousPixels = pixels
  }
  check(largestChange < 6, `Moving and turning through real sunset clouds stays continuous (${largestChange.toFixed(2)} / 255 peak change)`)

  // Inspect opacity and light separately: dark night RGB can hide large shape
  // changes in a whole-image average. Hold the camera and weather still at ORD.
  const savedFrame = frame.origin.clone()
  const chicago = geodeticToEcef(41.96, -87.89, 0)
  frame.setOrigin(chicago.x, chicago.y, chicago.z)
  clouds.worldToECEFMatrix.copy(frame.ecefFromWorld)
  camera.position.set(0, 210, 0)
  camera.rotation.set(0, Math.PI / 2, 0)
  camera.updateMatrixWorld()
  clouds.coverage = 0.5
  Object.assign(clouds.cloudLayers[2], { densityScale: 0.0006, shapeAmount: 0.85, weatherExponent: 1.5, coverageFilterWidth: 0.3 })
  const stabilityWidth = 768, stabilityHeight = 480
  renderer.setSize(stabilityWidth, stabilityHeight)
  composer.setSize(stabilityWidth, stabilityHeight)
  clouds.resolutionScale = 0.6
  clouds.clouds.minStepSize = 70
  clouds.clouds.perspectiveStepScale = 1.025
  const opacityMap = new Uniform(null)
  const opacityProbe = new Effect('CloudOpacityProbe', `uniform sampler2D cloudMap;
    void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
      vec4 cloud = texture2D(cloudMap, uv);
      float light = 1.0 - exp(-dot(cloud.rgb, vec3(0.213, 0.715, 0.072)) * 300.0);
      outputColor = vec4(cloud.a, light, 0.0, 1.0);
    }`, { blendFunction: BlendFunction.SRC, uniforms: new Map([['cloudMap', opacityMap]]) })
  const opacityPass = new EffectPass(camera, opacityProbe)
  composer.addPass(opacityPass)
  for (const cloudHeight of [210, 1500]) {
    camera.position.y = cloudHeight
    camera.updateMatrixWorld()
    render(-0.55, 1, true, 96)
    let lastOpacity = null, peakOpacityChange = 0, peakLightChange = 0, edgeCount = Infinity
    for (let f = 0; f < 32; f++) {
      opacityMap.value = clouds.atmosphereOverlay.map
      render(-0.55, 1, true, 4)
      const pixels = new Uint8Array(stabilityWidth * stabilityHeight * 4)
      gl.readPixels(0, 0, stabilityWidth, stabilityHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
      if (lastOpacity) {
        const changes = []
        const lightChanges = []
        // Exclude the Earth tangent: this test measures cloud texture motion,
        // not subpixel geometric coverage along the distant horizon.
        const firstRow = cloudHeight < 1000 ? 0.58 : 0.3
        for (let i = Math.floor(stabilityHeight * firstRow) * stabilityWidth * 4; i < pixels.length; i += 4) {
          if ((pixels[i] > 10 && pixels[i] < 245) || (lastOpacity[i] > 10 && lastOpacity[i] < 245)) {
            changes.push(Math.abs(pixels[i] - lastOpacity[i]))
          }
          if (pixels[i] > 10) lightChanges.push(Math.abs(pixels[i + 1] - lastOpacity[i + 1]))
        }
        changes.sort((a, b) => a - b)
        edgeCount = Math.min(edgeCount, changes.length)
        peakOpacityChange = Math.max(peakOpacityChange, changes[Math.floor(changes.length * 0.95)])
        lightChanges.sort((a, b) => a - b)
        peakLightChange = Math.max(peakLightChange, lightChanges[Math.floor(lightChanges.length * 0.99)])
      }
      lastOpacity = pixels
    }
    check(edgeCount > 100, `Cloud stability fixture at ${cloudHeight} m contains visible cloud edges (${edgeCount})`)
    check(peakOpacityChange <= 1, `Stationary night cloud edge opacity at ${cloudHeight} m stays stable (${peakOpacityChange}/255 at 95th percentile)`)
    check(peakLightChange <= 1, `Stationary night cloud lighting at ${cloudHeight} m stays stable (${peakLightChange}/255 at 99th percentile)`)
  }
  composer.removePass(opacityPass)
  opacityPass.dispose()
  renderer.setSize(WIDTH, HEIGHT)
  composer.setSize(WIDTH, HEIGHT)
  clouds.resolutionScale = 1
  clouds.clouds.minStepSize = 50
  clouds.clouds.perspectiveStepScale = 1.01
  frame.setOrigin(savedFrame.x, savedFrame.y, savedFrame.z)
  clouds.worldToECEFMatrix.copy(frame.ecefFromWorld)

  // Ask for a resolve size not divisible by four (the cloud image is rounded up to one
  // that is). Compare the march's depth classification against the actual geometry at
  // every jitter phase.
  camera.position.set(0, 1000, 0)
  camera.rotation.set(0, 0, 0)
  camera.updateMatrixWorld()
  skyQuad.visible = false
  const occluder = new Mesh(new PlaneGeometry(80, 16), new MeshBasicMaterial())
  occluder.position.set(0, 1040, -100)
  scene.add(occluder)
  clouds.resolutionScale = 0.51
  clouds.lightShafts = false
  const march = clouds.cloudsPass.currentMaterial
  if (!march.fragmentShader.includes('float stbn = stableNoise();')) throw new Error('Cloud march changed: missing noise lookup')
  march.fragmentShader = march.fragmentShader.replace('float stbn = stableNoise();', `
    outputColor = vec4(vec3(rayDistanceToScene > 0.0 && rayDistanceToScene < 200.0 ? 1.0 : 0.0), 1.0);
    outputDepthVelocity = vec3(0.0);
    return;
    float stbn = stableNoise();`)
  march.needsUpdate = true
  const lower = new Vector3(-40, 1032, -100).project(camera)
  const upper = new Vector3(40, 1048, -100).project(camera)
  let mismatches = 0
  // The march takes two frames in every three: 48 frames visit all 16 positions.
  const phases = new Set()
  for (let f = 0; f < 48; f++) {
    render(0.01, 0, true, 1)
    // Compare once both halves of the target hold this position.
    if (march.userData.geoflightCadence.march !== 'upper') continue
    phases.add(march.uniforms.frame.value % 16)
    const target = clouds.cloudsPass.currentRenderTarget
    const pixels = new Uint16Array(target.width * target.height * 4)
    renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, pixels)
    const jitter = march.uniforms.temporalJitter.value
    for (let y = 0; y < target.height; y++) for (let x = 0; x < target.width; x++) {
      const u = (Math.floor(((x + 0.5) / target.width + jitter.x) * WIDTH) + 0.5) / WIDTH * 2 - 1
      const v = (Math.floor(((y + 0.5) / target.height + jitter.y) * HEIGHT) + 0.5) / HEIGHT * 2 - 1
      const expected = u > lower.x && u < upper.x && v > lower.y && v < upper.y
      const actual = pixels[(y * target.width + x) * 4] > 0
      if (actual !== expected) mismatches++
    }
  }
  check(mismatches === 0 && phases.size === 16, `Cloud rays and foreground depth align across all 16 phases (${mismatches} mismatches, ${phases.size} phases)`)
  occluder.geometry.dispose()
  occluder.material.dispose()
  scene.remove(occluder)
  checkOcclusion(renderer, pixel)
  checkTerrainNormals(renderer)
  checkCloudResolve(renderer)
  if (errors.length) throw new Error(errors.filter(Boolean).join('\n') || 'A WebGL shader failed to link')
  if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL reported an error during depth compositing')
}

renderChecks().then(() => {
  document.title = 'PASS — GeoFlight graphics'
  window.webkit?.messageHandlers?.graphics?.postMessage({ passed: true, results })
}).catch((error) => {
  document.title = 'FAIL — GeoFlight graphics'
  const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  document.querySelector('pre').textContent += '\n' + detail
  window.webkit?.messageHandlers?.graphics?.postMessage({ passed: false, results, error: detail })
})
