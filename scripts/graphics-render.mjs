import {
  BoxGeometry, Color, Data3DTexture, DataTexture, HalfFloatType, Mesh, MeshBasicMaterial,
  PerspectiveCamera, PlaneGeometry, RedFormat, Scene, Texture, Vector3, WebGLRenderer,
} from 'three'
import { EffectComposer, EffectPass, RenderPass, ToneMappingEffect, ToneMappingMode } from 'postprocessing'
import { AerialPerspectiveEffect, PrecomputedTexturesGenerator, SkyMaterial } from '@takram/three-atmosphere'
import { CloudsEffect } from '@takram/three-clouds'
import {
  CloudHistory, setCloudNightLighting, stabilizeAerialPerspective, stabilizeClouds, stabilizeNightClouds,
} from '../src/scene/cloudRendering.ts'
import { prepareSky } from '../src/scene/celestialRendering.ts'
import { NightEffect } from '../src/scene/NightEffect.ts'
import { VolumetricCloudPass } from '../src/scene/VolumetricCloudPass.ts'
import { bindCloudGroundLighting } from '../src/scene/cloudGroundLighting.ts'
import { WaterMask } from '../src/scene/WaterMask.ts'
import { frame } from '../src/world/frame.ts'
import { RunwayScenery } from '../src/world/RunwayScenery.ts'
import { CUMULUS, cloudProfileForWeather } from '../src/weather/cloudProfiles.ts'

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
  stabilizeAerialPerspective(aerial)
  const water = new WaterMask()
  water.shadeAerialPerspective(aerial)

  const clouds = new CloudsEffect(camera, { resolutionScale: 0.5 })
  stabilizeClouds(clouds)
  Object.assign(clouds, atmosphere)
  clouds.qualityPreset = 'high'
  clouds.shadow.mapSize.set(32, 32)
  clouds.temporalUpscale = false
  clouds.localWeatherTexture = emptyWeather
  clouds.shapeTexture = noise
  clouds.shapeDetailTexture = noise
  clouds.turbulenceTexture = emptyWeather
  clouds.stbnTexture = noise
  clouds.coverage = 0
  clouds.clouds.hazeDensityScale = 0.01
  clouds.worldToECEFMatrix.copy(frame.ecefFromWorld)

  const night = new NightEffect(frame.ecefFromWorld, undefined, () => clouds.atmosphereOverlay?.map ?? null)
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

  function render(elevation, darkness, weather = false) {
    sun.set(Math.sin(elevation), 0, Math.cos(elevation))
    sky.sunDirection.copy(sun)
    clouds.sunDirection.copy(sun)
    aerial.sunDirection.copy(sun)
    setCloudNightLighting(clouds, darkness, new Vector3(0, 1, 0), 0)
    night.setFrame(camera, darkness, 0, up, [], camera.position.y)
    cloudPass.enabled = weather
    for (let i = 0; i < 5; i++) {
      history.update(clouds, camera, frame.version, 'chase', 'high')
      aerial.overlay = weather ? clouds.atmosphereOverlay : null
      aerial.shadow = weather ? clouds.atmosphereShadow : null
      aerial.shadowLength = weather ? clouds.atmosphereShadowLength : null
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

  // March a uniform deck with both render paths at an odd target size. Its
  // silhouette and color should agree when looking away from depth boundaries.
  camera.position.y = 100
  camera.rotation.x = 0.35
  camera.updateMatrixWorld()
  clouds.localWeatherTexture = texture(new Uint8Array([230, 230, 230, 255]))
  clouds.clouds.hazeDensityScale = 3e-5
  clouds.coverage = 0.6
  clouds.resolutionScale = 0.51
  render(0.65, 0, true)
  const points = [[0.2, 0.65], [0.4, 0.7], [0.6, 0.75], [0.8, 0.8]]
  const full = points.map(([x, y]) => pixel(x, y))
  clouds.temporalUpscale = true
  render(0.65, 0, true)
  const interleaved = points.map(([x, y]) => pixel(x, y))
  check(full.every((value, i) => delta(value, interleaved[i]) < 12),
    'Four-phase cloud reconstruction retains daylight cloud shading at odd render sizes')

  camera.near = 0.03
  camera.fov = 66
  camera.rotateY(0.30)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld()
  render(0.65, 0, true)
  check(brightness(pixel(0.5, 0.68)) > 25, 'A cockpit cut produces valid cloud lighting')

  camera.near = 0.3
  camera.fov = 58
  camera.updateProjectionMatrix()
  const volume = new VolumetricCloudPass(camera, frame.ecefFromWorld)
  composer.removePass(cloudPass)
  composer.addPass(volume, 1)
  sky.shadowLength = aerial.shadow = aerial.shadowLength = null
  aerial.overlay = volume.overlay
  bindCloudGroundLighting(aerial, volume)
  // Measure the custom cloud composite without the legacy night overlay.
  const day = new Vector3(0.8, 0, 0.6)
  const calm = new Vector3()
  const wind = new Vector3(0, 20, 0)
  let coverage = 0.63
  let profile = CUMULUS
  sky.sunDirection.copy(day)
  aerial.sunDirection.copy(day)
  camera.position.set(0, 250, 0)
  camera.lookAt(0, 670, -1200)
  night.setFrame(camera, 0, 0, up, [], 250)

  function cloudFrame(seconds = 0, velocity = calm, shadows = false) {
    volume.setWeather(seconds, { coverage, haze: 3e-5, sun: day, moon: calm, moonPhase: 0, wind: velocity, shadows, profile })
    composer.render(1 / 60)
    if (errors.length) throw new Error(errors.filter(Boolean).join('\n') || 'Custom cloud shader failed to link')
    const error = gl.getError()
    if (error !== gl.NO_ERROR) throw new Error(`Custom cloud WebGL error 0x${error.toString(16)}`)
    const samples = new Uint8Array(WIDTH * HEIGHT * 4)
    gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, samples)
    return samples
  }
  const meanDifference = (a, b) => {
    let difference = 0
    for (let i = 0; i < a.length; ++i) difference += Math.abs(a[i] - b[i])
    return difference / a.length
  }
  coverage = 0
  const clear = cloudFrame()
  coverage = 0.002
  check(meanDifference(clear, cloudFrame()) < 0.15, 'The first visible traces of coverage fade in continuously')
  coverage = 0.63
  const stationary = cloudFrame()
  check(meanDifference(stationary, clear) > 2, 'The custom volumetric deck contributes visible radiance')
  check(meanDifference(stationary, cloudFrame(180)) === 0, 'Three minutes in calm air leave stationary clouds pixel-identical')
  check(meanDifference(stationary, cloudFrame(1 / 60, wind)) < 0.5, 'The first frame of wind moves the cloud field continuously')
  const drifted = cloudFrame(90, wind)
  check(meanDifference(stationary, drifted) > 1, 'Sustained wind advects visible formations')
  check(meanDifference(drifted, cloudFrame(30)) === 0, 'Stopping the wind keeps the accumulated displacement')
  camera.position.x += wind.y * (90 + 1 / 60)
  const followingWind = cloudFrame()
  check(meanDifference(stationary, followingWind) < meanDifference(stationary, drifted) * 0.45,
    'Moving with the wind holds the same recognizable formations in view')
  camera.position.x = 0
  cloudFrame()

  const fixedView = frame.ecefFromWorld.clone().multiply(camera.matrixWorld)
  frame.setOrigin(6378137, 4100, -2700)
  const rebasedView = frame.worldFromEcef.clone().multiply(fixedView)
  rebasedView.decompose(camera.position, camera.quaternion, camera.scale)
  sky.worldToECEFMatrix.copy(frame.ecefFromWorld)
  aerial.worldToECEFMatrix.copy(frame.ecefFromWorld)
  const rebased = cloudFrame()
  check(meanDifference(drifted, rebased) < 0.3, 'A floating-origin shift preserves the cloud image at the same ECEF camera pose')
  const original = camera.quaternion.clone()
  camera.rotateY(1.4)
  const turned = cloudFrame()
  check(meanDifference(turned, rebased) > 3, 'A camera cut immediately renders the new view')
  camera.quaternion.copy(original)
  check(meanDifference(rebased, cloudFrame()) === 0, 'Returning from a camera cut restores the same image without history')

  // The same cloud pass is shared by cockpit, wing and exterior cameras.
  // Cover both wider cockpit projection and views that graze the cloud deck.
  const savedPosition = camera.position.clone()
  for (const [pitch, yaw, fov] of [[-0.38, 0.5, 58], [0.02, 1.8, 66], [0.28, -0.7, 49]]) {
    camera.position.y = 820
    camera.rotation.set(pitch, yaw, 0.08, 'YXZ')
    camera.fov = fov
    camera.updateProjectionMatrix()
    const view = cloudFrame()
    check(meanDifference(view, cloudFrame(1 / 60)) === 0, `Cloud sampling stays quiet at pitch ${pitch} and FOV ${fov}°`)
  }
  camera.position.copy(savedPosition)
  camera.quaternion.copy(original)
  camera.fov = 58
  camera.updateProjectionMatrix()

  const panel = new Mesh(new PlaneGeometry(40, 40), new MeshBasicMaterial({ color: 0x383838, fog: false }))
  panel.position.set(0, 0, -4).applyQuaternion(camera.quaternion).add(camera.position)
  panel.quaternion.copy(camera.quaternion)
  scene.add(panel)
  const overPanel = cloudFrame()
  coverage = 0
  check(meanDifference(overPanel, cloudFrame()) === 0, 'Scene depth occludes the custom volume in front of the camera')
  // Render a continuous surface so the shadow pass and its integration into
  // the direct-light term are exercised independently of the cloud composite.
  scene.remove(panel)
  panel.geometry.dispose()
  panel.material.dispose()
  frame.setOrigin(6378137, 0, 0)
  sky.worldToECEFMatrix.copy(frame.ecefFromWorld)
  aerial.worldToECEFMatrix.copy(frame.ecefFromWorld)
  aerial.overlay = null
  camera.position.set(0, 800, 0)
  camera.lookAt(0, 0, -1000)
  terrain.visible = true
  coverage = 0.95
  const lit = cloudFrame()
  const shadowed = cloudFrame(0, calm, true)
  check(meanDifference(lit, shadowed) > 3 && brightness(pixel(0.5, 0.45)) > 35,
    'Custom clouds cast ground shadows while ambient lighting remains visible')
  check(meanDifference(lit, cloudFrame()) === 0, 'Turning shadows off restores unshadowed terrain immediately')

  terrain.visible = false
  aerial.overlay = volume.overlay
  camera.position.set(0, 2300, 0)
  camera.lookAt(0, 3100, -1500)
  coverage = 0.68
  profile = cloudProfileForWeather({ type: 'FOG', precip: 'none', thunder: false, cloudCover: 0.95 })
  const beforeWeather = cloudFrame()
  check(meanDifference(beforeWeather, cloudFrame(1 / 60)) < 0.7,
    'A new weather report starts changing the cloud shape gradually')
  const fogBelow = cloudFrame(180)
  coverage = 0
  check(meanDifference(fogBelow, cloudFrame()) === 0, 'Low stratus from a fog report stays below an aircraft climbing away from it')
  camera.position.set(0, 140, 0)
  camera.lookAt(0, 180, -1500)
  const clearAtGround = cloudFrame()
  coverage = 0.68
  check(meanDifference(clearAtGround, cloudFrame()) > 2, 'A fog report fills the low atmosphere with a visible cloud layer')
  camera.position.set(0, 4000, 0)
  camera.lookAt(0, 5000, -1500)
  profile = cloudProfileForWeather({ type: 'THUNDERSTORM', precip: 'rain', thunder: true, cloudCover: 0.95 })
  const towers = cloudFrame(180)
  coverage = 0
  check(meanDifference(towers, cloudFrame()) > 2, 'Thunderstorm towers extend above the ordinary cumulus deck')
  // Simulate a photogrammetry tile containing an object in the strip and
  // another outside it. Both must use the ordinary scenery material path.
  frame.setOrigin(6378137, 0, 0)
  const testEnd = (ident, lat) => ({ ident, lat, lon: 0, elevation_ft: 0, displaced_threshold_ft: 0 })
  const airport = { ident: 'TEST', elevation_ft: 0 }
  const testRunway = { width_ft: 150, surface: 'ASP', ends: [testEnd('36', 0), testEnd('18', 0.008)] }
  const details = { airport, runways: [testRunway], geoid_m: 0 }
  const runways = new RunwayScenery(async query => query.type === 'airport' ? details : [{ airport }])
  await runways.update(0, 0, 0, airport.ident)
  const scenery = new Scene()
  const fragments = new BoxGeometry(8, 4, 8)
  const red = new MeshBasicMaterial({ color: 'red' })
  for (const x of [0, 42]) {
    const fragment = new Mesh(fragments, red)
    fragment.position.set(x, 1, -64)
    scenery.add(fragment)
  }
  runways.prepareScenery(scenery)
  scenery.add(runways.group)
  camera.position.set(0, 37, 25)
  camera.lookAt(20, 0, -70)
  renderer.setRenderTarget(null)
  renderer.render(scenery, camera)
  const projected = (x) => {
    const point = new Vector3(x, 2, -64).project(camera)
    return pixel(point.x * 0.5 + 0.5, point.y * 0.5 + 0.5)
  }
  const inside = projected(0)
  const outside = projected(42)
  check(!errors.length && gl.getError() === gl.NO_ERROR, 'Runway material and scenery masking compile in WebKit')
  check(brightness(inside) > 20 && inside[0] - inside[1] < 20 && outside[0] > 180 && outside[1] < 40,
    `Runway pavement covers scan fragments inside the strip and preserves scenery outside (${inside} / ${outside})`)
  check(runways.clears(new Vector3(0, 2, -64)) && !runways.clears(new Vector3(42, 2, -64)) &&
    !runways.clears(new Vector3(0, 20, -64)), 'Ground probes use the same narrow runway clearance as the renderer')
  runways.dispose()
  fragments.dispose()
  red.dispose()
  composer.dispose()
  cloudPass.dispose()
}

renderChecks().then(() => {
  document.title = 'PASS — GeoFlight graphics'
  window.webkit?.messageHandlers?.graphics?.postMessage({ passed: true, results })
}).catch((error) => {
  document.title = 'FAIL — GeoFlight graphics'
  document.querySelector('pre').textContent += '\n' + (error.stack ?? String(error))
  window.webkit?.messageHandlers?.graphics?.postMessage({ passed: false, results, error: `${error}\n${error.stack ?? ''}` })
})
