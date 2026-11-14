import type { Conditions } from './liveWeather'

export interface CloudProfile {
  base: number
  top: number
  sheet: number
  convection: number
}

// Heights are metres above local terrain. The renderer eases changes in the
// reference elevation as the aircraft moves between weather cells and terrain.
export const CUMULUS: CloudProfile = { base: 1500, top: 2000, sheet: 0, convection: 0 }
const STRATOCUMULUS: CloudProfile = { base: 1200, top: 2000, sheet: 0.52, convection: 0 }
const STRATUS: CloudProfile = { base: 900, top: 1700, sheet: 0.95, convection: 0 }
const DRIZZLE: CloudProfile = { base: 340, top: 1150, sheet: 0.95, convection: 0 }
// Precipitating clouds can span multiple levels.
const NIMBOSTRATUS: CloudProfile = { base: 480, top: 5100, sheet: 0.88, convection: 0.18 }
const SHOWERS: CloudProfile = { base: 750, top: 5700, sheet: 0.16, convection: 0.62 }
const THUNDERSTORM: CloudProfile = { base: 660, top: 8900, sheet: 0.12, convection: 1 }

// Representative decks within the WMO's middle and high bands. The high
// deck rises toward the tropics and lowers toward the poles.
export function upperCloudHeights(latitude: number) {
  const absolute = Math.abs(latitude)
  const tropical = Math.max(0, Math.min(1, (35 - absolute) / 12))
  const polar = Math.max(0, Math.min(1, (absolute - 55) / 12))
  return {
    middleBase: 2800,
    middleTop: 4300 + 450 * tropical - 650 * polar,
    highBase: 7800 + 4200 * tropical - 2800 * polar,
    highTop: 9600 + 8400 * tropical - 2800 * polar,
  }
}

export function cloudProfileForWeather(report: Pick<Conditions, 'type' | 'precip' | 'thunder' | 'cloudCover'>) {
  const { type, precip, thunder, cloudCover } = report
  // Use the prevailing condition in compound reports such as
  // CLEAR_THEN_RAIN, consistent with the precipitation in the flight model.
  if (thunder) return THUNDERSTORM
  if (type === 'LIGHT_RAIN' || type.startsWith('DRIZZLE')) return DRIZZLE
  if (precip !== 'none') return /SHOWER/.test(type) ? SHOWERS : NIMBOSTRATUS
  if (type === 'CLOUDY') return STRATUS
  return cloudCover >= 0.68 ? STRATOCUMULUS : CUMULUS
}
