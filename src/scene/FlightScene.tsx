// Recreate GPU resources after edits: Fast Refresh otherwise retains atmosphere
// textures whose effect cleanup has already disposed them, leaving a black sky.
// @refresh reset
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { EffectComposer, EffectGroup, SMAA, ToneMapping } from '@react-three/postprocessing'
import { AerialPerspective, Atmosphere, AtmosphereContext, LightingMask, SkyLight, SunLight, type AtmosphereApi } from '@takram/three-atmosphere/r3f'
import { Clouds } from '@takram/three-clouds/r3f'
import type { CloudsEffect } from '@takram/three-clouds'
import { Dithering, LensFlare } from '@takram/three-geospatial-effects/r3f'
import { SMAAPreset, ToneMappingMode, type Effect } from 'postprocessing'
import { Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MathUtils, NoToneMapping, PCFShadowMap, Raycaster, Vector2, Vector3, type DirectionalLight, type HemisphereLight, type PerspectiveCamera } from 'three'
import type { LightingMaskPass, SunDirectionalLight, SkyLightProbe } from '@takram/three-atmosphere'
import type { ShaderMaterial } from 'three'
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
import { CloudHistory, setCloudNightLighting, stabilizeAerialPerspective, stabilizeClouds, stabilizeNightClouds } from './cloudRendering'
import { VolumetricCloudPass } from './VolumetricCloudPass'
import { bindCloudGroundLighting } from './cloudGroundLighting'
import { WaterMask } from './WaterMask'
import { NightEffect } from './NightEffect'
import { useAtmosphereTextures } from './useAtmosphereTextures'
import { DestinationMarker } from './DestinationMarker'
import { PrecipitationEffect } from './Precipitation'
import { LandingGuide } from './LandingGuide'
import { OverlayPass } from './OverlayPass'
import { CelestialSky } from './CelestialSky'
import { CelestialState, sceneDate } from './celestial'
import { CLEAR_HAZE, pollWeather, useWeather, visualTargets, type Conditions } from '../weather/liveWeather'
import { CUMULUS, cloudProfileForWeather } from '../weather/cloudProfiles'
import { destinationPoint } from '../navigation/route'

const CLOUD_QUALITY: Record<Quality, 'low' | 'medium' | 'high' | 'ultra'> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  ultra: 'ultra',
}

// Keep the original cloud image size and march steps. The depth-aware resolve
// in cloudRendering.ts refreshes one of four samples per pixel block each frame.
const CLOUD_RESOLUTION: Record<Quality, number> = { low: 0.33, medium: 0.42, high: 0.5, ultra: 0.65 }
const CLOUD_STEP: Record<Quality, number> = { low: 100, medium: 60, high: 40, ultra: 20 }

/**
 * Cloud shadow cascade resolution; 512 leaves visibly blocky shadow edges on the
 * ground. Three cascades are ray marched every frame, so the texel count costs as
 * much as the clouds themselves: 2048 squared was 12.6 million marches a frame.
 */
const CLOUD_SHADOW_SIZE: Record<Quality, Vector2> = {
  low: new Vector2(256, 256),
  medium: new Vector2(512, 512),
  high: new Vector2(768, 768),
  ultra: new Vector2(1280, 1280),
}

/** Render-resolution steps that adaptive resolution moves between when frames run long. */
const ADAPTIVE_STEPS = [1, 0.85, 0.72, 0.6]
/** Distances ahead (m) sampled for the autopilot's terrain awareness. */
const TERRAIN_AHEAD_M = [1000, 2000, 3500, 5000, 7500, 10000]

/**
 * Device-pixel-ratio cap per quality. Volumetric clouds and aerial perspective
 * are per-pixel ray marches, so rendering a Retina display at full 2x costs
 * roughly 1.8x the GPU time of 1.5x for a barely visible gain.
 */
const MAX_DPR: Record<Quality, number> = { low: 1, medium: 1.25, high: 1.5, ultra: 2 }

/**
 * The stock lighting-mask shader decodes depth as if the buffer were linear
 * perspective depth. With the logarithmic depth buffer every sample collapses
 * to nearly the same value, so a masked object counts as visible even when
 * terrain hides it. Require a match with the visible depth, since the opaque
 * override can also draw windows and other surfaces that never wrote scene depth.
 */
const LIGHTING_MASK_FRAG = /* glsl */ `
#include <common>
#include <packing>
uniform highp sampler2D depthBuffer0;
uniform highp sampler2D depthBuffer1;
uniform bool inverted;
varying vec2 vUv;
void main() {
  float scene = unpackRGBAToDepth(texture2D(depthBuffer0, vUv));
  float selected = unpackRGBAToDepth(texture2D(depthBuffer1, vUv));
  bool keep = scene < 1.0 && selected < 1.0 && abs(selected - scene) <= 2e-7;
  if (inverted) keep = !keep;
  if (!keep) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
}`

function patchLightingMask(pass: LightingMaskPass | null) {
  const material = (pass as unknown as { depthMaskMaterial?: ShaderMaterial } | null)?.depthMaskMaterial
  if (!material || material.fragmentShader === LIGHTING_MASK_FRAG) return
  material.fragmentShader = LIGHTING_MASK_FRAG
  material.needsUpdate = true
}

const _sun = new Vector3()
const _moon = new Vector3()
const _observer = new Vector3()
const _eyeUp = new Vector3()
/** Scene-radiance units (the sun is ~1): enough to read the aircraft's shape, no more. */
const NIGHT_FILL = 0.075
const MOON_LIGHT = 0.16
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
const _air = new Vector3()
const _eye = new Vector3()
const CUSTOM_CLOUDS = new URLSearchParams(window.location.search).get('clouds') !== 'legacy'

function CustomCloudOverlay({ pass }: { pass: VolumetricCloudPass }) {
  const { transientStates } = useContext(AtmosphereContext)
  useLayoutEffect(() => {
    if (!transientStates) return
    transientStates.overlay = pass.overlay
    return () => { transientStates.overlay = null }
  }, [pass, transientStates])
  return <primitive object={pass} />
}

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
  celestial: CelestialState
  clouds: React.RefObject<CloudsEffect | null>
  customClouds: VolumetricCloudPass | null
  precipitation: PrecipitationEffect
  night: NightEffect
  nightFill: React.RefObject<HemisphereLight | null>
  moonLight: React.RefObject<DirectionalLight | null>
  /** Fraction of direct sunlight reaching the aircraft through the cloud deck. */
  sunThrough: React.RefObject<number>
}

function FlightLoop({ world, aircraft, atmosphere, sunLight, skyLight, ocean, lakes, celestial, clouds, customClouds, precipitation, night, nightFill, moonLight, sunThrough }: LoopProps) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera
  const gl = useThree((s) => s.gl)
  const rig = useMemo(() => new CameraRig(camera), [camera])
  const state = useRef({ gen: -1, spawnAt: 0, lastProbe: 0, lastCollision: 0, lastTerrain: 0, geoid: 0, lastGeoid: 0, groundSamples: 0, lastSun: -1e9, realTime: false, timeOfDay: -1, phase: '' as string, dark: 0, moon: 0 })
  // Live weather as currently drawn; eased towards each new report.
  const weather = useRef({
    lastPoll: -1e9,
    report: null as Conditions | null,
    target: null as ReturnType<typeof visualTargets> | null,
    profile: CUMULUS,
    effect: null as CloudsEffect | VolumetricCloudPass | null,
    coverage: 0,
    haze: CLEAR_HAZE,
    precip: 0,
    snow: 0,
    // Camera motion through the air, measured from the camera itself so every view is right.
    eye: new Vector3(),
    eyeVelocity: new Vector3(),
    eyeOrigin: -1,
  })
  useEffect(() => {
    rig.cockpitLookPitch = aircraft.model.cockpitLookPitch ?? -0.2
  }, [rig, aircraft])
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
      st.lastSun = -Infinity
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
      if (now - st.lastSun > 250 || settings.realTime !== st.realTime || (!settings.realTime && settings.timeOfDay !== st.timeOfDay)) {
        st.lastSun = now
        st.realTime = settings.realTime
        st.timeOfDay = settings.timeOfDay
        celestial.update(sceneDate(settings.realTime, settings.timeOfDay, s[S.LON]), _observer.set(r.x, r.y, r.z))
        atm.inertialToECEFMatrix.copy(celestial.inertialToECEF)
        atm.sunDirection.copy(celestial.sunDirection)
        atm.moonDirection.copy(celestial.moonDirection)
      }
      atm.worldToECEFMatrix.copy(frame.ecefFromWorld)
      sunWorld = _sun.copy(atm.sunDirection).applyQuaternion(frame.worldFromEcefRot)
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

    // Night: moonlight and airglow on the aircraft (the terrain gets its share in NightEffect).
    {
      const up = frame.upAt(aircraft.position, _u)
      const dark = sunWorld ? Math.min(1, Math.max(0, (-sunWorld.dot(up) - 0.02) / 0.16)) : 0
      let moon = 0
      if (atm && dark > 0) {
        _moon.copy(atm.moonDirection).applyQuaternion(frame.worldFromEcefRot)
        const phase = celestial.illuminatedFraction
        moon = Math.min(1, Math.max(0, _moon.dot(up) * 4)) * phase
      }
      const fill = nightFill.current
      if (fill) {
        fill.position.copy(up)
        fill.intensity = dark * NIGHT_FILL
      }
      const ml = moonLight.current
      if (ml) {
        ml.position.copy(aircraft.position).addScaledVector(_moon, 400)
        ml.target.position.copy(aircraft.position)
        ml.target.updateMatrixWorld()
        ml.intensity = dark * moon * MOON_LIGHT
      }
      st.dark = dark
      st.moon = moon
    }
    const sl = sunLight.current
    if (sl) {
      sl.target.position.copy(aircraft.position)
      sl.target.updateMatrixWorld()
      // Nothing casts a sun shadow at night: stop redrawing the aircraft into the map.
      // (Toggling castShadow instead would recompile every lit material.)
      sl.shadow.autoUpdate = st.dark < 0.98
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

    // Live weather: fetch for where we are, then ease the sky towards the report.
    const wx = weather.current
    if (now - wx.lastPoll > 2000) {
      wx.lastPoll = now
      pollWeather(settings.liveWeather, settings.googleApiKey, s[S.LAT], s[S.LON])
    }
    const report = settings.liveWeather ? useWeather.getState().conditions : null
    if (report !== wx.report) {
      wx.report = report
      wx.target = report ? visualTargets(report) : null
      wx.profile = report ? cloudProfileForWeather(report) : CUMULUS
    }
    const target = wx.target
    const cl = clouds.current
    const cloudEffect = cl ?? customClouds
    // Snap when there is nothing to ease from: manual settings, or a freshly mounted effect.
    const snap = !target || (cloudEffect !== null && cloudEffect !== wx.effect)
    wx.effect = cloudEffect
    const ease = snap ? 1 : 1 - Math.exp(-dt / 10)
    wx.coverage += ((target ? target.coverage : settings.cloudCoverage) - wx.coverage) * ease
    wx.haze += ((target ? target.haze : CLEAR_HAZE) - wx.haze) * ease
    // Start tapering precipitation lower in the cloud and stop above the deck.
    const rainBase = customClouds ? MathUtils.lerp(customClouds.base, customClouds.top, 0.24) : 1300
    const rainDepth = customClouds ? customClouds.top - rainBase : 700
    const below = MathUtils.clamp(1 - (s[S.HEIGHT] - rainBase) / rainDepth, 0, 1)
    wx.precip += ((target ? target.precip * below : 0) - wx.precip) * Math.min(1, dt / 3)
    if (target && target.precip > 0) wx.snow = target.snow
    _air.set(0, 0, 0).addScaledVector(_e, s[S.WIND_E]).addScaledVector(_n, s[S.WIND_N]).addScaledVector(_u, s[S.WIND_U])
    const daylight = sunWorld ? Math.min(1, Math.max(0.1, 0.25 + sunWorld.dot(_u) * 4)) : 1
    // Skip the frame of a floating-origin rebase or a camera cut, where the position jumps.
    if (wx.eyeOrigin === frame.version && rawDt > 1e-4) {
      _eye.subVectors(camera.position, wx.eye).divideScalar(rawDt)
      if (_eye.lengthSq() < 600 * 600) wx.eyeVelocity.lerp(_eye, Math.min(1, dt * 8))
    }
    wx.eye.copy(camera.position)
    wx.eyeOrigin = frame.version
    const eyeHeight = s[S.HEIGHT] - st.geoid + _probe.copy(camera.position).sub(aircraft.position).dot(_u)
    night.setFrame(camera, st.dark, st.moon, frame.upAt(camera.position, _eyeUp), aircraft.lamps, eyeHeight)
    precipitation.setFrame(camera, dt, wx.precip, wx.snow, _air, wx.eyeVelocity, _u, daylight * (1 - 0.3 * wx.coverage), gl.domElement.height)

    // Cloud shapes drift with the wind (texture offsets are in ECEF metres x repeat).
    if (cl) {
      cl.coverage = wx.coverage
      cl.clouds.hazeDensityScale = wx.haze
      setCloudNightLighting(cl, st.dark, celestial.moonDirection, celestial.illuminatedFraction)
      enuBasis(s[S.LAT], s[S.LON], _we, _wn, _wu)
      _wind.set(0, 0, 0).addScaledVector(_we, s[S.WIND_E]).addScaledVector(_wn, s[S.WIND_N])
      cl.shapeVelocity.copy(_wind).multiplyScalar(-cl.shapeRepeat.x)
      cl.shapeDetailVelocity.copy(_wind).multiplyScalar(-cl.shapeDetailRepeat.x)
    }
    if (customClouds) {
      const bearing = MathUtils.degToRad(report?.windFromDeg ?? settings.windFromDeg)
      const speed = 0.514444 * (report ? Math.min(60, report.windKt) : settings.windSpeedKt)
      enuBasis(s[S.LAT], s[S.LON], _we, _wn, _wu)
      _wind.copy(_we).multiplyScalar(-speed * Math.sin(bearing)).addScaledVector(_wn, -speed * Math.cos(bearing))
      customClouds.setWeather(Math.min(rawDt, 0.25), {
        coverage: wx.coverage, haze: wx.haze, wind: _wind, sun: celestial.sunDirection,
        moon: celestial.moonDirection, moonPhase: celestial.illuminatedFraction,
        shadows: settings.shadows, profile: wx.profile,
      })
    }

    // Direct sun on the aircraft through the shadow-casting cloud decks above it. The
    // terrain is shaded by the cloud shadow map in the post-process lighting, but the
    // aircraft's own sun light knew nothing of clouds: under an overcast it glowed white
    // over dim, shadowed ground.
    let through = 1
    const opacity = MathUtils.smoothstep(wx.coverage, 0.25, 0.8)
    if (cl) {
      for (const layer of cl.cloudLayers) {
        if (!layer.shadow || layer.height <= 0) continue
        const above = MathUtils.clamp((layer.altitude + layer.height - s[S.HEIGHT]) / layer.height, 0, 1)
        through *= 1 - 0.85 * opacity * Math.min(1, layer.densityScale * 5) * above
      }
    } else if (customClouds) {
      const above = MathUtils.clamp((customClouds.top - s[S.HEIGHT]) / (customClouds.top - customClouds.base), 0, 1)
      through = 1 - 0.70 * opacity * above
    }
    sunThrough.current += (through - sunThrough.current) * Math.min(1, dt * 1.5)

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
    const airport = app.spawn.kind === 'runway' ? app.spawn.airport : null
    world.updateRunways(s[S.LAT], s[S.LON], pose.heightAboveGround, airport)
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

    // Terrain awareness for the autopilot (2 Hz while it flies): the highest
    // surface or structure along the ground track out to ~10 km. Coarse tiles
    // are fine here; the autopilot keeps a generous margin above them.
    if (!awaiting && !onGround && flags & Flags.AP_ENGAGED && now - st.lastTerrain > 500) {
      st.lastTerrain = now
      const from = { lat: s[S.LAT], lon: s[S.LON] }
      const top = Math.max(s[S.HEIGHT] + 3000, 9500)
      let highest = -Infinity
      for (const d of TERRAIN_AHEAD_M) {
        const p = destinationPoint(from, s[S.TRACK], d)
        const hit = world.probeGround(p.lat, p.lon, top, 20000)
        if (hit && hit.height > st.geoid - 450) highest = Math.max(highest, hit.height)
      }
      sim.command({ type: 'terrain_ahead', height: Number.isFinite(highest) ? highest : null })
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
  const celestial = useMemo(() => new CelestialState(), [])
  const cloudsRef = useRef<CloudsEffect>(null)
  const quality = useApp((s) => s.settings.quality)
  const clouds = useApp((s) => s.settings.clouds)
  const shadows = useApp((s) => s.settings.shadows)
  const provider = useApp((s) => s.settings.provider)
  const camera = useThree((s) => s.camera)
  const customClouds = useMemo(() => CUSTOM_CLOUDS ? new VolumetricCloudPass(camera as PerspectiveCamera, frame.ecefFromWorld) : null, [camera])
  useEffect(() => () => customClouds?.dispose(), [customClouds])
  const activeCustomClouds = clouds ? customClouds : null
  const scene = useThree((s) => s.scene)
  const [ocean, setOcean] = useState<Ocean | null>(null)
  const [lakes, setLakes] = useState<LakeWater | null>(null)
  const grade = useMemo(() => new GradeEffect(), [])
  const precipitation = useMemo(() => new PrecipitationEffect(), [])
  const getCloudOverlay = useCallback(() => {
    if (customClouds && useApp.getState().settings.clouds) return customClouds.overlay.map
    return cloudsRef.current?.atmosphereOverlay?.map ?? null
  }, [customClouds])
  const waterMask = useMemo(() => new WaterMask(), [])
  useEffect(() => {
    const abort = new AbortController()
    void waterMask.load(`${import.meta.env.BASE_URL}water/shorelines.bin`, abort.signal)
    return () => {
      abort.abort()
      waterMask.dispose()
    }
  }, [waterMask])
  const night = useMemo(() => {
    const effect = new NightEffect(frame.ecefFromWorld, `${import.meta.env.BASE_URL}atmosphere/city-lights.jpg`, getCloudOverlay)
    stabilizeNightClouds(effect)
    waterMask.maskNightLights(effect)
    return effect
  }, [waterMask, getCloudOverlay])
  useEffect(() => () => night.dispose(), [night])
  const bindLightingMask = useCallback((pass: LightingMaskPass | null) => {
    patchLightingMask(pass)
    night.setLightingMask(pass?.texture ?? null)
  }, [night])
  const nightFill = useRef<HemisphereLight>(null)
  const moonLight = useRef<DirectionalLight>(null)
  const guide = useMemo(() => new OverlayPass(camera, getCloudOverlay), [camera, getCloudOverlay])
  useEffect(() => () => guide.dispose(), [guide])
  const sunThrough = useRef(1)
  // After the library's SunLight recomputes its color from atmospheric transmittance (0).
  useFrame(() => {
    sunLight.current?.color.multiplyScalar(sunThrough.current)
  }, 0.5)
  const cloudHistory = useMemo(() => new CloudHistory(), [])
  const bindAerial = useCallback((effect: Effect | null) => {
    if (!effect) return
    stabilizeAerialPerspective(effect)
    waterMask.shadeAerialPerspective(effect)
    if (customClouds) bindCloudGroundLighting(effect, customClouds)
  }, [waterMask, customClouds])
  const bindClouds = useCallback((effect: CloudsEffect | null) => {
    if (effect) stabilizeClouds(effect)
    cloudsRef.current = effect
  }, [])

  // FlightLoop runs at -1; the effect composer runs at +1. Invalidate history
  // after the camera has moved but before rendering the new cloud image.
  useFrame(() => {
    if (sim.render.valid) waterMask.update(sim.latest[S.LAT], sim.latest[S.LON])
    if (aircraft) waterMask.protectAircraft(aircraft.position, Math.max(aircraft.model.span, aircraft.model.length))
    activeCustomClouds?.setQuality(quality)
    if (customClouds && !activeCustomClouds) customClouds.groundShadow.cloudGroundStrength.value = 0
    const effect = cloudsRef.current
    if (!effect) return
    // R3F applies the library's resolution default before its quality setter,
    // which also resets it to 1. Enforce the budget after those props settle,
    // including when the asynchronously loaded effect first mounts.
    if (effect.resolutionScale !== CLOUD_RESOLUTION[quality]) effect.resolutionScale = CLOUD_RESOLUTION[quality]
    effect.clouds.minStepSize = CLOUD_STEP[quality]
    cloudHistory.update(effect, camera, frame.version, useApp.getState().camera, quality)
  }, 0.25)

  useEffect(() => {
    camera.layers.enable(LIGHTING_MASK_LAYER)
  }, [camera])

  // Live weather and sound settings.
  const windFromDeg = useApp((s) => s.settings.windFromDeg)
  const windSpeedKt = useApp((s) => s.settings.windSpeedKt)
  const turbulence = useApp((s) => s.settings.turbulence)
  const volume = useApp((s) => s.settings.volume)
  const callouts = useApp((s) => s.settings.callouts)
  const liveWeather = useApp((s) => s.settings.liveWeather)
  // Each new live report also changes the wind and turbulence the aircraft feels.
  const report = useWeather((s) => s.conditions)
  useEffect(() => {
    sim.command(weatherCommand(useApp.getState().settings))
  }, [windFromDeg, windSpeedKt, turbulence, liveWeather, report])
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
      <Suspense fallback={null}>
        <CelestialSky atmosphere={atmosphere} celestial={celestial} />
      </Suspense>
      {aircraft ? <primitive object={aircraft.container} /> : null}
      <SunLight ref={sunLight} distance={400} />
      <SkyLight ref={skyLight} />
      <hemisphereLight ref={nightFill} args={['#aebfdb', '#262431', 0]} />
      <directionalLight ref={moonLight} color="#c5d4f2" intensity={0} />
      <SkyEnvironment atmosphere={atmosphere} />
      <LandingGuide world={world} overlay={guide} />
      {world && aircraft ? (
        <FlightLoop world={world} aircraft={aircraft} atmosphere={atmosphere} sunLight={sunLight} skyLight={skyLight} ocean={ocean} lakes={lakes} celestial={celestial} clouds={cloudsRef} customClouds={activeCustomClouds} precipitation={precipitation} night={night} nightFill={nightFill} moonLight={moonLight} sunThrough={sunThrough} />
      ) : null}
      <EffectComposer multisampling={0} enableNormalPass={provider !== 'open'}>
        {activeCustomClouds && <CustomCloudOverlay pass={activeCustomClouds} />}
        {clouds && !customClouds ? (
          <Clouds
            ref={bindClouds}
            qualityPreset={CLOUD_QUALITY[quality]}
            temporalUpscale
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
        <LightingMask ref={bindLightingMask} selectionLayer={LIGHTING_MASK_LAYER} />
        {/* Save the unlit scenery before aerial lighting. Keep these in separate
            passes to stay within WebKit's fragment texture limit with clouds enabled. */}
        <primitive object={night.albedoPass} />
        <EffectGroup>
          {/* The normal override pass misses shader-displaced DEM terrain, leaving
              an unlit strip at the horizon. Its actual depth contains the heights. */}
          <AerialPerspective ref={bindAerial} reconstructNormal={provider === 'open'} sunLight skyLight albedoScale={0.45} stbnTexture={`${import.meta.env.BASE_URL}clouds/stbn.bin`} />
        </EffectGroup>
        <EffectGroup>
          <primitive object={night} />
        </EffectGroup>
        {/* Emissive landing guide over the lit scene (still HDR, before the flare and tone mapping). */}
        <primitive object={guide} />
        {/* Finish lighting before the flare samples the image. Precipitation only
            reads its own pixel, so it rides in the same pass after the grade. */}
        <EffectGroup>
          <LensFlare />
          <ToneMapping mode={ToneMappingMode.AGX} />
          <primitive object={grade} />
          <primitive object={precipitation} />
        </EffectGroup>
        <SMAA preset={quality === 'low' ? SMAAPreset.MEDIUM : SMAAPreset.ULTRA} />
        <Dithering />
      </EffectComposer>
    </Atmosphere>
  )
}

/**
 * Steps the render resolution down while the median frame runs long, and back up
 * once there is headroom. Medians over ~1.5 s ignore one-off hitches (tile parsing,
 * shader compiles), and a resolution that failed soon after a step up becomes the
 * ceiling, so the resolution never oscillates (each change reallocates every buffer).
 */
function AdaptiveResolution({ step, onStep }: { step: number; onStep: (step: number) => void }) {
  const st = useRef({ samples: [] as number[], changedAt: 0, raisedAt: -1e9, slow: 0, fast: 0, floor: 0, ceiling: ADAPTIVE_STEPS.length - 1, before: 0 })
  useFrame((_, dt) => {
    const s = st.current
    const app = useApp.getState()
    if (app.phase !== 'flying' || app.pauseMenu || document.hidden || dt <= 0 || dt > 0.5) {
      s.samples.length = 0
      return
    }
    s.samples.push(dt)
    if (s.samples.length < 90) return
    s.samples.sort((a, b) => a - b)
    const median = s.samples[s.samples.length >> 1]
    s.samples.length = 0
    const now = performance.now()
    if (now - s.changedAt < 3000) return
    // The last step down bought nothing: the frame rate is limited elsewhere (CPU,
    // a 30 Hz power-saving cap). Restore the resolution and stop lowering it.
    if (s.before > 0) {
      const helped = median < s.before * 0.9
      s.before = 0
      if (!helped && step > 0) {
        s.ceiling = step - 1
        s.changedAt = now
        onStep(step - 1)
        return
      }
    }
    if (median > 1 / 40) {
      s.slow++
      s.fast = 0
    } else if (median < 1 / 56) {
      s.fast++
      s.slow = 0
    } else {
      s.slow = s.fast = 0
    }
    if (s.slow >= 2 && step < s.ceiling) {
      // Stepping up did not hold: stay at this resolution from now on.
      if (now - s.raisedAt < 20000) s.floor = step + 1
      s.slow = 0
      s.before = median
      s.changedAt = now
      onStep(step + 1)
    } else if (s.fast >= 4 && step > s.floor) {
      s.fast = 0
      s.changedAt = s.raisedAt = now
      onStep(step - 1)
    }
  })
  return null
}

export default function FlightScene() {
  const renderScale = useApp((s) => s.settings.renderScale)
  const shadows = useApp((s) => s.settings.shadows)
  const quality = useApp((s) => s.settings.quality)
  const adaptive = useApp((s) => s.settings.adaptiveResolution)
  const [step, setStep] = useState(0)
  // A new quality or resolution choice starts again from full resolution.
  useEffect(() => setStep(0), [quality, renderScale, adaptive])
  const dpr = Math.min(MAX_DPR[quality], typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) * renderScale * (adaptive ? ADAPTIVE_STEPS[step] : 1)
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
      {adaptive ? <AdaptiveResolution step={step} onStep={setStep} /> : null}
    </Canvas>
  )
}
