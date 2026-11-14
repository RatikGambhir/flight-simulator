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
import { NoToneMapping, PCFShadowMap, Vector2, type DirectionalLight, type HemisphereLight, type PerspectiveCamera } from 'three'
import type { LightingMaskPass, SunDirectionalLight, SkyLightProbe } from '@takram/three-atmosphere'
import type { ShaderMaterial } from 'three'
import { AircraftController, LIGHTING_MASK_LAYER } from '../aircraft/aircraftController'
import { sound } from '../audio/sound'
import { weatherCommand } from '../flight'
import { S } from '../sim/protocol'
import { sim } from '../sim/simClient'
import { useApp, type Quality } from '../state/store'
import { frame } from '../world/frame'
import { WorldSystem } from '../world/worldSystem'
import { worldStatus } from './worldStatus'
import { SkyEnvironment } from './SkyEnvironment'
import { FlightLoop } from './FlightLoop'
import { GradeEffect } from './Grade'
import { Ocean } from './Ocean'
import { LakeWater } from './LakeWater'
import { CloudHistory, stabilizeAerialPerspective, stabilizeClouds, stabilizeNightClouds } from './cloudRendering'
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
import { CelestialState } from './celestial'
import { useWeather } from '../weather/liveWeather'

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

function useWorld(overlay: OverlayPass): WorldSystem | null {
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
    const w = new WorldSystem(settings, gl, camera as PerspectiveCamera, scene, overlay)
    setWorld(w)
    worldStatus.set({ world: w })
    return () => {
      worldStatus.set({ world: null })
      w.dispose()
    }
  }, [gl, camera, scene, overlay, provider, googleApiKey, cesiumToken, cesiumMode, openImagery, quality])
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

function SceneContents() {
  const atmosphereTextures = useAtmosphereTextures()
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
  const world = useWorld(guide)
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
