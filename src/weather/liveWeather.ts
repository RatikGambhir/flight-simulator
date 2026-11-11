// Live weather at the aircraft from the Google Maps Platform Weather API
// (currentConditions:lookup). Conditions are refetched as the flight moves and
// translated into what the scene can show: cloud coverage, haze, precipitation
// and the wind / turbulence fed to the flight model.

import { create } from 'zustand'

export type Precip = 'none' | 'rain' | 'snow'

export interface Conditions {
  type: string
  description: string
  tempC: number | null
  windFromDeg: number
  windKt: number
  gustKt: number
  visibilityKm: number | null
  /** 0 clear .. 1 overcast. */
  cloudCover: number
  precip: Precip
  /** 0 none .. 1 heavy. */
  intensity: number
  thunder: boolean
  /** IANA zone of the location, for the local clock. */
  timeZone: string | null
  lat: number
  lon: number
  fetchedAt: number
}

interface WeatherState {
  status: 'off' | 'loading' | 'live' | 'error'
  conditions: Conditions | null
  error: string | null
}

export const useWeather = create<WeatherState>(() => ({ status: 'off', conditions: null, error: null }))

const ENDPOINT = 'https://weather.googleapis.com/v1/currentConditions:lookup'
/** Refetch after this much travel, or when the report is this old. */
const REFETCH_KM = 25
const REFETCH_MS = 10 * 60_000
const MIN_INTERVAL_MS = 30_000
const ERROR_BACKOFF_MS = 5 * 60_000

const KMH_TO_KT = 1 / 1.852
const MPH_TO_KT = 0.868976

function speedKt(v: { value?: number; unit?: string } | undefined) {
  if (!v || typeof v.value !== 'number') return 0
  return v.value * (v.unit === 'MILES_PER_HOUR' ? MPH_TO_KT : KMH_TO_KT)
}

const COVER_BY_TYPE: [RegExp, number][] = [
  [/^CLEAR/, 0.05],
  [/^MOSTLY_CLEAR/, 0.2],
  [/^PARTLY_CLOUDY/, 0.45],
  [/^MOSTLY_CLOUDY/, 0.75],
  [/^CLOUDY|FOG/, 0.95],
]

/** Reads precipitation kind and strength out of a WeatherCondition type such as HEAVY_RAIN_SHOWERS. */
export function classify(type: string): { precip: Precip; intensity: number; thunder: boolean } {
  const thunder = /THUNDER/.test(type)
  // Regional compound types ("CLEAR_THEN_RAIN") describe a forecast; trust the leading state.
  const dry = /^(CLEAR|MOSTLY_CLEAR|PARTLY_CLOUDY|MOSTLY_CLOUDY|CLOUDY|WINDY|FOG|VERY_HOT|TYPE_UNSPECIFIED)/.test(type) && type !== 'WIND_AND_RAIN'
  let precip: Precip = 'none'
  if (!dry || type === 'WIND_AND_RAIN') {
    if (/SNOW/.test(type) && !/^RAIN/.test(type)) precip = 'snow'
    else if (/RAIN|SHOWER|HAIL|SLEET|THUNDER/.test(type)) precip = 'rain'
  }
  let intensity = 0
  if (precip !== 'none') {
    if (/CHANCE/.test(type)) intensity = 0.2
    else if (/HEAVY|STORM/.test(type)) intensity = 1
    else if (/LIGHT_TO_MODERATE|SCATTERED/.test(type)) intensity = 0.45
    else if (/LIGHT/.test(type)) intensity = 0.3
    else intensity = 0.65
  }
  return { precip, intensity, thunder }
}

// Only the fields the simulator uses.
interface ApiResponse {
  timeZone?: { id?: string }
  weatherCondition?: { type?: string; description?: { text?: string } }
  temperature?: { degrees?: number; unit?: string }
  wind?: { direction?: { degrees?: number }; speed?: { value?: number; unit?: string }; gust?: { value?: number; unit?: string } }
  visibility?: { distance?: number; unit?: string }
  cloudCover?: number
  error?: { message?: string; status?: string }
}

export function parseConditions(json: ApiResponse, lat: number, lon: number, now: number): Conditions {
  const type = json.weatherCondition?.type ?? 'TYPE_UNSPECIFIED'
  const { precip, intensity, thunder } = classify(type)
  let cover = typeof json.cloudCover === 'number' ? json.cloudCover / 100 : (COVER_BY_TYPE.find(([re]) => re.test(type))?.[1] ?? (precip === 'none' ? 0.4 : 0.9))
  // It cannot rain from a clear sky, whatever the cover figure says.
  if (precip !== 'none') cover = Math.max(cover, 0.7 + 0.25 * intensity)
  const t = json.temperature
  const tempC = typeof t?.degrees === 'number' ? (t.unit === 'FAHRENHEIT' ? ((t.degrees - 32) * 5) / 9 : t.degrees) : null
  const vis = json.visibility
  const visibilityKm = typeof vis?.distance === 'number' ? vis.distance * (vis.unit === 'MILES' ? 1.609344 : 1) : null
  const windKt = speedKt(json.wind?.speed)
  return {
    type,
    description: json.weatherCondition?.description?.text ?? type.toLowerCase().replaceAll('_', ' '),
    tempC,
    windFromDeg: json.wind?.direction?.degrees ?? 0,
    windKt,
    gustKt: Math.max(windKt, speedKt(json.wind?.gust)),
    visibilityKm,
    cloudCover: Math.min(1, Math.max(0, cover)),
    precip,
    intensity,
    thunder,
    timeZone: json.timeZone?.id ?? null,
    lat,
    lon,
    fetchedAt: now,
  }
}

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const r = Math.PI / 180
  const x = (lon2 - lon1) * r * Math.cos(((lat1 + lat2) / 2) * r)
  const y = (lat2 - lat1) * r
  return Math.hypot(x, y) * 6371
}

let lastAttempt = -Infinity
let retryAfter = -Infinity
let inFlight = false
let activeKey = ''

/** Call regularly with the aircraft position; fetches only when a new report is due. */
export function pollWeather(enabled: boolean, apiKey: string, lat: number, lon: number) {
  const key = apiKey.trim()
  const state = useWeather.getState()
  if (!enabled || key.length < 10) {
    if (state.status !== 'off') useWeather.setState({ status: 'off', conditions: null, error: null })
    activeKey = ''
    return
  }
  const now = Date.now()
  if (key !== activeKey) {
    activeKey = key
    lastAttempt = retryAfter = -Infinity
  }
  if (inFlight || now < retryAfter || now - lastAttempt < MIN_INTERVAL_MS) return
  const c = state.conditions
  if (c && now - c.fetchedAt < REFETCH_MS && distanceKm(c.lat, c.lon, lat, lon) < REFETCH_KM) return

  inFlight = true
  lastAttempt = now
  if (!c) useWeather.setState({ status: 'loading', error: null })
  // Two decimals (~1 km) is ample for a weather cell.
  const url = `${ENDPOINT}?key=${encodeURIComponent(key)}&location.latitude=${lat.toFixed(2)}&location.longitude=${lon.toFixed(2)}`
  fetch(url)
    .then(async (res) => {
      const json = (await res.json().catch(() => ({}))) as ApiResponse
      if (!res.ok) throw new Error(json.error?.message ?? `Weather request failed (${res.status})`)
      return json
    })
    .then((json) => {
      if (activeKey !== key) return
      useWeather.setState({ status: 'live', conditions: parseConditions(json, lat, lon, Date.now()), error: null })
    })
    .catch((e: unknown) => {
      if (activeKey !== key) return
      retryAfter = Date.now() + ERROR_BACKOFF_MS
      // Keep flying on the last good report if there is one.
      useWeather.setState({ status: useWeather.getState().conditions ? 'live' : 'error', error: e instanceof Error ? e.message : String(e) })
    })
    .finally(() => {
      inFlight = false
    })
}

/** Wind and turbulence for the flight model. */
export function simWeather(c: Conditions) {
  const gustSpread = Math.max(0, c.gustKt - c.windKt)
  const turbulence = Math.min(0.85, 0.05 + gustSpread / 30 + c.windKt / 120 + (c.thunder ? 0.35 : 0) + c.intensity * 0.1)
  return { windFromDeg: c.windFromDeg, windSpeedKt: Math.min(60, c.windKt), turbulence }
}

/** Default haze of the cloud renderer (a clear day). */
export const CLEAR_HAZE = 3e-5

/** What the renderer should be showing for a report. */
export function visualTargets(c: Conditions) {
  let haze = CLEAR_HAZE
  if (c.visibilityKm !== null) {
    // Koschmieder: extinction = 3.912 / visibility; the haze density scale is that extinction at sea level.
    // Capped near 13 km: thicker than that hides the ground from pattern height and the sim stops being flyable.
    const fromVisibility = Math.min(3e-4, 3.912 / (Math.max(1.5, c.visibilityKm) * 1000))
    // Reports top out around 16 km, which means "unlimited" rather than a measured haze.
    const t = Math.min(1, Math.max(0, (c.visibilityKm - 8) / 8))
    haze = fromVisibility + (CLEAR_HAZE - fromVisibility) * t * t * (3 - 2 * t)
  }
  if (c.precip !== 'none') haze = Math.max(haze, 8e-5 + 1.2e-4 * c.intensity)
  return {
    // Kept short of a solid deck so an approach under an overcast still has ground contact.
    coverage: 0.06 + 0.66 * c.cloudCover,
    haze,
    precip: c.precip === 'none' ? 0 : c.intensity,
    snow: c.precip === 'snow' ? 1 : 0,
  }
}
