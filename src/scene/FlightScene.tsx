// Recreate GPU resources after edits: Fast Refresh otherwise retains atmosphere
// textures whose effect cleanup has already disposed them, leaving a black sky.
// @refresh reset
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { EffectComposer, SMAA, ToneMapping } from '@react-three/postprocessing'
import { AerialPerspective, Atmosphere, LightingMask, Sky, SkyLight, Stars, SunLight, type AtmosphereApi } from '@takram/three-atmosphere/r3f'
import { Clouds } from '@takram/three-clouds/r3f'
import type { CloudsEffect } from '@takram/three-clouds'
import { Dithering, LensFlare } from '@takram/three-geospatial-effects/r3f'
import { SMAAPreset, ToneMappingMode } from 'postprocessing'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NoToneMapping, PCFShadowMap, Raycaster, Vector2, Vector3, type PerspectiveCamera } from 'three'
import type { LightingMaskPass, SunDirectionalLight, SkyLightProbe } from '@takram/three-atmosphere'
import type { Points, ShaderMaterial } from 'three'
import { AircraftController, LIGHTING_MASK_LAYER } from '../aircraft/aircraftController'
import { sound } from '../audio/sound'
import { CameraRig, type AircraftPose } from '../camera/cameraRig'
import { weatherCommand } from '../flight'
import { controls } from '../input/controls'
import { Flags, S, type SimCommand } from '../sim/protocol'
import { sim } from '../sim/simClient'
import { useApp, type Quality } from '../state/store'
import { enuBasis, frame } from '../world/frame'
import { WorldSystem } from '../world/worldSystem'
import { worldStatus } from './worldStatus'
import { SkyEnvironment } from './SkyEnvironment'
import { GradeEffect } from './Grade'
import { Ocean } from './Ocean'
import { LakeWater } from './LakeWater'
import { CloudHistory, stabilizeClouds } from './cloudRendering'
import { useAtmosphereTextures } from './useAtmosphereTextures'
import { DestinationMarker } from './DestinationMarker'

const CLOUD_QUALITY: Record<Quality, 'low' | 'medium' | 'high' | 'ultra'> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  ultra: 'ultra',
}

// Refresh every cloud pixel each frame, then temporally antialias. The stock
// 4x4 Bayer reconstruction exposes a grid on moving aircraft/cloud boundaries.
const CLOUD_RESOLUTION: Record<Quality, number> = { low: 0.375, medium: 0.5, high: 0.5, ultra: 0.75 }
const CLOUD_STEP: Record<Quality, number> = { low: 80, medium: 50, high: 25, ultra: 10 }

/** Cloud shadow cascade resolution; 512 leaves visibly blocky shadow edges on the ground. */
const CLOUD_SHADOW_SIZE: Record<Quality, Vector2> = {
  low: new Vector2(256, 256),
  medium: new Vector2(512, 512),
  high: new Vector2(1024, 1024),
  ultra: new Vector2(2048, 2048),
}

/**
 * Device-pixel-ratio cap per quality. Volumetric clouds and aerial perspective
 * are per-pixel ray marches, so rendering a Retina display at full 2x costs
 * roughly 1.8x the GPU time of 1.5x for a barely visible gain.
 */
const MAX_DPR: Record<Quality, number> = { low: 1, medium: 1.25, high: 1.5, ultra: 2 }

/**
 * Date for the atmosphere: real time, or a chosen local solar hour at the aircraft.
 * The fixed hour is evaluated on the March equinox so the slider gives the same
 * sun height in every season and hemisphere (on today's date, a winter
 * mid-afternoon at mid latitudes is already dusk).
 */
function sceneDate(realTime: boolean, hour: number, lon: number) {
  if (realTime) return new Date()
  const utcHours = hour - lon / 15
  return new Date(Date.UTC(new Date().getUTCFullYear(), 2, 20) + utcHours * 3600_000)
}

/**
 * The stock lighting-mask shader decodes depth as if the buffer were linear
 * perspective depth. With the logarithmic depth buffer every sample collapses
 * to nearly the same value, so a masked object counts as visible even when
 * terrain hides it: the sea shell 200 m under Chicago switched off lighting
 * for the ground above it. Log depth is monotonic, so compare it directly.
 */
const LIGHTING_MASK_FRAG = /* glsl */ `
#include <common>
#include <packing>
uniform highp sampler2D depthBuffer0;
uniform highp sampler2D depthBuffer1;
uniform sampler2D inputBuffer;
uniform bool inverted;
varying vec2 vUv;
void main() {
  float scene = unpackRGBAToDepth(texture2D(depthBuffer0, vUv));
  float selected = unpackRGBAToDepth(texture2D(depthBuffer1, vUv));
  bool keep = scene < 1.0 && selected <= scene + 2e-6;
  if (inverted) keep = !keep;
  if (!keep) discard;
  gl_FragColor = texture2D(inputBuffer, vUv);
}`

function patchLightingMask(pass: LightingMaskPass | null) {
  const material = (pass as unknown as { depthMaskMaterial?: ShaderMaterial } | null)?.depthMaskMaterial
  if (!material || material.fragmentShader === LIGHTING_MASK_FRAG) return
  material.fragmentShader = LIGHTING_MASK_FRAG
  material.needsUpdate = true
}

const _sun = new Vector3()
const _probe = new Vector3()
const _dir = new Vector3()
const _vel = new Vector3()
const _e = new Vector3()
const _n = new Vector3()
const _u = new Vector3()
const _we = new Vector3()
const _wn = new Vector3()
const _wu = new Vector3()
const _wind = new Vector3()

function useWorld(): WorldSystem | null {
  const { gl, camera, scene } = useThree()
  const provider = useApp((s) => s.settings.provider)
  const googleApiKey = useApp((s) => s.settings.googleApiKey)
  const cesiumToken = useApp((s) => s.settings.cesiumToken)
  const cesiumMode = useApp((s) => s.settings.cesiumMode)
  const openImagery = useApp((s) => s.settings.openImagery)
  const quality = useApp((s) => s.settings.quality)
  const [world, setWorld] = useState<WorldSystem | null>(null)
  useEffect(() => {
    const settings = useApp.getState().settings
    const w = new WorldSystem(settings, gl, camera as PerspectiveCamera, scene)
    setWorld(w)
    worldStatus.set({ world: w })
    return () => {
      worldStatus.set({ world: null })
      w.dispose()
    }
  }, [gl, camera, scene, provider, googleApiKey, cesiumToken, cesiumMode, openImagery, quality])
  return world
}

function useAircraft(): AircraftController | null {
  const { gl, scene } = useThree()
  const aircraftId = useApp((s) => s.aircraftId)
  const [ac, setAc] = useState<AircraftController | null>(null)
  useEffect(() => {
    const a = new AircraftController(aircraftId, gl)
    a.attachShadow(scene)
    setAc(a)
    return () => {
      a.detachShadow(scene)
      a.dispose()
    }
  }, [aircraftId, gl, scene])
  return ac
}

interface LoopProps {
  world: WorldSystem
  aircraft: AircraftController
  atmosphere: React.RefObject<AtmosphereApi | null>
  sunLight: React.RefObject<SunDirectionalLight | null>
  skyLight: React.RefObject<SkyLightProbe | null>
  ocean: Ocean | null
  lakes: LakeWater | null
  stars: React.RefObject<Points | null>
  clouds: React.RefObject<CloudsEffect | null>
}

function FlightLoop({ world, aircraft, atmosphere, sunLight, skyLight, ocean, lakes, stars, clouds }: LoopProps) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera
  const gl = useThree((s) => s.gl)
  const rig = useMemo(() => new CameraRig(camera), [camera])
  const state = useRef({ gen: -1, spawnAt: 0, lastProbe: 0, lastCollision: 0, geoid: 0, lastGeoid: 0, groundSamples: 0, lastSun: -1e9, phase: '' as string })
  // Reused every frame (no per-frame allocation).
  const pose = useMemo<AircraftPose>(
    () => ({
      position: aircraft.position,
      quaternion: aircraft.quaternion,
      velocity: new Vector3(),
      length: aircraft.model.length,
      span: aircraft.model.span,
      eye: aircraft.model.eye,
      wingTip: aircraft.model.wingTipRight,
      specificForce: new Vector3(0, 1, 0),
      heightAboveGround: 0,
      onGround: true,
      groundSpeed: 0,
    }),
    [aircraft],
  )

  // Mouse: drag to orbit / look, wheel to zoom, double-click to reset.
  useEffect(() => {
    const el = gl.domElement
    let drag = false
    let lx = 0
    let ly = 0
    let travel = 0
    const picker = new Raycaster()
    picker.far = 3
    const pointer = new Vector2()
    const cockpitHit = (e: PointerEvent) => {
      const app = useApp.getState()
      if (app.camera !== 'cockpit' || app.phase !== 'flying' || app.pauseMenu || app.routeOpen || app.skipToOpen || app.helpOverlay || app.crashed) return
      const rect = el.getBoundingClientRect()
      pointer.set((e.clientX - rect.left) / rect.width * 2 - 1, 1 - (e.clientY - rect.top) / rect.height * 2)
      picker.setFromCamera(pointer, camera)
      // Intersect the entire interior so a panel or yoke cannot be clicked through.
      return picker.intersectObject(aircraft.cockpit.root, true)[0]?.object
    }
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return
      drag = true
      travel = 0
      lx = e.clientX
      ly = e.clientY
      el.setPointerCapture(e.pointerId)
    }
    const move = (e: PointerEvent) => {
      if (!drag) {
        const hit = cockpitHit(e)
        el.style.cursor = hit?.userData.cockpitCommand ? 'pointer' : ''
        el.title = hit?.userData.cockpitLabel ?? ''
        return
      }
      travel += Math.hypot(e.clientX - lx, e.clientY - ly)
      rig.drag(e.clientX - lx, e.clientY - ly)
      lx = e.clientX
      ly = e.clientY
    }
    const up = (e: PointerEvent) => {
      const clicked = drag && travel < 5 && e.button === 0
      drag = false
      rig.endDrag()
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
      if (clicked) {
        const hit = cockpitHit(e)
        const command = (e.shiftKey ? hit?.userData.cockpitShiftCommand ?? hit?.userData.cockpitCommand : hit?.userData.cockpitCommand) as SimCommand | undefined
        if (command) sim.command(command)
      }
    }
    const cancel = () => { drag = false; rig.endDrag(); el.style.cursor = ''; el.title = '' }
    const wheel = (e: WheelEvent) => rig.wheel(e.deltaY)
    const dbl = () => rig.resetView()
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', cancel)
    el.addEventListener('pointerleave', cancel)
    el.addEventListener('wheel', wheel, { passive: true })
    el.addEventListener('dblclick', dbl)
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', cancel)
      el.removeEventListener('pointerleave', cancel)
      el.style.cursor = ''; el.title = ''
      el.removeEventListener('wheel', wheel)
      el.removeEventListener('dblclick', dbl)
    }
  }, [gl, rig, aircraft, camera])

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1)
    const st = state.current
    const r = sim.sample()
    sim.setInput(controls.update(dt))
    if (!r.valid) return
    const s = r.latest
    const now = performance.now()

    // Floating origin: re-anchor on spawn or when the aircraft strays > 3 km.
    if (r.generation !== st.gen) {
      st.gen = r.generation
      st.spawnAt = now
      st.groundSamples = 0
      frame.setOrigin(r.x, r.y, r.z)
      rig.snap()
    } else {
      frame.ecefToWorld(r.x, r.y, r.z, _probe)
      if (_probe.lengthSq() > 3000 * 3000) frame.setOrigin(r.x, r.y, r.z)
    }

    // Atmosphere / sun. The sun barely moves, so the ephemeris runs at 4 Hz.
    const atm = atmosphere.current
    const settings = useApp.getState().settings
    let sunWorld: Vector3 | null = null
    if (atm) {
      if (now - st.lastSun > 250) {
        st.lastSun = now
        atm.updateByDate(sceneDate(settings.realTime, settings.timeOfDay, s[S.LON]))
      }
      atm.worldToECEFMatrix.copy(frame.ecefFromWorld)
      sunWorld = _sun.copy(atm.sunDirection).applyQuaternion(frame.worldFromEcefRot)
      // Stars only once the sun is well below the horizon.
      if (stars.current) stars.current.visible = sunWorld.dot(frame.upAt(aircraft.position, _u)) < -0.08
    }

    // Aircraft and lights.
    const app = useApp.getState()
    // Behind the menu, slowly orbit the parked aircraft as a live preview.
    const mode = app.phase === 'menu' ? 'free' : app.camera
    if (app.phase === 'menu') rig.yaw += dt * 0.05
    // Entering the flight: start from the default view behind the aircraft.
    if (app.phase !== st.phase) {
      if (app.phase === 'flying') rig.resetView()
      st.phase = app.phase
    }
    aircraft.setInteriorView(mode === 'cockpit')
    aircraft.update(r, dt, sunWorld)
    const sl = sunLight.current
    if (sl) {
      sl.target.position.copy(aircraft.position)
      sl.target.updateMatrixWorld()
    }
    skyLight.current?.position.copy(aircraft.position)

    // Camera.
    rig.setMode(mode)
    if (controls.look.x || controls.look.y) rig.drag(controls.look.x * 600 * dt, controls.look.y * 600 * dt)
    frame.enuInWorld(s[S.LAT], s[S.LON], _e, _n, _u)
    _vel.set(0, 0, 0).addScaledVector(_e, s[S.VEL_E]).addScaledVector(_n, s[S.VEL_N]).addScaledVector(_u, s[S.VEL_U])
    const flags = s[S.FLAGS] | 0
    const awaiting = (flags & Flags.AWAITING_GROUND) !== 0
    const onGround = (flags & Flags.ON_GROUND) !== 0
    pose.velocity.copy(_vel)
    // Body (x fwd, y right, z up) -> model axes (x right, y up, z back).
    pose.specificForce.set(s[S.NY], s[S.NZ], -s[S.NX])
    pose.heightAboveGround = Math.max(0, s[S.HEIGHT] - s[S.GROUND_HEIGHT])
    pose.onGround = onGround
    pose.groundSpeed = s[S.GS_KT] * 0.514444
    rig.update(pose, dt)

    // Sound follows the newest state; muted in menus and while paused.
    sound.setActive(app.phase === 'flying' && !app.pauseMenu && (flags & Flags.PAUSED) === 0 && !awaiting)
    sound.update(s, mode === 'cockpit', dt)

    // Cloud shapes drift with the wind (texture offsets are in ECEF metres x repeat).
    const cl = clouds.current
    if (cl) {
      enuBasis(s[S.LAT], s[S.LON], _we, _wn, _wu)
      _wind.set(0, 0, 0).addScaledVector(_we, s[S.WIND_E]).addScaledVector(_wn, s[S.WIND_N])
      cl.shapeVelocity.copy(_wind).multiplyScalar(-cl.shapeRepeat.x)
      cl.shapeDetailVelocity.copy(_wind).multiplyScalar(-cl.shapeDetailRepeat.x)
    }

    if (ocean) {
      ocean.update(camera.position, st.geoid, now / 1000)
      // Don't flood the view with water before the terrain around us has streamed in.
      // ...and not at all well inland, where the sea shell sits far below the terrain.
      const nearSeaLevel = s[S.GROUND_HEIGHT] - st.geoid < 80
      ocean.mesh.visible = nearSeaLevel && (st.groundSamples > 0 || world.loadProgress > 0.95)
    }
    lakes?.update(s[S.LAT], s[S.LON], now / 1000)

    // Stream tiles for the new camera pose. Detail follows how fast the ground
    // moves across the view (rad/s), eased so tiles are not re-requested every frame.
    const sweep = pose.groundSpeed / (pose.heightAboveGround + 150)
    const detail = Math.min(4, 1 + sweep * 2.5)
    world.detailScale += (detail - world.detailScale) * Math.min(1, dt * 0.5)
    world.setFlightPath(aircraft.position, _vel, _u, pose.heightAboveGround, app.phase === 'flying' && !awaiting)
    world.update()
    worldStatus.tick(world)

    // Geoid (for "water is never below sea level" in open-data terrain).
    if (now - st.lastGeoid > 2000) {
      st.lastGeoid = now
      sim.query<number>({ type: 'geoid', lat: s[S.LAT], lon: s[S.LON] }).then((g) => {
        st.geoid = g
        world.geoidOffset = g
      })
    }

    // Ground height probe (10 Hz). While waiting to place the aircraft, wait
    // for the scenery around it to finish refining so we sample the real surface.
    if (now - st.lastProbe > 100) {
      const settled = world.rootLoaded && (world.loadProgress > 0.98 || now - st.spawnAt > 9000) && now - st.spawnAt > 1200
      if (!awaiting || settled) {
        st.lastProbe = now
        const h = s[S.HEIGHT]
        let hit = awaiting ? null : world.probeGround(s[S.LAT], s[S.LON], h + 60, 3000)
        if (hit === null) hit = world.probeGround(s[S.LAT], s[S.LON], Math.max(h + 3000, 9500), 20000)
        // Only trust tiles whose geometric error is small relative to our height above them.
        const aglM = Math.max(0, s[S.AGL_FT] * 0.3048)
        if (hit !== null && hit.error <= Math.max(20, aglM * 0.08) && hit.height > st.geoid - 450) {
          let g = hit.height
          if (settings.provider === 'open') g = Math.max(g, st.geoid)
          st.groundSamples++
          sim.command({ type: 'ground', lat: s[S.LAT], lon: s[S.LON], height: g })
        }
      }
    }

    // Forward collision ray against buildings / steep terrain (30 Hz).
    const speed = _vel.length()
    if (!awaiting && !onGround && speed > 25 && now - st.spawnAt > 4000 && now - st.lastCollision > 33) {
      st.lastCollision = now
      _dir.copy(_vel).normalize()
      const len = speed * 0.1 + aircraft.model.length * 0.55
      const hit = world.probeSegment(aircraft.position, _dir, len)
      if (hit !== null) {
        const n = world.lastHitNormal
        // Ignore near-horizontal surfaces (ground contact is handled by the sim).
        if (n && Math.abs(n.dot(_u)) < 0.75) sim.command({ type: 'collision', what: 'scenery' })
      }
    }
  }, -1)

  return null
}

function SceneContents() {
  const atmosphereTextures = useAtmosphereTextures()
  const world = useWorld()
  const aircraft = useAircraft()
  const atmosphere = useRef<AtmosphereApi>(null)
  const sunLight = useRef<SunDirectionalLight>(null)
  const skyLight = useRef<SkyLightProbe>(null)
  const stars = useRef<Points>(null)
  const cloudsRef = useRef<CloudsEffect>(null)
  const quality = useApp((s) => s.settings.quality)
  const clouds = useApp((s) => s.settings.clouds)
  const coverage = useApp((s) => s.settings.cloudCoverage)
  const shadows = useApp((s) => s.settings.shadows)
  const provider = useApp((s) => s.settings.provider)
  const camera = useThree((s) => s.camera)
  const scene = useThree((s) => s.scene)
  const [ocean, setOcean] = useState<Ocean | null>(null)
  const [lakes, setLakes] = useState<LakeWater | null>(null)
  const grade = useMemo(() => new GradeEffect(), [])
  const cloudHistory = useMemo(() => new CloudHistory(), [])
  const bindClouds = useCallback((effect: CloudsEffect | null) => {
    if (effect) stabilizeClouds(effect)
    cloudsRef.current = effect
  }, [])

  // FlightLoop runs at -1; the effect composer runs at +1. Invalidate history
  // after the camera has moved but before rendering the new cloud image.
  useFrame(() => {
    const effect = cloudsRef.current
    if (!effect) return
    // R3F applies the library's resolution default before its quality setter,
    // which also resets it to 1. Enforce the budget after those props settle,
    // including when the asynchronously loaded effect first mounts.
    if (effect.resolutionScale !== CLOUD_RESOLUTION[quality]) effect.resolutionScale = CLOUD_RESOLUTION[quality]
    effect.clouds.minStepSize = CLOUD_STEP[quality]
    cloudHistory.update(effect, camera, frame.version, useApp.getState().camera, quality)
  })

  useEffect(() => {
    camera.layers.enable(LIGHTING_MASK_LAYER)
  }, [camera])

  // Live weather and sound settings.
  const windFromDeg = useApp((s) => s.settings.windFromDeg)
  const windSpeedKt = useApp((s) => s.settings.windSpeedKt)
  const turbulence = useApp((s) => s.settings.turbulence)
  const volume = useApp((s) => s.settings.volume)
  const callouts = useApp((s) => s.settings.callouts)
  useEffect(() => {
    sim.command(weatherCommand(useApp.getState().settings))
  }, [windFromDeg, windSpeedKt, turbulence])
  useEffect(() => sound.configure(volume, callouts), [volume, callouts])

  useEffect(() => {
    const water = new LakeWater(LIGHTING_MASK_LAYER)
    scene.add(water.root)
    setLakes(water)
    return () => {
      scene.remove(water.root)
      water.dispose()
      setLakes(null)
    }
  }, [scene])

  // Photogrammetry and Cesium terrain carry their own sea surface; raster DEM terrain needs one.
  useEffect(() => {
    if (provider !== 'open') return
    const o = new Ocean(LIGHTING_MASK_LAYER)
    scene.add(o.mesh)
    setOcean(o)
    return () => {
      scene.remove(o.mesh)
      o.dispose()
      setOcean(null)
    }
  }, [provider, scene])

  useEffect(() => {
    const l = sunLight.current
    if (!l || !aircraft) return
    const r = Math.max(aircraft.model.span, aircraft.model.length) * 0.7
    l.castShadow = shadows
    l.shadow.mapSize.set(2048, 2048)
    l.shadow.camera.left = -r
    l.shadow.camera.right = r
    l.shadow.camera.top = r
    l.shadow.camera.bottom = -r
    l.shadow.camera.near = 1
    l.shadow.camera.far = 800
    l.shadow.bias = -0.0004
    l.shadow.normalBias = 0.02
    l.shadow.camera.updateProjectionMatrix()
  }, [aircraft, shadows, atmosphereTextures])

  if (!atmosphereTextures) return null

  return (
    <Atmosphere ref={atmosphere} textures={atmosphereTextures} correctAltitude>
      <Sky />
      <Stars ref={stars} data={`${import.meta.env.BASE_URL}atmosphere/stars.bin`} background />
      {aircraft ? <primitive object={aircraft.container} /> : null}
      <SunLight ref={sunLight} distance={400} />
      <SkyLight ref={skyLight} />
      <SkyEnvironment atmosphere={atmosphere} />
      {world && aircraft ? (
        <FlightLoop world={world} aircraft={aircraft} atmosphere={atmosphere} sunLight={sunLight} skyLight={skyLight} ocean={ocean} lakes={lakes} stars={stars} clouds={cloudsRef} />
      ) : null}
      <EffectComposer multisampling={0} enableNormalPass>
        {clouds ? (
          <Clouds
            ref={bindClouds}
            qualityPreset={CLOUD_QUALITY[quality]}
            temporalUpscale={false}
            coverage={coverage}
            // The camera sees to the horizon and beyond; without a cap the shadow cascades
            // are stretched over that whole range and cloud shadows smear into one sheet.
            shadow-maxFar={6e4}
            shadow-mapSize={CLOUD_SHADOW_SIZE[quality]}
            localWeatherTexture={`${import.meta.env.BASE_URL}clouds/local_weather.png`}
            shapeTexture={`${import.meta.env.BASE_URL}clouds/shape.bin`}
            shapeDetailTexture={`${import.meta.env.BASE_URL}clouds/shape_detail.bin`}
            turbulenceTexture={`${import.meta.env.BASE_URL}clouds/turbulence.png`}
            stbnTexture={`${import.meta.env.BASE_URL}clouds/stbn.bin`}
          />
        ) : (
          <></>
        )}
        <LightingMask ref={patchLightingMask} selectionLayer={LIGHTING_MASK_LAYER} />
        {/* Satellite imagery already has daylight baked in; treating it as raw albedo blows the ground out. */}
        <AerialPerspective sunLight skyLight albedoScale={0.45} stbnTexture={`${import.meta.env.BASE_URL}clouds/stbn.bin`} />
        <LensFlare />
        <ToneMapping mode={ToneMappingMode.AGX} />
        <primitive object={grade} />
        <SMAA preset={quality === 'low' ? SMAAPreset.MEDIUM : SMAAPreset.ULTRA} />
        <Dithering />
      </EffectComposer>
    </Atmosphere>
  )
}

export default function FlightScene() {
  const renderScale = useApp((s) => s.settings.renderScale)
  const shadows = useApp((s) => s.settings.shadows)
  const quality = useApp((s) => s.settings.quality)
  const dpr = Math.min(MAX_DPR[quality], typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) * renderScale
  return (
    <Canvas
      className="flight-canvas"
      dpr={dpr}
      shadows={shadows ? { type: PCFShadowMap } : false}
      gl={{ logarithmicDepthBuffer: true, antialias: false, powerPreference: 'high-performance', depth: true, stencil: false, toneMapping: NoToneMapping, toneMappingExposure: 10 }}
      camera={{ fov: 58, near: 0.3, far: 2e7 }}
      onCreated={({ gl }) => {
        gl.setClearColor('#000000')
      }}
    >
      <SceneContents />
      <DestinationMarker />
    </Canvas>
  )
}

