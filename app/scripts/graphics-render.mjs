import {
  BufferGeometry, Color, Data3DTexture, DataTexture, DirectionalLight, Float32BufferAttribute, HalfFloatType,
  HemisphereLight, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, Points, RedFormat,
  RepeatWrapping, Scene, SRGBColorSpace, TextureLoader, Vector3, WebGLRenderer,
} from 'three'
import { EffectComposer, EffectPass, RenderPass, ToneMappingEffect, ToneMappingMode } from 'postprocessing'
import { AerialPerspectiveEffect, PrecomputedTexturesGenerator, SkyMaterial, StarsMaterial } from '@takram/three-atmosphere'
import { CloudsEffect } from '@takram/three-clouds'
import {
  CloudHistory, setCloudNightLighting, stabilizeAerialPerspective, stabilizeClouds, stabilizeNightClouds,
} from '../src/scene/cloudRendering.ts'
import { CelestialState, LunarView } from '../src/scene/celestial.ts'
import { prepareSky, prepareStars, setSkyMoon, setStarMoon } from '../src/scene/celestialRendering.ts'
import { NightEffect } from '../src/scene/NightEffect.ts'
import { VolumetricCloudPass } from '../src/scene/VolumetricCloudPass.ts'
import { bindCloudGroundLighting } from '../src/scene/cloudGroundLighting.ts'
import { WaterMask } from '../src/scene/WaterMask.ts'
import { frame } from '../src/world/frame.ts'
import { WorldSystem } from '../src/world/worldSystem.ts'
import { createLayers } from '../src/world/providers.ts'
import { CUMULUS, cloudProfileForWeather } from '../src/weather/cloudProfiles.ts'
import { CLEAR_HAZE, parseConditions, visualTargets } from '../src/weather/liveWeather.ts'
import { buildX15 } from '../src/aircraft/exterior/x15.ts'
import { disposeAircraftMeshes } from '../src/aircraft/models.ts'

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

  // Quality changes replace the tiles renderer. Exercise the same teardown and
  // decoder reuse without contacting Google or requiring a user key.
  const google = { provider: 'google', googleApiKey: '', quality: 'high' }
  const first = createLayers(google, renderer).layers[0].tiles
  const replacement = createLayers({ ...google, quality: 'ultra' }, renderer).layers[0].tiles
  first.dispose()
  replacement.dispose()
  check(first.lruCache.maxBytesSize === 320e6 && replacement.lruCache.maxBytesSize === 480e6 &&
    first.downloadQueue.maxJobsPerOrigin === 10 && first.parseQueue.maxJobs === 2,
  'Google scenery can be replaced and disposed with bounded tile loading')

  const atmosphere = await new PrecomputedTexturesGenerator(renderer).update()
  frame.setOrigin(6378137, 0, 0)
  const scene = new Scene()
  const camera = new PerspectiveCamera(58, WIDTH / HEIGHT, 0.3, 2e7)
  camera.position.y = 100
  camera.updateMatrixWorld()

  const sky = new SkyMaterial(atmosphere)
  sky.worldToECEFMatrix.copy(frame.ecefFromWorld)
  const lunarMap = await new TextureLoader().loadAsync(__LUNAR_TEST_MAP__)
  lunarMap.colorSpace = SRGBColorSpace
  lunarMap.wrapS = RepeatWrapping
  prepareSky(sky, lunarMap)
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

  function render(elevation, darkness, weather = false, ephemerisSun = null) {
    if (ephemerisSun) sun.copy(ephemerisSun)
    else sun.set(Math.sin(elevation), 0, Math.cos(elevation))
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
  camera.position.y = 107_960
  camera.updateMatrixWorld()
  render(0.65, 0)
  const space = pixel(0.5, 0.43)
  const limb = pixel(0.5, 0.35)
  check(Math.max(...space) < 3 && limb[2] > 20,
    `Above the atmosphere, only rays intersecting its curved limb show blue (${space}; ${limb})`)

  // At the X-15 recording's altitude the old altitude fade removed all night
  // haze, leaving a black band between the distant clouds and the star field.
  camera.position.y = 172_000 * 0.3048
  camera.updateMatrixWorld()
  const dawnElevation = -15.14 * Math.PI / 180
  const dawnAzimuth = 41.21 * Math.PI / 180
  const dawnSun = new Vector3(Math.sin(dawnElevation),
    Math.cos(dawnElevation) * Math.sin(dawnAzimuth), Math.cos(dawnElevation) * Math.cos(dawnAzimuth))
  render(0, 0, false, dawnSun)
  const darkHorizon = pixel(0.5, 0.38)
  render(0, 1, false, dawnSun)
  const litHorizon = pixel(0.5, 0.38)
  check(delta(darkHorizon, litHorizon) > 5 && litHorizon[2] > 8,
    `At 172,000 ft the true night horizon retains faint atmospheric glow (${darkHorizon}; ${litHorizon})`)
  let largestStep = 0
  let previous = litHorizon
  for (let row = Math.floor(0.38 * HEIGHT) + 1; row < Math.floor(0.7 * HEIGHT); row++) {
    const current = pixel(0.5, (row + 0.5) / HEIGHT)
    largestStep = Math.max(largestStep, delta(previous, current))
    previous = current
  }
  check(largestStep <= 8 && Math.max(...previous) < 4,
    `The night limb grades smoothly into space (largest adjacent-pixel change ${largestStep})`)

  // Above the haze shell, upward rays miss it and the atmosphere still fades
  // into black space without a second haze band near the local horizontal.
  camera.position.y = 190_600 * 0.3048
  camera.updateMatrixWorld()
  render(-0.12, 0, true)
  const twilightRows = [0.49, 0.55, 0.7]
  const upperSky = twilightRows.map(y => pixel(0.5, y))
  render(-0.12, 0.8, true)
  check(upperSky.every((rgb, i) => delta(rgb, pixel(0.5, twilightRows[i])) < 3),
    'At 190,600 ft the night haze cannot paint a second horizon above the atmospheric limb')
  const upperTwilight = pixel(0.5, 0.8)
  const twilightLimb = Math.max(...[0.32, 0.34, 0.36, 0.38, 0.40].map(y => brightness(pixel(0.5, y))))
  check(Math.max(...upperTwilight) < 5 && twilightLimb > 10,
    `At the edge of the atmosphere, high skyward rays stay dark while the limb stays visible (${upperTwilight}; ${Math.round(twilightLimb)})`)

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

  const lunarView = new LunarView()
  const lunarState = new CelestialState()
  function aimMoon(height, elevation) {
    camera.position.set(0, height, 0)
    camera.lookAt(0, height + Math.sin(elevation), -Math.cos(elevation))
    camera.updateMatrixWorld()
    const eye = frame.worldToEcef(camera.position)
    const direction = camera.getWorldDirection(new Vector3()).transformDirection(frame.ecefFromWorld)
    lunarView.update(eye.clone().addScaledVector(direction, 380_000_000), eye)
    lunarState.moonSunDirection.copy(direction).negate()
    setSkyMoon(sky, lunarView, lunarState)
  }

  camera.fov = 4
  camera.updateProjectionMatrix()
  aimMoon(108_000, 0.2)
  render(-0.55, 1)
  const nearLimb = brightness(pixel(0.532, 0.5))
  check(brightness(pixel(0.5, 0.5)) > 35 && nearLimb > 20 && brightness(pixel(0.55, 0.5)) < 5,
    'A full Moon above the atmosphere has the expected angular diameter')
  camera.fov = 8
  camera.updateProjectionMatrix()
  render(-0.55, 1)
  check(brightness(pixel(0.515, 0.5)) > 20 && brightness(pixel(0.53, 0.5)) < 5,
    'Doubling camera FOV reduces the Moon’s screen diameter as expected')

  lunarState.moonSunDirection.set(0, 1, 0)
  render(-0.55, 1)
  check(brightness(pixel(0.512, 0.5)) > brightness(pixel(0.488, 0.5)) + 25,
    'A quarter Moon is illuminated on the Sun-facing side')
  camera.rotateZ(Math.PI)
  camera.updateMatrixWorld()
  render(-0.55, 1)
  check(brightness(pixel(0.488, 0.5)) > brightness(pixel(0.512, 0.5)) + 25,
    'Camera roll rotates the apparent phase without moving its light source')

  const starMaterial = new StarsMaterial({ ...atmosphere, pointSize: 5 })
  starMaterial.worldToECEFMatrix.copy(frame.ecefFromWorld)
  prepareStars(starMaterial)
  const starGeometry = new BufferGeometry()
  starGeometry.setAttribute('position', new Float32BufferAttribute(camera.getWorldDirection(new Vector3()).toArray(), 3))
  starGeometry.setAttribute('magnitude', new Float32BufferAttribute([0], 1))
  starGeometry.setAttribute('color', new Float32BufferAttribute([1, 1, 1], 3))
  const star = new Points(starGeometry, starMaterial)
  star.frustumCulled = false
  scene.add(star)
  lunarState.moonSunDirection.copy(lunarView.direction)
  render(-0.55, 1)
  const unobscuredStar = brightness(pixel(0.5, 0.5))
  setStarMoon(starMaterial, lunarView)
  render(-0.55, 1)
  check(unobscuredStar > 40 && brightness(pixel(0.5, 0.5)) < 5, 'The unlit Moon blocks background stars')
  scene.remove(star)
  starMaterial.dispose()
  starGeometry.dispose()

  const dip = -Math.acos(6378137 / (6378137 + 108_000))
  aimMoon(108_000, dip)
  render(-0.55, 0)
  const upperMoon = pixel(0.5, 0.52), lowerMoon = pixel(0.5, 0.48)
  sky.moonAngularRadius = 0
  render(-0.55, 0)
  check(delta(upperMoon, pixel(0.5, 0.52)) > 10 && delta(lowerMoon, pixel(0.5, 0.48)) < 2,
    'The curved Earth can hide the lower half of the lunar disk')

  camera.position.set(0, 100, 0)
  const daylightEye = frame.worldToEcef(camera.position)
  lunarState.update(new Date('2026-11-17T17:00:00Z'), daylightEye)
  lunarState.observeMoon(daylightEye, lunarView)
  camera.lookAt(camera.position.clone().add(lunarView.apparentDirection.clone().applyQuaternion(frame.worldFromEcefRot)))
  camera.updateMatrixWorld()
  setSkyMoon(sky, lunarView, lunarState)
  render(0, 0, false, lunarState.sunDirection)
  const dayMoon = [0.48, 0.49, 0.5, 0.51, 0.52].map(x => pixel(x, 0.5))
  sky.moonAngularRadius = 0
  render(0, 0, false, lunarState.sunDirection)
  check(dayMoon.some((rgb, i) => delta(rgb, pixel(0.48 + i * 0.01, 0.5)) > 7),
    'The first-quarter Moon is visible through daylight scattering')

  const opaqueWeather = texture(new Uint8Array([255, 255, 255, 255]))
  clouds.localWeatherTexture = opaqueWeather
  clouds.coverage = 1
  render(0, 0, true, lunarState.sunDirection)
  const cloudSky = [0.49, 0.5, 0.51].map(x => pixel(x, 0.5))
  setSkyMoon(sky, lunarView, lunarState)
  render(0, 0, true, lunarState.sunDirection)
  check(cloudSky.every((rgb, i) => delta(rgb, pixel(0.49 + i * 0.01, 0.5)) < 3),
    'Dense cloud cover hides the Moon')
  clouds.localWeatherTexture = emptyWeather
  clouds.coverage = 0
  opaqueWeather.dispose()
  sky.moonAngularRadius = 0

  // Put an opaque scenery surface along the same sightline. Sky depth stays at
  // infinity even when the Moon is large in the frame.
  const blocker = new Mesh(new PlaneGeometry(40, 40), new MeshBasicMaterial({ color: 0x333333 }))
  blocker.position.copy(camera.position).addScaledVector(camera.getWorldDirection(new Vector3()), 100)
  blocker.quaternion.copy(camera.quaternion)
  scene.add(blocker)
  render(0, 0, false, lunarState.sunDirection)
  const blocked = pixel(0.51, 0.5)
  setSkyMoon(sky, lunarView, lunarState)
  render(0, 0, false, lunarState.sunDirection)
  check(delta(blocked, pixel(0.51, 0.5)) < 2, 'Opaque foreground scenery occludes the Moon')
  scene.remove(blocker)
  blocker.geometry.dispose()
  blocker.material.dispose()
  sky.moonAngularRadius = 0
  camera.fov = 58
  camera.rotation.set(0, 0, 0)
  camera.updateProjectionMatrix()

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
  let groundHeight = 0
  let haze = CLEAR_HAZE
  let upperClouds = false
  let latitude = 45
  sky.sunDirection.copy(day)
  aerial.sunDirection.copy(day)
  camera.position.set(0, 250, 0)
  camera.lookAt(0, 670, -1200)
  night.setFrame(camera, 0, 0, up, [], 250)

  function cloudFrame(seconds = 0, velocity = calm, shadows = false) {
    volume.setWeather(seconds, {
      coverage, haze, sun: day, moon: calm, moonPhase: 0, wind: velocity, shadows,
      profile, groundHeight, upperClouds, latitude,
    })
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

  aerial.overlay = volume.overlay
  groundHeight = 1800
  terrain.position.y = groundHeight
  camera.position.set(0, groundHeight + 915, 0)
  camera.lookAt(0, groundHeight, -1000)
  coverage = 0
  const clearApproach = cloudFrame(180)
  coverage = 0.72
  check(meanDifference(clearApproach, cloudFrame()) === 0,
    'Ordinary clouds stay above a descending approach at 3,000 ft above a high-elevation airport')
  const fogReport = parseConditions({
    weatherCondition: { type: 'FOG' }, cloudCover: 100, visibility: { distance: 0.5 },
  }, 0, 0, 0)
  camera.position.set(0, groundHeight + 140, 0)
  camera.lookAt(0, groundHeight, -1500)
  coverage = 0
  const clearAtGround = cloudFrame(180)
  ;({ coverage, haze } = visualTargets(fogReport))
  profile = cloudProfileForWeather(fogReport)
  check(meanDifference(clearAtGround, cloudFrame(180)) === 0, 'A live fog report leaves the view clear near the ground')

  terrain.visible = false
  groundHeight = 0
  camera.position.set(0, 4000, 0)
  camera.lookAt(0, 5000, -1500)
  profile = CUMULUS
  coverage = 0.68
  const beforeWeather = cloudFrame(180)
  profile = cloudProfileForWeather({ type: 'THUNDERSTORM', precip: 'rain', thunder: true, cloudCover: 0.95 })
  check(meanDifference(beforeWeather, cloudFrame(1 / 60)) < 0.7,
    'A new weather report starts changing the cloud shape gradually')
  const towers = cloudFrame(180)
  coverage = 0
  check(meanDifference(towers, cloudFrame()) > 2, 'Thunderstorm towers extend above the ordinary cumulus deck')

  // Separate the decks by looking up from between them, then repeat in the tropics.
  profile = CUMULUS
  upperClouds = true
  coverage = 0.72
  camera.position.set(0, 5000, 0)
  camera.lookAt(0, 9800, -4500)
  const highClouds = cloudFrame(180)
  upperClouds = false
  check(meanDifference(highClouds, cloudFrame(180)) > 0.4, 'Temperate cirrus is visible from above the middle cloud deck')
  camera.position.set(0, 5000, 0)
  camera.lookAt(0, 3100, -2400)
  upperClouds = true
  const middleClouds = cloudFrame(180)
  upperClouds = false
  check(meanDifference(middleClouds, cloudFrame(180)) > 1, 'Middle clouds render between the low deck and cirrus')
  camera.position.set(0, 10_500, 0)
  camera.lookAt(0, 15_500, -4500)
  upperClouds = true
  const aboveTemperateClouds = cloudFrame(180)
  latitude = 10
  const tropicalClouds = cloudFrame(180)
  check(meanDifference(aboveTemperateClouds, tropicalClouds) > 0.4, 'Tropical cirrus renders above the temperate high cloud deck')

  const tropicalView = frame.ecefFromWorld.clone().multiply(camera.matrixWorld)
  const moveOrigin = (x, y, z) => {
    frame.setOrigin(x, y, z)
    frame.worldFromEcef.clone().multiply(tropicalView).decompose(camera.position, camera.quaternion, camera.scale)
    sky.worldToECEFMatrix.copy(frame.ecefFromWorld)
    aerial.worldToECEFMatrix.copy(frame.ecefFromWorld)
  }
  moveOrigin(6378137, 4100, -2700)
  check(meanDifference(tropicalClouds, cloudFrame()) < 0.3, 'A floating-origin shift preserves high cloud formations')
  moveOrigin(6378137, 0, 0)
  coverage = 0
  check(meanDifference(aboveTemperateClouds, cloudFrame(180)) === 0, 'A clear report leaves all three cloud levels empty')

  // The default cloud renderer and the X-15's exhaust share the main scene at
  // high altitude. The plume should change the picture without restoring the band.
  const rocket = buildX15()
  for (const gear of rocket.gear) gear.pivot.rotation[gear.axis] = gear.retracted
  const light = new DirectionalLight(0xffe2c5, 2.5)
  light.position.set(-5, 3, 5)
  const fill = new HemisphereLight(0xbacbdf, 0x191419, 1)
  scene.add(light, fill, rocket.root)
  const rocketHeight = 190_600 * 0.3048
  rocket.root.position.set(0, rocketHeight, 0)
  rocket.root.rotation.set(0.30, -0.55, -0.14)
  camera.position.set(12, rocketHeight + 1.8, 16)
  camera.lookAt(0, rocketHeight, 0)
  camera.updateMatrixWorld()
  const twilight = new Vector3(-0.12, 0, 0.993).normalize()
  sky.sunDirection.copy(twilight)
  aerial.sunDirection.copy(twilight)
  const aircraftMask = texture(new Uint8Array([0, 0, 0, 255]))
  aerial.lightingMask = { map: aircraftMask, channel: 'r' }
  coverage = 0.65
  night.setFrame(camera, 0, 0, up, [], rocketHeight)
  cloudFrame()
  const clearRocketSky = pixel(0.5, 0.7)
  night.setFrame(camera, 0.8, 0, up, [], rocketHeight)
  const clearRocket = cloudFrame()
  check(delta(clearRocketSky, pixel(0.5, 0.7)) < 3, 'The X-15 view with default clouds leaves the upper sky free of haze')
  rocket.exhaust(0.85, 0, 1, 4)
  check(meanDifference(clearRocket, cloudFrame()) > 0.015, 'The X-15 exhaust renders in its high-altitude exterior view')
  scene.remove(light, fill, rocket.root)
  disposeAircraftMeshes(rocket.root)
  aerial.lightingMask = { map: lightingMask, channel: 'r' }
  aircraftMask.dispose()

  // Fixture for the meshes a photogrammetry tileset provides at an airport.
  // Feed the same mesh to the renderer and the streaming raycast boundary.
  frame.setOrigin(6378137, 0, 0)
  const airportScene = new Scene()
  const world = new WorldSystem(google, renderer, camera, airportScene)
  const { tiles } = world.layers[0]
  const pavement = new Mesh(new PlaneGeometry(46, 120), new MeshBasicMaterial({ color: '#ff0000' }))
  pavement.rotation.x = -Math.PI / 2
  pavement.position.z = -64
  pavement.updateMatrix()
  pavement.matrix.premultiply(frame.ecefFromWorld)
  pavement.matrixAutoUpdate = false
  pavement.userData.tile = { geometricError: 2 }
  tiles.group.add(pavement)
  pavement.updateMatrixWorld(true)
  tiles.group.raycast = (raycaster, hits) => raycaster.intersectObject(pavement, false, hits)
  tiles.dispatchEvent({ type: 'load-model', scene: pavement })
  airportScene.updateMatrixWorld(true)
  camera.position.set(0, 37, 25)
  camera.lookAt(0, 0, -64)
  renderer.setRenderTarget(null)
  renderer.render(airportScene, camera)
  const runwayPixel = pixel(0.5, 0.5)
  check(runwayPixel[0] > 180 && runwayPixel[1] < 40 && runwayPixel[2] < 40 && airportScene.children.length === 1,
    `Runway area shows the tile's own surface color (${runwayPixel})`)
  const ground = world.probeGround(0.00058, 0, 60)
  check(ground && Math.abs(ground.height) < 0.01 && ground.error === 2,
    `Runway ground probes use the streamed surface and retain the tile error (${JSON.stringify(ground)})`)
  const runwayDistance = world.probeSegment(new Vector3(0, 8, -64), new Vector3(0, -1, 0), 10)
  check(runwayDistance !== null && Math.abs(runwayDistance - 8) < 1e-6 &&
    world.probeSegment(new Vector3(30, 8, -64), new Vector3(0, -1, 0), 10) === null,
    'Runway collision probes hit the tile mesh and respect its edges')
  check(!errors.length && gl.getError() === gl.NO_ERROR, 'The airport tiles render without WebGL errors')
  world.dispose()
  pavement.geometry.dispose()
  pavement.material.dispose()
  composer.dispose()
  cloudPass.dispose()
  lunarMap.dispose()
}

renderChecks().then(() => {
  document.title = 'PASS — GeoFlight graphics'
  window.webkit?.messageHandlers?.graphics?.postMessage({ passed: true, results })
}).catch((error) => {
  document.title = 'FAIL — GeoFlight graphics'
  document.querySelector('pre').textContent += '\n' + (error.stack ?? String(error))
  window.webkit?.messageHandlers?.graphics?.postMessage({ passed: false, results, error: `${error}\n${error.stack ?? ''}` })
})
