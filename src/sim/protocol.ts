// TypeScript mirror of `crates/sim-core/src/protocol.rs`. Keep in sync.

export const S = {
  TIME: 0,
  ECEF_X: 1,
  ECEF_Y: 2,
  ECEF_Z: 3,
  QX: 4,
  QY: 5,
  QZ: 6,
  QW: 7,
  LAT: 8,
  LON: 9,
  HEIGHT: 10,
  ALT_MSL_FT: 11,
  AGL_FT: 12,
  HEADING: 13,
  PITCH: 14,
  ROLL: 15,
  IAS_KT: 16,
  TAS_KT: 17,
  GS_KT: 18,
  VS_FPM: 19,
  MACH: 20,
  THROTTLE: 21,
  ENGINE: 22,
  GEAR: 23,
  FLAPS: 24,
  FLAPS_INDEX: 25,
  SPOILERS: 26,
  BRAKE: 27,
  ALPHA: 28,
  G_LOAD: 29,
  FLAGS: 30,
  AILERON: 31,
  ELEVATOR: 32,
  RUDDER: 33,
  AP_HEADING: 34,
  AP_ALT_FT: 35,
  AP_SPEED_KT: 36,
  AP_VS_FPM: 37,
  AP_MODES: 38,
  AIRCRAFT_INDEX: 39,
  TOUCHDOWN_FPM: 40,
  GROUND_HEIGHT: 41,
  TRACK: 42,
  GENERATION: 43,
  FPA: 44,
  VEL_E: 45,
  VEL_N: 46,
  VEL_U: 47,
  TIME_SCALE: 48,
  /** Specific force in body axes (g): x forward, y right, z up (1 in level flight). */
  NX: 49,
  NY: 50,
  NZ: 51,
  /** Wind at the aircraft incl. gusts (local east/north/up, m/s). */
  WIND_E: 52,
  WIND_N: 53,
  WIND_U: 54,
  REVERSER: 55,
  GROUND_EFFECT: 56,
  /** Afterburner stage 0..1 (0 = not lit). */
  AFTERBURNER: 57,
  LEN: 58,
} as const

export const Flags = {
  ON_GROUND: 1,
  PAUSED: 2,
  CRASHED: 4,
  STALL: 8,
  AWAITING_GROUND: 16,
  PARKING_BRAKE: 32,
  ASSIST: 64,
  AP_ENGAGED: 128,
  OVERSPEED: 256,
  TAILSTRIKE: 512,
} as const

export const ApModes = { HEADING: 1, ALTITUDE: 2, AUTOTHROTTLE: 4 } as const

export const hasFlag = (snap: Float64Array, flag: number) => ((snap[S.FLAGS] | 0) & flag) !== 0

export interface ControlInput {
  pitch: number
  roll: number
  yaw: number
  throttle_rate: number
  brake: number
  /** Hold (1) for reverse thrust on the ground at idle. */
  reverse: number
}

export interface WeatherRequest {
  /** Direction the wind blows from, degrees true. */
  wind_from_deg: number
  wind_speed_kt: number
  /** 0 (calm) .. 1 (severe). */
  turbulence: number
}

export type SpawnMode = 'ground' | 'air'
export type RunwaySpawnKind = 'takeoff' | 'approach'

export interface SpawnRequest {
  lat: number
  lon: number
  heading?: number
  mode?: SpawnMode
  agl_ft?: number | null
  speed_kt?: number | null
  ground_elevation_ft?: number | null
}

export interface AutopilotCommand {
  engaged?: boolean
  heading_hold?: boolean
  altitude_hold?: boolean
  autothrottle?: boolean
  heading?: number
  altitude_ft?: number
  speed_kt?: number
  vertical_speed_fpm?: number
  heading_delta?: number
  altitude_delta_ft?: number
  speed_delta_kt?: number
}

export type SimCommand =
  | ({ type: 'spawn' } & SpawnRequest)
  | { type: 'spawn_runway'; airport: string; runway?: string | null; kind: RunwaySpawnKind }
  | { type: 'reset' }
  | { type: 'set_aircraft'; id: string }
  | { type: 'set_paused'; paused: boolean }
  | { type: 'toggle_pause' }
  | { type: 'set_throttle'; value: number }
  | { type: 'toggle_gear' }
  | { type: 'flaps_up' }
  | { type: 'flaps_down' }
  | { type: 'set_flaps'; index: number }
  | { type: 'toggle_spoilers' }
  | { type: 'toggle_parking_brake' }
  | { type: 'set_assist'; enabled: boolean }
  | { type: 'toggle_autopilot' }
  | ({ type: 'autopilot' } & AutopilotCommand)
  | { type: 'ground'; lat: number; lon: number; height: number | null }
  | { type: 'set_time_scale'; scale: number }
  | { type: 'collision'; what: string }
  | ({ type: 'set_weather' } & WeatherRequest)

export type SimEvent =
  | { type: 'spawned'; generation: number }
  | { type: 'touchdown'; vertical_speed_fpm: number; rating: string }
  | { type: 'liftoff' }
  | { type: 'crashed'; reason: string }
  | { type: 'stall' }
  | { type: 'message'; text: string }

// ---------------------------------------------------------------------------
// World database queries (answered by Rust, see `sim_core::api`)
// ---------------------------------------------------------------------------

export type WorldQuery =
  | { type: 'search'; query: string; limit?: number }
  | { type: 'airport'; ident: string }
  | { type: 'nearest_airports'; lat: number; lon: number; radius_km?: number; limit?: number }
  | { type: 'map_airports'; include_medium?: boolean }
  | { type: 'aircraft_list' }
  | { type: 'geoid'; lat: number; lon: number }

export type SearchKind = 'airport' | 'city' | 'landmark'

export interface SearchResult {
  kind: SearchKind
  title: string
  subtitle: string
  code: string | null
  lat: number
  lon: number
  elevation_ft: number | null
  suggested_agl_ft: number
  suggested_heading: number
  score: number
}

export interface Airport {
  ident: string
  icao: string
  iata: string
  name: string
  city: string
  country: string
  size: 'large' | 'medium' | 'small'
  lat: number
  lon: number
  elevation_ft: number
}

export interface RunwayEnd {
  ident: string
  lat: number
  lon: number
  elevation_ft: number | null
  heading_deg: number
  displaced_threshold_ft: number
}

export interface Runway {
  length_ft: number
  width_ft: number
  surface: string
  ends: [RunwayEnd, RunwayEnd]
}

export interface AirportDetail {
  airport: Airport
  runways: Runway[]
  geoid_m: number
}

export interface AircraftSpec {
  index: number
  id: string
  name: string
  manufacturer_style: string
  category: string
  description: string
  mass_kg: number
  wing_area_m2: number
  wingspan_m: number
  length_m: number
  gear_height_m: number
  retractable_gear: boolean
  engine: 'jet' | 'propeller'
  engine_count: number
  max_thrust_n: number
  afterburner_thrust_n: number
  afterburner_detent: number
  thrust_reversers: boolean
  alpha_stall_deg: number
  flap_detents: string[]
  v_rotate_kt: number
  v_approach_kt: number
  v_cruise_kt: number
  v_max_kt: number
  cruise_alt_ft: number
  max_alt_ft: number
  service_ceiling_note: string
}
