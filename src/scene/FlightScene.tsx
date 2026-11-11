import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { EffectComposer, SMAA, ToneMapping } from '@react-three/postprocessing'
import { AerialPerspective, Atmosphere, LightingMask, Sky, SkyLight, Stars, SunLight, type AtmosphereApi } from '@takram/three-atmosphere/r3f'
import { Clouds } from '@takram/three-clouds/r3f'
import { Dithering, LensFlare } from '@takram/three-geospatial-effects/r3f'
import { ToneMappingMode } from 'postprocessing'
import { useEffect, useMemo, useRef, useState } from 'react'
import { NoToneMapping, PCFSoftShadowMap, Vector3, type PerspectiveCamera } from 'three'
import type { SunDirectionalLight, SkyLightProbe } from '@takram/three-atmosphere'
import type { Points } from 'three'
import { AircraftController, LIGHTING_MASK_LAYER } from '../aircraft/aircraftController'
import { CameraRig } from '../camera/cameraRig'
import { controls } from '../input/controls'
import { Flags, S } from '../sim/protocol'
import { sim } from '../sim/simClient'
import { useApp, type Quality } from '../state/store'
import { frame } from '../world/frame'
import { WorldSystem } from '../world/worldSystem'
import { worldStatus } from './worldStatus'
import { SkyEnvironment } from './SkyEnvironment'
import { Ocean } from './Ocean'

const CLOUD_QUALITY: Record<Quality, 'low' | 'medium' | 'high' | 'ultra'> = {
  low: 'low',
  medium: 'low',
  high: 'medium',
  ultra: 'high',
}

/** Date for the atmosphere: real time, or today at a chosen local solar hour at the aircraft. */
function sceneDate(realTime: boolean, hour: number, lon: number) {
  if (realTime) return new Date()
  const d = new Date()
  const utcHours = hour - lon / 15
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + utcHours * 3600_000)
}

const _sun = new Vector3()
const _probe = new Vector3()
const _dir = new Vector3()
const _vel = new Vector3()
const _e = new Vector3()
const _n = new Vector3()
const _u = new Vector3()

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
  stars: React.RefObject<Points | null>
}

function FlightLoop({ world, aircraft, atmosphere, sunLight, skyLight, ocean, stars }: LoopProps) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera
  const gl = useThree((s) => s.gl)
  const rig = useMemo(() => new CameraRig(camera), [camera])
  const state = useRef({ gen: -1, spawnAt: 0, lastProbe: 0, lastCollision: 0, geoid: 0, lastGeoid: 0, groundSamples: 0 })

  // Mouse: drag to orbit / look, wheel to zoom, double-click to reset.
  useEffect(() => {
    const el = gl.domElement
    let drag = false
    let lx = 0
    let ly = 0
    const down = (e: PointerEvent) => {
      drag = true
      lx = e.clientX
      ly = e.clientY
      el.setPointerCapture(e.pointerId)
    }
    const move = (e: PointerEvent) => {
      if (!drag) return
      rig.drag(e.clientX - lx, e.clientY - ly)
      lx = e.clientX
      ly = e.clientY
    }
    const up = (e: PointerEvent) => {
      drag = false
      rig.endDrag()
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    }
    const wheel = (e: WheelEvent) => rig.wheel(e.deltaY)
    const dbl = () => rig.resetView()
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('wheel', wheel, { passive: true })
    el.addEventListener('dblclick', dbl)
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('wheel', wheel)
      el.removeEventListener('dblclick', dbl)
    }
  }, [gl, rig])

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

    // Atmosphere / sun.
    const atm = atmosphere.current
    const settings = useApp.getState().settings
    let sunWorld: Vector3 | null = null
    if (atm) {
      atm.updateByDate(sceneDate(settings.realTime, settings.timeOfDay, s[S.LON]))
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
    rig.update(
      {
        position: aircraft.position,
        quaternion: aircraft.quaternion,
        velocity: _vel,
        length: aircraft.model.length,
        span: aircraft.model.span,
        eye: aircraft.model.eye,
        wingTip: aircraft.model.wingTipRight,
      },
      dt,
    )

    if (ocean) {
      ocean.update(camera.position, st.geoid, now / 1000)
      // Don't flood the view with water before the terrain around us has streamed in.
      ocean.mesh.visible = st.groundSamples > 0 || world.loadProgress > 0.95
    }

    // Stream tiles for the new camera pose.
    world.update()
    worldStatus.tick(world)

    const flags = s[S.FLAGS] | 0
    const awaiting = (flags & Flags.AWAITING_GROUND) !== 0
    const onGround = (flags & Flags.ON_GROUND) !== 0

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
  const world = useWorld()
  const aircraft = useAircraft()
  const atmosphere = useRef<AtmosphereApi>(null)
  const sunLight = useRef<SunDirectionalLight>(null)
  const skyLight = useRef<SkyLightProbe>(null)
  const stars = useRef<Points>(null)
  const quality = useApp((s) => s.settings.quality)
  const clouds = useApp((s) => s.settings.clouds)
  const coverage = useApp((s) => s.settings.cloudCoverage)
  const shadows = useApp((s) => s.settings.shadows)
  const provider = useApp((s) => s.settings.provider)
  const camera = useThree((s) => s.camera)
  const scene = useThree((s) => s.scene)
  const [ocean, setOcean] = useState<Ocean | null>(null)

  useEffect(() => {
    camera.layers.enable(LIGHTING_MASK_LAYER)
  }, [camera])

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
  }, [aircraft, shadows])

  return (
    <Atmosphere ref={atmosphere} correctAltitude>
      <Sky />
      <Stars ref={stars} data={`${import.meta.env.BASE_URL}atmosphere/stars.bin`} background />
      {aircraft ? <primitive object={aircraft.container} /> : null}
      <SunLight ref={sunLight} distance={400} />
      <SkyLight ref={skyLight} />
      <SkyEnvironment atmosphere={atmosphere} />
      {world && aircraft ? <FlightLoop world={world} aircraft={aircraft} atmosphere={atmosphere} sunLight={sunLight} skyLight={skyLight} ocean={ocean} stars={stars} /> : null}
      <EffectComposer multisampling={0} enableNormalPass>
        {clouds ? (
          <Clouds
            qualityPreset={CLOUD_QUALITY[quality]}
            coverage={coverage}
            localWeatherTexture={`${import.meta.env.BASE_URL}clouds/local_weather.png`}
            shapeTexture={`${import.meta.env.BASE_URL}clouds/shape.bin`}
            shapeDetailTexture={`${import.meta.env.BASE_URL}clouds/shape_detail.bin`}
            turbulenceTexture={`${import.meta.env.BASE_URL}clouds/turbulence.png`}
            stbnTexture={`${import.meta.env.BASE_URL}clouds/stbn.bin`}
          />
        ) : (
          <></>
        )}
        <LightingMask selectionLayer={LIGHTING_MASK_LAYER} />
        <AerialPerspective sunLight skyLight stbnTexture={`${import.meta.env.BASE_URL}clouds/stbn.bin`} />
        <LensFlare />
        <ToneMapping mode={ToneMappingMode.AGX} />
        <SMAA />
        <Dithering />
      </EffectComposer>
    </Atmosphere>
  )
}

export default function FlightScene() {
  const renderScale = useApp((s) => s.settings.renderScale)
  const shadows = useApp((s) => s.settings.shadows)
  const dpr = Math.min(2, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) * renderScale)
  return (
    <Canvas
      className="flight-canvas"
      dpr={dpr}
      shadows={shadows ? { type: PCFSoftShadowMap } : false}
      gl={{ logarithmicDepthBuffer: true, antialias: false, powerPreference: 'high-performance', depth: true, stencil: false, toneMapping: NoToneMapping, toneMappingExposure: 10 }}
      camera={{ fov: 58, near: 0.3, far: 2e7 }}
      onCreated={({ gl }) => {
        gl.setClearColor('#000000')
      }}
    >
      <SceneContents />
    </Canvas>
  )
}

