// @refresh reset
import { useFrame, useThree } from '@react-three/fiber'
import { AerialPerspective, Atmosphere, LightingMask, SkyLight, SunLight, type AtmosphereApi } from '@takram/three-atmosphere/r3f'
import type { LightingMaskPass, SkyLightProbe, SunDirectionalLight } from '@takram/three-atmosphere'
import { Dithering, LensFlare } from '@takram/three-geospatial-effects/r3f'
import { Bloom, EffectComposer, EffectGroup, SMAA, ToneMapping } from '@react-three/postprocessing'
import { SMAAPreset, ToneMappingMode, type Effect } from 'postprocessing'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AdditiveBlending, Color, Group, InstancedMesh, MathUtils, Mesh, type PerspectiveCamera, ShaderMaterial, SphereGeometry, SpotLight, SRGBColorSpace, type Texture, TextureLoader, Vector3, WebGLRenderTarget, HalfFloatType } from 'three'
import { AircraftController, LIGHTING_MASK_LAYER } from '../aircraft/aircraftController'
import { disposeAircraftMeshes } from '../aircraft/models'
import { sound } from '../audio/sound'
import { controls } from '../input/controls'
import { Flags, S } from '../sim/protocol'
import { sim } from '../sim/simClient'
import { shuttleSite } from '../sim/shuttleSites'
import { providerReady, useApp } from '../state/store'
import { enuBasis, frame, geodeticToEcef, WGS84_A, WGS84_F } from '../world/frame'
import { CelestialSky } from './CelestialSky'
import { CelestialState, SceneClock } from './celestial'
import { animateLaunchPad, buildISS, buildLaunchPad, orientStation } from './spaceModels'
import { useAtmosphereTextures } from './useAtmosphereTextures'
import { bakeCloudMap, EARTH_NIGHT_FRAGMENT, EARTH_SPACE_FRAGMENT, EARTH_SPACE_VERTEX } from './spaceRendering'
import { LaunchEffects, LaunchFxPass } from './launchEffects'
import { patchLightingMask } from './lightingMask'
import { stabilizeAerialPerspective } from './cloudRendering'
import { useWorld } from './useWorld'
import { worldStatus } from './worldStatus'

function createGlobe(cloudMap: Texture) {
  const loader = new TextureLoader()
  const day = loader.load(`${import.meta.env.BASE_URL}space/earth-day.jpg`)
  day.colorSpace = SRGBColorSpace
  day.anisotropy = 4
  const material = new ShaderMaterial({ vertexShader: EARTH_SPACE_VERTEX, fragmentShader: EARTH_SPACE_FRAGMENT,
    uniforms: { dayMap: { value: day }, brightness: { value: 1 }, cloudAmount: { value: 0 }, cloudMap: { value: cloudMap } } })
  const mesh = new Mesh(new SphereGeometry(1, 192, 128), material)
  // Geometry axes ARE ECEF here, so z (not y) is Earth's polar axis.
  mesh.scale.set(WGS84_A, WGS84_A, WGS84_A * (1 - WGS84_F))
  mesh.name = 'Earth · WGS84 · true scale'
  return mesh
}

/** The night side's city lights, drawn by the launch effects pass over the lit globe. */
function createCityLights(globe: ReturnType<typeof createGlobe>, fx: LaunchEffects) {
  const night = new TextureLoader().load(`${import.meta.env.BASE_URL}atmosphere/city-lights.jpg`)
  night.colorSpace = SRGBColorSpace
  const material = new ShaderMaterial({ vertexShader: EARTH_SPACE_VERTEX, fragmentShader: EARTH_NIGHT_FRAGMENT,
    uniforms: { ...fx.depth, nightMap: { value: night }, sunECEF: { value: new Vector3(1, 0, 0) }, intensity: { value: 0.15 }, cloudAmount: globe.material.uniforms.cloudAmount, cloudMap: globe.material.uniforms.cloudMap },
    transparent: true, depthTest: false, depthWrite: false, blending: AdditiveBlending })
  const mesh = new Mesh(globe.geometry, material)
  mesh.name = 'Earth · city lights'
  mesh.frustumCulled = false
  mesh.renderOrder = -1
  return mesh
}

/** The flight canvas exposure, matching ordinary flights. */
const SCENE_EXPOSURE = 10
/** Streamed terrain and imagery are drawn below this height; the globe alone above. */
const SCENERY_CEILING = 120_000

interface Resources {
  aircraft: AircraftController; globe: ReturnType<typeof createGlobe>; cityLights: Mesh<SphereGeometry, ShaderMaterial>; iss: Group; pad: Group; padLights: SpotLight[]; fx: LaunchEffects
}

/** Ground tracking cameras for the launch: a long-lens site camera and a pad camera. */
const SITE_CAMERA = { distance: 1500, bearing: 140, height: 28, ceiling: 55_000 }
const PAD_CAMERA = { distance: 230, bearing: 215, height: 5, ceiling: 4_000 }

function SpaceFlight({ atmosphere, celestial, sunLight, skyLight, onEffects }: {
  atmosphere: React.RefObject<AtmosphereApi | null>; celestial: CelestialState
  sunLight: React.RefObject<SunDirectionalLight | null>; skyLight: React.RefObject<SkyLightProbe | null>
  onEffects: (fx: LaunchEffects | null) => void
}) {
  const { gl, camera, scene } = useThree()
  const [resources, setResources] = useState<Resources | null>(null)
  const sceneryReady = useApp((s) => providerReady(s.settings))
  const shadows = useApp((s) => s.settings.shadows)
  // Streamed scenery is released in orbit, freeing its tile cache (up to 480 MB);
  // it streams again when a mission restarts from the pad.
  const [scenery, setScenery] = useState(true)
  const world = useWorld(sceneryReady && scenery)
  const clock = useMemo(() => new SceneClock(), [])
  const state = useRef({ gen: -1, lastSun: -Infinity, yaw: -0.1, pitch: 0.32, zoom: 1, lookYaw: 0, lookPitch: -0.1, phase: '', spawnAt: 0, lastProbe: 0, lastGeoid: -Infinity, geoid: 0, eclipse: false, fov: 0, shadowSize: 0 })
  const scratch = useMemo(() => ({ observer: new Vector3(), up: new Vector3(), forward: new Vector3(), side: new Vector3(), target: new Vector3(),
    sun: new Vector3(), station: new Vector3(), normal: new Vector3(), pad: new Vector3(), radial: new Vector3(), east: new Vector3(), north: new Vector3(), padUp: new Vector3(),
    padEcef: new Vector3(), padUpEcef: new Vector3(), padEast: new Vector3(), padNorth: new Vector3(), velocity: new Vector3(), wind: new Vector3(),
    sunColor: new Color(), ambient: new Color(), e: new Vector3(), n: new Vector3(), u: new Vector3() }), [])

  // Create resources per effect lifetime so StrictMode's cleanup cannot dispose live textures.
  useEffect(() => {
    const clouds = bakeCloudMap(gl)
    const globe = createGlobe(clouds.texture)
    const pad = buildLaunchPad()
    const aircraft = new AircraftController('endeavour', gl)
    const fx = new LaunchEffects(aircraft.model.root)
    const cityLights = createCityLights(globe, fx)
    fx.scene.add(cityLights)
    const r: Resources = { aircraft, globe, cityLights, iss: buildISS(), pad, padLights: pad.children.filter((o): o is SpotLight => o instanceof SpotLight), fx }
    // Forward-lit objects: the atmosphere pass hazes them but does not relight them.
    // The globe is plain albedo and is lit by that pass, like the streamed scenery.
    for (const o of [r.iss, pad]) o.traverse((c) => c.layers.enable(LIGHTING_MASK_LAYER))
    camera.layers.enable(LIGHTING_MASK_LAYER)
    const fov = (camera as PerspectiveCamera).fov
    state.current.fov = fov
    const exposure = gl.toneMappingExposure
    scene.add(r.aircraft.container, r.globe, r.iss, r.pad, fx.light)
    // Compile the exhaust shaders now rather than on the liftoff frame. The
    // composer draws them into a linear render target, which selects a
    // different program variant than the screen, so compile against one.
    const hidden = fx.scene.children.filter((o) => !o.visible)
    for (const o of hidden) o.visible = true
    const warm = new WebGLRenderTarget(1, 1, { type: HalfFloatType }), previous = gl.getRenderTarget()
    gl.setRenderTarget(warm)
    gl.compile(fx.scene, camera)
    gl.setRenderTarget(previous)
    warm.dispose()
    for (const o of hidden) o.visible = false
    setResources(r)
    onEffects(fx)
    return () => {
      onEffects(null)
      scene.remove(r.aircraft.container, r.globe, r.iss, r.pad, fx.light)
      fx.scene.remove(cityLights)
      cityLights.material.uniforms.nightMap.value.dispose()
      cityLights.material.dispose()
      fx.dispose()
      clouds.dispose()
      const cam = camera as PerspectiveCamera
      cam.fov = fov; cam.updateProjectionMatrix()
      gl.toneMappingExposure = exposure
      r.aircraft.dispose()
      disposeAircraftMeshes(r.globe)
      disposeAircraftMeshes(r.iss)
      disposeAircraftMeshes(r.pad)
      r.iss.traverse((o) => {
        const line = o as unknown as { isLine?: boolean; geometry: SphereGeometry; material: ShaderMaterial }
        if (line.isLine) { line.geometry.dispose(); line.material.dispose() }
        if (o instanceof InstancedMesh) o.dispose()
      })
      sound.setActive(false)
    }
  }, [gl, scene, camera, onEffects])

  // Sun shadows cover the stack, the service structure and the pad deck.
  useEffect(() => {
    const l = sunLight.current
    if (!l) return
    l.castShadow = shadows
    l.shadow.mapSize.set(2048, 2048)
    l.shadow.camera.near = 1
    l.shadow.camera.far = 900
    l.shadow.bias = -0.0004
    l.shadow.normalBias = 0.04
    state.current.shadowSize = 0
  }, [sunLight, shadows, resources])

  // After the library recomputes the sun's transmitted color: darken it in Earth's shadow.
  useFrame(() => {
    if (state.current.eclipse) sunLight.current?.color.setScalar(0)
  }, 0.5)

  useEffect(() => {
    const el = gl.domElement
    let dragging = false, x = 0, y = 0
    const down = (e: PointerEvent) => { dragging = true; x = e.clientX; y = e.clientY; el.setPointerCapture(e.pointerId) }
    const move = (e: PointerEvent) => {
      if (!dragging) return
      const s = state.current
      if (useApp.getState().camera === 'cockpit') {
        s.lookYaw -= (e.clientX - x) * 0.004; s.lookPitch = MathUtils.clamp(s.lookPitch - (e.clientY - y) * 0.004, -1.3, 1.3)
      } else {
        s.yaw -= (e.clientX - x) * 0.005; s.pitch = MathUtils.clamp(s.pitch + (e.clientY - y) * 0.005, -1.3, 1.3)
      }
      x = e.clientX; y = e.clientY
    }
    const up = (e: PointerEvent) => { dragging = false; if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId) }
    const wheel = (e: WheelEvent) => { state.current.zoom = MathUtils.clamp(state.current.zoom * Math.exp(e.deltaY * 0.001), 0.4, 20) }
    const reset = () => { Object.assign(state.current, { yaw: -0.1, pitch: 0.32, zoom: 1, lookYaw: 0, lookPitch: -0.1 }) }
    el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move); el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up); el.addEventListener('wheel', wheel, { passive: true }); el.addEventListener('dblclick', reset)
    return () => {
      el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up); el.removeEventListener('wheel', wheel); el.removeEventListener('dblclick', reset)
    }
  }, [gl])

  useFrame((_, rawDt) => {
    if (!resources) return
    const { aircraft, globe, iss, pad, fx } = resources
    const r = sim.sample(), dt = Math.min(rawDt, 0.1)
    sim.setInput(controls.update(dt))
    if (!r.valid || r.latest[S.SHUTTLE_PHASE] === 0) return
    const s = r.latest, st = state.current, v = scratch, app = useApp.getState(), atm = atmosphere.current
    const site = shuttleSite(s[S.SHUTTLE_SITE]), now = performance.now()
    const phase = s[S.SHUTTLE_PHASE], padHeight = s[S.SHUTTLE_PAD_HEIGHT], climb = s[S.HEIGHT] - padHeight
    // Like an orbital camera's auto-exposure: the sunlit planet fills the frame
    // from orbit, so expose for it rather than for the darker ground-level scene.
    gl.toneMappingExposure = SCENE_EXPOSURE * (1 - 0.55 * MathUtils.smoothstep(s[S.HEIGHT], 40_000, 220_000))
    const respawn = st.gen !== r.generation
    frame.ecefToWorld(r.x, r.y, r.z, v.target)
    if (respawn || v.target.lengthSq() > 9e6) {
      frame.setOrigin(r.x, r.y, r.z)
      st.gen = r.generation
      st.lastSun = -Infinity
    }
    if (respawn) { st.spawnAt = now; st.lastGeoid = -Infinity; st.lastProbe = 0 }
    v.observer.set(r.x, r.y, r.z)
    const advancing = app.phase === 'flying' && !(s[S.FLAGS] & (Flags.PAUSED | Flags.CRASHED))
    const clockChanged = clock.tick(app.settings, s[S.LON], s[S.TIME], advancing ? s[S.TIME_SCALE] : 0)
    if (performance.now() - st.lastSun > 250 || clockChanged) {
      celestial.update(clock.date(app.settings, s[S.LON]), v.observer); st.lastSun = performance.now()
    }
    if (atm) {
      atm.worldToECEFMatrix.copy(frame.ecefFromWorld)
      atm.inertialToECEFMatrix.copy(celestial.inertialToECEF)
      atm.sunDirection.copy(celestial.sunDirection); atm.moonDirection.copy(celestial.moonDirection)
    }
    v.sun.copy(celestial.sunDirection).applyQuaternion(frame.worldFromEcefRot)
    aircraft.setInteriorView(app.camera === 'cockpit' && app.phase === 'flying')
    aircraft.update(r, dt, v.sun)
    frame.upAt(aircraft.position, v.up)
    globe.position.copy(frame.ecefToWorld(0, 0, 0, v.target)); globe.quaternion.copy(frame.worldFromEcefRot)
    resources.cityLights.material.uniforms.sunECEF.value.copy(celestial.sunDirection)
    // Weather on the distant globe only once the streamed scenery has given way to it.
    globe.material.uniforms.cloudAmount.value = MathUtils.smoothstep(s[S.HEIGHT], SCENERY_CEILING, SCENERY_CEILING + 50_000)
    // Keep the coarse global mesh beneath streamed local terrain (including
    // negative ellipsoid heights). Restore its exact physical size in space.
    // Ocean tiles sit ~30 m below the ellipsoid: the globe may only rise to its true
    // size once the streamed scenery is hidden, or the two fight for depth.
    const inset = 1000 * (1 - MathUtils.smoothstep(s[S.HEIGHT], SCENERY_CEILING + 5_000, SCENERY_CEILING + 40_000))
    globe.scale.set(WGS84_A - inset, WGS84_A - inset, WGS84_A * (1 - WGS84_F) - inset)
    const { cityLights } = resources
    cityLights.visible = fx.alwaysRender = s[S.HEIGHT] > SCENERY_CEILING
    cityLights.position.copy(globe.position); cityLights.quaternion.copy(globe.quaternion); cityLights.scale.copy(globe.scale)
    frame.ecefToWorld(r.issX, r.issY, r.issZ, iss.position)
    v.station.set(s[S.ISS_X], s[S.ISS_Y], s[S.ISS_Z])
    // The orbit normal precesses only with the Earth-fixed axes, not with pilot inputs.
    geodeticToEcef(site.lat, site.lon, s[S.SHUTTLE_PAD_HEIGHT] + 21, v.radial).normalize()
    enuBasis(site.lat, site.lon, v.east, v.north, v.padUp)
    const east = Math.cos(51.6 * Math.PI / 180) / Math.sqrt(1 - v.radial.z ** 2)
    v.north.set(0, 0, 1).addScaledVector(v.radial, -v.radial.z).normalize()
    v.normal.copy(v.east).multiplyScalar(east).addScaledVector(v.north, Math.sqrt(1 - east * east))
    v.normal.crossVectors(v.radial, v.normal).applyAxisAngle(v.padUp.set(0, 0, 1), -7.292115e-5 * s[S.MISSION_TIME])
    orientStation(iss, v.station, v.normal)
    iss.quaternion.premultiply(frame.worldFromEcefRot)
    geodeticToEcef(site.lat, site.lon, s[S.SHUTTLE_PAD_HEIGHT] + 1, v.pad)
    frame.ecefToWorld(v.pad.x, v.pad.y, v.pad.z, pad.position)
    enuBasis(site.lat, site.lon, v.east, v.north, v.padUp)
    pad.matrix.makeBasis(v.east, v.padUp, v.north.negate()); pad.quaternion.setFromRotationMatrix(pad.matrix).premultiply(frame.worldFromEcefRot)
    // Hide the far pad's meshes, never its floodlights: a changing light count
    // recompiles every lit material.
    const padNear = climb < 60_000
    if (pad.userData.near !== padNear) {
      pad.userData.near = padNear
      for (const o of pad.children) if (!(o instanceof SpotLight) && o.type !== 'Object3D') o.visible = padNear
    }
    animateLaunchPad(pad, phase >= 2 ? s[S.MISSION_TIME] : -1)
    const padNight = 1 - MathUtils.smoothstep(celestial.sunDirection.dot(v.padUp), -0.08, 0.15)
    for (const light of resources.padLights) light.intensity = 600 * padNight
    const sl = sunLight.current
    if (sl) {
      sl.target.position.copy(aircraft.position); sl.target.updateMatrixWorld()
      // Cover the service structure on the pad; keep the orbiter's own shadows crisp elsewhere.
      const size = phase <= 2 && climb < 300 ? 95 : 42
      if (st.shadowSize !== size) {
        st.shadowSize = size
        Object.assign(sl.shadow.camera, { left: -size, right: size, top: size, bottom: -size })
        sl.shadow.camera.updateProjectionMatrix()
      }
    }
    skyLight.current?.position.copy(aircraft.position)

    // Exhaust, smoke and firelight, anchored to the pad and the real wind.
    geodeticToEcef(site.lat, site.lon, padHeight, v.padEcef)
    enuBasis(site.lat, site.lon, v.padEast, v.padNorth, v.padUpEcef)
    enuBasis(s[S.LAT], s[S.LON], v.e, v.n, v.u)
    v.velocity.copy(v.e).multiplyScalar(s[S.VEL_E]).addScaledVector(v.n, s[S.VEL_N]).addScaledVector(v.u, s[S.VEL_U])
    const windTo = (app.settings.windFromDeg + 180) * Math.PI / 180, wind = app.settings.windSpeedKt * 0.514444
    v.wind.copy(v.padEast).multiplyScalar(Math.sin(windTo) * wind).addScaledVector(v.padNorth, Math.cos(windTo) * wind)
    if (sl) v.sunColor.copy(sl.color).multiplyScalar(sl.intensity * (st.eclipse ? 0 : 1))
    const sh = skyLight.current?.sh.coefficients[0]
    if (sh) v.ambient.setRGB(sh.x, sh.y, sh.z).multiplyScalar(0.886227 * (skyLight.current?.intensity ?? 1))
    fx.update({ s, generation: r.generation, sun: v.sun, sunColor: v.sunColor, ambient: v.ambient, pad: v.padEcef, padUp: v.padUpEcef,
      padEast: v.padEast, padNorth: v.padNorth, velocity: v.velocity, wind: v.wind }, dt)

    const mode = app.phase === 'menu' ? 'free' : app.camera
    if (app.phase !== st.phase) { st.phase = app.phase; st.yaw = -0.1; st.pitch = 0.32; st.zoom = 1 }
    const cam = camera as PerspectiveCamera
    const launching = phase >= 1 && phase <= 3
    const ground = launching ? mode === 'cinematic' && climb < SITE_CAMERA.ceiling ? SITE_CAMERA : mode === 'flyby' && climb < PAD_CAMERA.ceiling ? PAD_CAMERA : null : null
    let fov = st.fov, shakeRange = 0
    if (mode === 'cockpit') {
      camera.position.copy(aircraft.model.eye).applyQuaternion(aircraft.quaternion).add(aircraft.position)
      camera.quaternion.copy(aircraft.quaternion); camera.rotateY(st.lookYaw); camera.rotateX(st.lookPitch)
      camera.up.set(0, 1, 0).applyQuaternion(aircraft.quaternion)
    } else if (ground) {
      // A fixed camera on the ground that pans and zooms to follow the stack.
      const b = ground.bearing * Math.PI / 180
      v.target.copy(v.padEcef).addScaledVector(v.padEast, Math.sin(b) * ground.distance).addScaledVector(v.padNorth, Math.cos(b) * ground.distance)
        .addScaledVector(v.padUpEcef, ground.height)
      frame.ecefToWorld(v.target.x, v.target.y, v.target.z, camera.position)
      camera.up.copy(v.padUpEcef).applyQuaternion(frame.worldFromEcefRot)
      v.target.copy(aircraft.position).addScaledVector(camera.up, climb < 80 ? -6 : 0)
      camera.lookAt(v.target)
      shakeRange = camera.position.distanceTo(aircraft.position)
      const frameSize = ground === PAD_CAMERA ? 120 : 90
      fov = MathUtils.clamp(2 * Math.atan(frameSize / shakeRange) * 180 / Math.PI, ground === PAD_CAMERA ? 8 : 2.5, ground === PAD_CAMERA ? 62 : 32)
    } else {
      v.forward.set(0, 0, -1).applyQuaternion(aircraft.quaternion)
      v.forward.addScaledVector(v.up, -v.forward.dot(v.up)).normalize()
      if (v.forward.lengthSq() < 0.5) v.forward.set(0, 0, -1)
      v.side.crossVectors(v.forward, v.up).normalize()
      if (mode === 'cinematic' && advancing) st.yaw += dt * 0.09
      const dip = Math.acos(WGS84_A / (WGS84_A + Math.max(0, s[S.HEIGHT])))
      // Near the pad, sit lower so the exhaust cloud and the horizon frame the stack.
      const low = launching ? 0.24 * (1 - MathUtils.smoothstep(climb, 1500, 15000)) : 0
      const pitch = MathUtils.clamp(st.pitch + dip * 0.6 - low, -1.3, 1.4)
      const yaw = st.yaw + (mode === 'wing' ? 1.5 : mode === 'flyby' ? 2.4 : 0)
      const dist = (phase < 4 ? 130 : 85) * st.zoom
      camera.position.copy(aircraft.position).addScaledVector(v.forward, -dist * Math.cos(yaw) * Math.cos(pitch))
        .addScaledVector(v.side, dist * Math.sin(yaw) * Math.cos(pitch)).addScaledVector(v.up, dist * Math.sin(pitch))
      if (launching && climb < 400) {
        // Never dip below the pad deck.
        frame.ecefToWorld(v.padEcef.x, v.padEcef.y, v.padEcef.z, v.target)
        v.radial.copy(v.padUpEcef).applyQuaternion(frame.worldFromEcefRot)
        const above = v.side.subVectors(camera.position, v.target).dot(v.radial)
        if (above < 4) camera.position.addScaledVector(v.radial, 4 - above)
      }
      camera.up.copy(v.up); camera.lookAt(aircraft.position)
      shakeRange = dist
    }
    if (Math.abs(cam.fov - fov) > 1e-3) { cam.fov = fov; cam.updateProjectionMatrix() }
    // Engine noise and ground vibration: small rotations scaled to the field of view.
    const shake = fx.shake(s, shakeRange) * (advancing ? 1 : 0)
    if (shake > 0) {
      const t = now / 1000, k = shake * (mode === 'cockpit' ? 0.012 : 0.006) * Math.min(1, fov / 40 + 0.15)
      camera.rotateX(k * (Math.sin(t * 41.3) * 0.6 + Math.sin(t * 67.1 + 1.3) * 0.4))
      camera.rotateY(k * (Math.sin(t * 37.7 + 2.1) * 0.6 + Math.sin(t * 73.9) * 0.4))
      camera.rotateZ(k * 0.5 * Math.sin(t * 29.3 + 0.7))
    }
    camera.updateMatrixWorld()
    const wantScenery = scenery ? s[S.HEIGHT] < SCENERY_CEILING + 20_000 : s[S.HEIGHT] < SCENERY_CEILING
    if (wantScenery !== scenery) setScenery(wantScenery)
    if (world) {
      const localScenery = s[S.HEIGHT] < SCENERY_CEILING
      for (const { tiles } of world.layers) tiles.group.visible = localScenery
      if (localScenery) {
        world.detailScale = 1 + 3 * MathUtils.smoothstep(s[S.HEIGHT], 15_000, 100_000)
        world.update()
        worldStatus.tick(world)
        if (now - st.lastGeoid > 2000) {
          st.lastGeoid = now
          const generation = r.generation
          void sim.query<number>({ type: 'geoid', lat: s[S.LAT], lon: s[S.LON] }).then((g) => {
            if (state.current.gen !== generation) return
            st.geoid = g; world.geoidOffset = g
          }).catch(() => {})
        }
        // Refine the platform and stationary stack against the real ground.
        if (s[S.SHUTTLE_PHASE] === 1 && now - st.lastProbe > 250 && now - st.spawnAt > 1200 && world.rootLoaded) {
          st.lastProbe = now
          const hit = world.probeGround(site.lat, site.lon, 2000, 5000)
          if (hit && hit.error <= 20 && hit.height > st.geoid - 450) {
            const height = app.settings.provider === 'open' ? Math.max(hit.height, st.geoid) : hit.height
            sim.command({ type: 'ground', lat: site.lat, lon: site.lon, height })
          }
        }
      }
    }
    // Earth shadows the vehicle as well as occulting the celestial bodies.
    const along = -v.observer.dot(celestial.sunDirection)
    const closest = v.target.copy(v.observer).addScaledVector(celestial.sunDirection, Math.max(0, along)).length()
    const eclipse = along > 0 && closest < WGS84_A
    st.eclipse = eclipse
    sound.setActive(advancing && !app.pauseMenu && (mode === 'cockpit' || s[S.HEIGHT] < 80_000))
    sound.update(s, mode === 'cockpit', dt)
  }, -1)

  return null
}

export function SpaceScene() {
  const textures = useAtmosphereTextures()
  const atmosphere = useRef<AtmosphereApi>(null)
  const sunLight = useRef<SunDirectionalLight>(null)
  const skyLight = useRef<SkyLightProbe>(null)
  const celestial = useMemo(() => new CelestialState(), [])
  const { scene, camera } = useThree()
  const provider = useApp((s) => s.settings.provider)
  const quality = useApp((s) => s.settings.quality)
  const [fx, setFx] = useState<LaunchEffects | null>(null)
  const fxPass = useMemo(() => fx ? new LaunchFxPass(fx, camera) : null, [fx, camera])
  useEffect(() => () => fxPass?.dispose(), [fxPass])
  const onEffects = useCallback((effects: LaunchEffects | null) => setFx(effects), [])
  const bindLightingMask = useCallback((pass: LightingMaskPass | null) => patchLightingMask(pass), [])
  // Same log-depth position and normal reconstruction as ordinary flights (no banding at range).
  const bindAerial = useCallback((effect: Effect | null) => { if (effect) stabilizeAerialPerspective(effect) }, [])
  useEffect(() => {
    const background = scene.background
    scene.background = new Color('#000000')
    return () => { scene.background = background }
  }, [scene])
  if (!textures) return null
  return <Atmosphere ref={atmosphere} textures={textures} correctAltitude>
    <Suspense fallback={null}><CelestialSky atmosphere={atmosphere} celestial={celestial} /></Suspense>
    <SunLight ref={sunLight} distance={400} />
    <SkyLight ref={skyLight} />
    <SpaceFlight atmosphere={atmosphere} celestial={celestial} sunLight={sunLight} skyLight={skyLight} onEffects={onEffects} />
    <EffectComposer multisampling={0} enableNormalPass={provider !== 'open'}>
      <LightingMask ref={bindLightingMask} selectionLayer={LIGHTING_MASK_LAYER} />
      <EffectGroup>
        <AerialPerspective ref={bindAerial} reconstructNormal={provider === 'open'} sunLight skyLight albedoScale={0.45} />
      </EffectGroup>
      {fxPass ? <primitive object={fxPass} /> : <></>}
      <EffectGroup>
        {/* Only the exhaust and the sun exceed this threshold before exposure. */}
        <Bloom mipmapBlur luminanceThreshold={1.6} luminanceSmoothing={0.5} intensity={0.45} radius={0.6} />
        {/* Ghosts from the sun only: the exhaust is bright, but far below the solar disc. */}
        <LensFlare featuresMaterial-haloAmount={0} thresholdLevel={200} />
        <ToneMapping mode={ToneMappingMode.AGX} />
      </EffectGroup>
      <SMAA preset={quality === 'low' ? SMAAPreset.MEDIUM : SMAAPreset.ULTRA} />
      <Dithering />
    </EffectComposer>
  </Atmosphere>
}
