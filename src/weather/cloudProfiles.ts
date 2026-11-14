import type { Conditions } from './liveWeather'

export interface CloudProfile {
  base: number
  top: number
  sheet: number
  convection: number
  /** Near-surface aerosol extinction, in inverse metres. */
  fog?: number
}

// Heights are metres above mean sea level as approximated by the renderer.
export const CUMULUS: CloudProfile = { base: 920, top: 3650, sheet: 0, convection: 0 }
const STRATOCUMULUS: CloudProfile = { base: 680, top: 2350, sheet: 0.52, convection: 0 }
const STRATUS: CloudProfile = { base: 340, top: 1150, sheet: 0.95, convection: 0 }
const FOG: CloudProfile = { base: -120, top: 650, sheet: 1, convection: 0, fog: 0.0011 }
const NIMBOSTRATUS: CloudProfile = { base: 480, top: 2850, sheet: 0.88, convection: 0.18 }
const SHOWERS: CloudProfile = { base: 750, top: 5700, sheet: 0.16, convection: 0.62 }
const THUNDERSTORM: CloudProfile = { base: 660, top: 8900, sheet: 0.12, convection: 1 }

export function cloudProfileForWeather(report: Pick<Conditions, 'type' | 'precip' | 'thunder' | 'cloudCover'>) {
  const { type, precip, thunder, cloudCover } = report
  // Use the prevailing condition in compound reports such as
  // CLEAR_THEN_RAIN, consistent with the precipitation in the flight model.
  if (thunder) return THUNDERSTORM
  if (type.startsWith('FOG') || (precip === 'none' && /^MIST/.test(type))) return FOG
  if (type === 'LIGHT_RAIN' || type.startsWith('DRIZZLE')) return STRATUS
  if (precip !== 'none') return /SHOWER/.test(type) ? SHOWERS : NIMBOSTRATUS
  if (type === 'CLOUDY') return STRATUS
  return cloudCover >= 0.68 ? STRATOCUMULUS : CUMULUS
}
