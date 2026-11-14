import { create } from 'zustand'
import type { AirportDetail, RunwaySpawnKind, SpawnMode } from '../sim/protocol'

export type Provider = 'google' | 'cesium' | 'open'
export type CesiumMode = 'photorealistic' | 'terrain'
export type OpenImagery = 'esri' | 'eox'
export type Quality = 'low' | 'medium' | 'high' | 'ultra'
export type CameraMode = 'chase' | 'cockpit' | 'wing' | 'free' | 'cinematic' | 'flyby'
export type Screen = 'home' | 'aircraft' | 'location' | 'destination' | 'settings' | 'controls'

export const CAMERA_MODES: { id: CameraMode; label: string; key: string }[] = [
  { id: 'chase', label: 'Exterior', key: '1' },
  { id: 'cockpit', label: 'Cockpit', key: '2' },
  { id: 'wing', label: 'Wing', key: '3' },
  { id: 'free', label: 'Free look', key: '4' },
  { id: 'cinematic', label: 'Cinematic', key: '5' },
  { id: 'flyby', label: 'Flyby', key: '6' },
]

export interface Settings {
  provider: Provider
  googleApiKey: string
  cesiumToken: string
  cesiumMode: CesiumMode
  openImagery: OpenImagery
  quality: Quality
  renderScale: number
  /** Lower the render resolution automatically while frames run long. */
  adaptiveResolution: boolean
  clouds: boolean
  cloudCoverage: number
  realTime: boolean
  /** Clouds, haze, precipitation and wind from the Google Weather API at the aircraft. */
  liveWeather: boolean
  /** Local solar hour (0-24) when realTime is off. */
  timeOfDay: number
  invertPitch: boolean
  sensitivity: number
  assist: boolean
  showFps: boolean
  shadows: boolean
  timeScale: number
  /** Direction the surface wind blows from (degrees true). */
  windFromDeg: number
  windSpeedKt: number
  /** 0 calm .. 1 severe. */
  turbulence: number
  /** Master volume 0..1. */
  volume: number
  /** Spoken radio-altitude and GPWS callouts (jets). */
  callouts: boolean
}

const env = import.meta.env
const DEFAULTS: Settings = {
  provider: env.VITE_GOOGLE_MAPS_API_KEY ? 'google' : env.VITE_CESIUM_ION_TOKEN ? 'cesium' : 'open',
  googleApiKey: env.VITE_GOOGLE_MAPS_API_KEY ?? '',
  cesiumToken: env.VITE_CESIUM_ION_TOKEN ?? '',
  cesiumMode: 'photorealistic',
  openImagery: 'esri',
  quality: 'high',
  renderScale: 1,
  adaptiveResolution: true,
  clouds: true,
  cloudCoverage: 0.35,
  liveWeather: !!env.VITE_GOOGLE_MAPS_API_KEY,
  realTime: true,
  timeOfDay: 15.5,
  invertPitch: false,
  sensitivity: 0.75,
  assist: true,
  showFps: false,
  shadows: true,
  timeScale: 1,
  windFromDeg: 270,
  windSpeedKt: 8,
  turbulence: 0.15,
  volume: 0.7,
  callouts: true,
}

const STORAGE_KEY = 'geoflight.settings.v1'

/** `?lite` (testing on slow/software GPUs): no clouds or shadows, half resolution. */
const LITE = typeof location !== 'undefined' && new URLSearchParams(location.search).has('lite')

function loadSettings(): Settings {
  let s = DEFAULTS
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const stored = JSON.parse(raw) as Partial<Settings>
      s = { ...DEFAULTS, ...stored }
      // Settings saved before live weather existed: adopt the real-world defaults once.
      if (stored.liveWeather === undefined) s = { ...s, realTime: true, liveWeather: s.googleApiKey.trim().length > 10 }
    }
  } catch {
    // storage unavailable
  }
  return LITE ? { ...s, clouds: false, shadows: false, renderScale: 0.5, quality: 'low' } : s
}

function saveSettings(s: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    // storage unavailable
  }
}

export type SpawnChoice =
  | { kind: 'runway'; airport: string; airportName: string; runway: string | null; mode: RunwaySpawnKind }
  | { kind: 'coords'; label: string; lat: number; lon: number; mode: SpawnMode; aglFt: number; heading: number; elevationFt: number | null }

/** The landing runway the autopilot chose (reported by the simulation). */
export interface AutopilotRunway {
  airport: string
  runway: string
}

export interface Toast {
  id: number
  text: string
  tone: 'info' | 'good' | 'warn' | 'bad'
}

interface AppState {
  phase: 'menu' | 'flying'
  screen: Screen
  aircraftId: string
  spawn: SpawnChoice
  destination: AirportDetail | null
  routeOpen: boolean
  skipToOpen: boolean
  setSkipToOpen: (open: boolean) => void
  destinationMarkerVisible: boolean
  runwayAlignmentVisible: boolean
  autopilotRunway: AutopilotRunway | null
  setAutopilotRunway: (runway: AutopilotRunway | null) => void
  setDestination: (destination: AirportDetail | null) => void
  setRouteOpen: (routeOpen: boolean) => void
  toggleDestinationMarker: () => void
  toggleRunwayAlignment: () => void
  settings: Settings
  camera: CameraMode
  hudVisible: boolean
  pauseMenu: boolean
  helpOverlay: boolean
  toasts: Toast[]
  crashed: string | null
  setScreen: (s: Screen) => void
  setPhase: (p: 'menu' | 'flying') => void
  setAircraft: (id: string) => void
  setSpawn: (s: SpawnChoice) => void
  updateSettings: (patch: Partial<Settings>) => void
  setCamera: (c: CameraMode) => void
  cycleCamera: (dir?: 1 | -1) => void
  toggleHud: () => void
  setPauseMenu: (open: boolean) => void
  setHelpOverlay: (open: boolean) => void
  toast: (text: string, tone?: Toast['tone']) => void
  dismissToast: (id: number) => void
  setCrashed: (reason: string | null) => void
}

let toastId = 1

export const useApp = create<AppState>((set, get) => ({
  phase: 'menu',
  screen: 'home',
  aircraftId: 'b737',
  destination: null,
  routeOpen: false,
  skipToOpen: false,
  setSkipToOpen: (skipToOpen) => set({ skipToOpen }),
  destinationMarkerVisible: false,
  runwayAlignmentVisible: false,
  autopilotRunway: null,
  setAutopilotRunway: (autopilotRunway) => set({ autopilotRunway }),
  setDestination: (destination) => set({ destination }),
  setRouteOpen: (routeOpen) => set({ routeOpen }),
  toggleDestinationMarker: () => set((s) => ({ destinationMarkerVisible: !s.destinationMarkerVisible })),
  toggleRunwayAlignment: () => set((s) => ({ runwayAlignmentVisible: !s.runwayAlignmentVisible })),
  spawn: { kind: 'runway', airport: 'KORD', airportName: "Chicago O'Hare International Airport", runway: '28R', mode: 'takeoff' },
  settings: loadSettings(),
  camera: 'chase',
  hudVisible: true,
  pauseMenu: false,
  helpOverlay: false,
  toasts: [],
  crashed: null,
  setScreen: (screen) => set({ screen }),
  setPhase: (phase) => set({ phase, pauseMenu: false, routeOpen: false, skipToOpen: false, crashed: null }),
  setAircraft: (aircraftId) => set({ aircraftId }),
  setSpawn: (spawn) => set({ spawn }),
  updateSettings: (patch) =>
    set((st) => {
      const settings = { ...st.settings, ...patch }
      saveSettings(settings)
      return { settings }
    }),
  setCamera: (camera) => set({ camera }),
  cycleCamera: (dir = 1) => {
    const i = CAMERA_MODES.findIndex((c) => c.id === get().camera)
    const n = CAMERA_MODES.length
    set({ camera: CAMERA_MODES[(i + dir + n) % n].id })
  },
  toggleHud: () => set((st) => ({ hudVisible: !st.hudVisible })),
  setPauseMenu: (pauseMenu) => set({ pauseMenu }),
  setHelpOverlay: (helpOverlay) => set({ helpOverlay }),
  toast: (text, tone = 'info') => {
    const id = toastId++
    set((st) => ({ toasts: [...st.toasts.slice(-3), { id, text, tone }] }))
    setTimeout(() => get().dismissToast(id), 4200)
  },
  dismissToast: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),
  setCrashed: (crashed) => set({ crashed }),
}))

/** True when the user has supplied what the selected provider needs. */
export function providerReady(s: Settings): boolean {
  if (s.provider === 'google') return s.googleApiKey.trim().length > 10
  if (s.provider === 'cesium') return s.cesiumToken.trim().length > 10
  return true
}
