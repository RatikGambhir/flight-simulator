import {
  Color, Data3DTexture, DataTexture, FloatType, HalfFloatType, LinearFilter, Mesh, MeshBasicMaterial,
  PerspectiveCamera, PlaneGeometry, RedFormat, Scene, Texture, Uniform, Vector3, WebGLRenderer,
} from 'three'
import { BlendFunction, CopyPass, Effect, EffectComposer, EffectPass, RenderPass, ToneMappingEffect, ToneMappingMode } from 'postprocessing'
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
import { frame } from '../src/world/frame.ts'

const WIDTH = 256
const HEIGHT = 160
const results = []

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
    sun.set(Math.sin(elevation), 0, Math.cos(elevation))
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
  checkOcclusion(renderer, pixel)
  checkTerrainNormals(renderer)
  if (errors.length) throw new Error(errors.filter(Boolean).join('\n') || 'A WebGL shader failed to link')
  if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL reported an error during depth compositing')
}

renderChecks().then(() => {
  document.title = 'PASS — GeoFlight graphics'
  window.webkit?.messageHandlers?.graphics?.postMessage({ passed: true, results })
}).catch((error) => {
  document.title = 'FAIL — GeoFlight graphics'
  document.querySelector('pre').textContent += '\n' + (error.stack ?? String(error))
  window.webkit?.messageHandlers?.graphics?.postMessage({ passed: false, results, error: String(error.stack ?? error) })
})
