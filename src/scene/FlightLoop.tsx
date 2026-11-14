// @refresh reset
import { useFrame, useThree } from '@react-three/fiber'
import type { SunDirectionalLight, SkyLightProbe } from '@takram/three-atmosphere'
import type { AtmosphereApi } from '@takram/three-atmosphere/r3f'
import type { CloudsEffect } from '@takram/three-clouds'
import { useEffect, useMemo, useRef } from 'react'
import { MathUtils, Raycaster, Vector2, Vector3, type DirectionalLight, type HemisphereLight, type PerspectiveCamera } from 'three'
import type { AircraftController } from '../aircraft/aircraftController'
import { sound } from '../audio/sound'
import { CameraRig, type AircraftPose } from '../camera/cameraRig'
import { controls } from '../input/controls'
import { destinationPoint } from '../navigation/route'
import { Flags, S, type SimCommand } from '../sim/protocol'
import { sim } from '../sim/simClient'
import { useApp } from '../state/store'
import { CUMULUS, cloudProfileForWeather } from '../weather/cloudProfiles'
import { CLEAR_HAZE, pollWeather, useWeather, visualTargets, type Conditions } from '../weather/liveWeather'
import { enuBasis, frame } from '../world/frame'
import type { WorldSystem } from '../world/worldSystem'
import { setCloudNightLighting } from './cloudRendering'
import { sceneDate, type CelestialState } from './celestial'
import type { LakeWater } from './LakeWater'
import type { NightEffect } from './NightEffect'
import type { Ocean } from './Ocean'
import type { PrecipitationEffect } from './Precipitation'
import type { VolumetricCloudPass } from './VolumetricCloudPass'
import { worldStatus } from './worldStatus'

/** Distances ahead (m) sampled for the autopilot's terrain awareness. */
const TERRAIN_AHEAD_M = [1000, 2000, 3500, 5000, 7500, 10000]

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

export function FlightLoop({ world, aircraft, atmosphere, sunLight, skyLight, ocean, lakes, celestial, clouds, customClouds, precipitation, night, nightFill, moonLight, sunThrough }: LoopProps) {
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
    const respawned = r.generation !== st.gen
    if (respawned) {
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
        shadows: settings.shadows, profile: wx.profile, upperClouds: !target?.precip,
        latitude: s[S.LAT], geoid: st.geoid, groundHeight: s[S.GROUND_HEIGHT], snap: respawned,
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
    const airport = app.autopilotRunway?.airport ?? app.destination?.airport.ident ??
      (app.spawn.kind === 'runway' ? app.spawn.airport : null)
    world.updateRunways(s[S.LAT], s[S.LON], pose.heightAboveGround, airport, st.dark)
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
