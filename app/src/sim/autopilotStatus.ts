// What the autopilot is doing, for the HUD and cockpit displays. Pure
// functions of the snapshot so they can be unit tested without a renderer.
// Keep the phase and lateral-mode lists in the same order as
// `autopilot::Phase` and `autopilot::Lateral` in crates/sim-core.

import { ApModes, Flags, S } from './protocol'

export const AP_PHASES = [
  'OFF',
  'HDG/ALT HOLD',
  'TAXI',
  'LINE UP',
  'TAKEOFF',
  'ROTATE',
  'INITIAL CLIMB',
  'CLIMB',
  'CRUISE',
  'DESCENT',
  'APPROACH',
  'FINAL',
  'FLARE',
  'ROLLOUT',
  'LANDED',
  'GO-AROUND',
] as const

export type ApPhase = (typeof AP_PHASES)[number]

/** Lateral modes: short labels as an airliner's mode annunciator shows them. */
export const AP_LATERAL = ['', 'HDG', 'RWY HDG', 'DCT', 'DOWNWIND', 'INTERCEPT', 'LOC', 'RWY', 'TAXI'] as const

/** Phases flown with the wheels on the ground. */
const GROUND_PHASES = new Set<ApPhase>(['TAXI', 'LINE UP', 'TAKEOFF', 'ROTATE', 'ROLLOUT', 'LANDED'])

export type ApTone = 'off' | 'on' | 'caution' | 'complete'

export interface ApStatus {
  engaged: boolean
  /** Navigating to a destination (not just holding heading/altitude/speed). */
  managed: boolean
  phase: ApPhase
  lateral: string
  /** Route / navigation line, e.g. "DCT KMKE · 54 NM · RWY 01L". */
  nav: string
  /** Targets line, e.g. "ALT 9,500 · SPD 250". */
  targets: string
  tone: ApTone
}

export interface ApContext {
  /** Destination airport ident, if one is chosen. */
  destination?: string | null
  /** Landing runway the autopilot chose, if known. */
  runway?: string | null
}

const thousands = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

function flightLevelOrAltitude(ft: number) {
  return thousands.format(Math.round(ft / 100) * 100)
}

export function phaseName(code: number): ApPhase {
  return AP_PHASES[Math.max(0, Math.min(AP_PHASES.length - 1, Math.round(code)))] ?? 'OFF'
}

export function autopilotStatus(s: ArrayLike<number>, ctx: ApContext = {}): ApStatus {
  const flags = s[S.FLAGS] | 0
  const engaged = (flags & Flags.AP_ENGAGED) !== 0
  const modes = s[S.AP_MODES] | 0
  if (!engaged) {
    return { engaged, managed: false, phase: 'OFF', lateral: '', nav: '', targets: '', tone: 'off' }
  }
  const phase = phaseName(s[S.AP_PHASE])
  const managed = (modes & ApModes.MANAGED) !== 0
  const lateral = AP_LATERAL[s[S.AP_LATERAL] | 0] ?? ''
  const hdg = String(Math.round(s[S.AP_HEADING]) % 360 || 360).padStart(3, '0')
  const alt = flightLevelOrAltitude(s[S.AP_ALT_FT])
  const spd = Math.round(s[S.AP_SPEED_KT])
  const autothrottle = (modes & ApModes.AUTOTHROTTLE) !== 0
  const spdText = autothrottle ? `SPD ${spd}` : 'A/T OFF'

  let nav = ''
  let targets = ''
  if (!managed) {
    nav = modes & ApModes.HEADING ? `HDG ${hdg}` : 'WINGS LEVEL'
    targets = [modes & ApModes.ALTITUDE ? `ALT ${alt}` : '', spdText].filter(Boolean).join(' · ')
  } else {
    const dist = s[S.AP_DIST_NM]
    const parts: string[] = []
    if (lateral && lateral !== 'RWY' && lateral !== 'TAXI') parts.push(lateral === 'HDG' || lateral === 'RWY HDG' ? `${lateral} ${hdg}` : lateral)
    if (ctx.destination) parts.push(ctx.destination)
    if (dist >= 0 && !GROUND_PHASES.has(phase)) parts.push(`${dist >= 10 ? Math.round(dist) : dist.toFixed(1)} NM`)
    if (ctx.runway && !['TAXI', 'LINE UP', 'TAKEOFF', 'ROTATE'].includes(phase)) parts.push(`RWY ${ctx.runway}`)
    if (phase === 'TAXI') parts.unshift('TAXI TO RUNWAY')
    nav = parts.join(' · ')
    if (phase === 'LANDED') targets = 'PARKING BRAKE SET · Z TO TAKE OVER'
    else if (GROUND_PHASES.has(phase)) targets = phase === 'ROLLOUT' ? 'AUTOBRAKE · REVERSE' : `${phase === 'TAXI' || phase === 'LINE UP' ? 'GS' : 'VR'} ${spd}`
    else {
      const vs = Math.round(s[S.AP_VS_FPM] / 100) * 100
      const vsText = Math.abs(vs) >= 300 ? `${vs > 0 ? '▲' : '▼'} ${thousands.format(Math.abs(vs))}` : ''
      targets = [phase === 'FINAL' || phase === 'FLARE' ? 'G/S' : `ALT ${alt}`, spdText, vsText].filter(Boolean).join(' · ')
    }
  }
  const tone: ApTone = phase === 'GO-AROUND' ? 'caution' : phase === 'LANDED' ? 'complete' : 'on'
  return { engaged, managed, phase, lateral, nav, targets, tone }
}

/**
 * Airliner-style flight mode annunciation: [thrust, roll, pitch] columns as a
 * primary flight display shows them. Empty strings for blank columns.
 */
export function flightModes(s: ArrayLike<number>): [string, string, string] {
  const flags = s[S.FLAGS] | 0
  if ((flags & Flags.AP_ENGAGED) === 0) return ['', '', '']
  const modes = s[S.AP_MODES] | 0
  const at = (modes & ApModes.AUTOTHROTTLE) !== 0
  const phase = phaseName(s[S.AP_PHASE])
  const lateral = AP_LATERAL[s[S.AP_LATERAL] | 0] ?? ''
  const spd = at ? 'SPD' : ''
  const n1 = at ? 'N1' : ''
  const lnav = lateral === 'LOC' ? 'VOR/LOC' : lateral === 'RWY HDG' ? 'HDG SEL' : 'LNAV'
  switch (phase) {
    case 'HDG/ALT HOLD':
      return [spd, modes & ApModes.HEADING ? 'HDG SEL' : 'ROLL', modes & ApModes.ALTITUDE ? 'ALT HOLD' : 'V/S']
    case 'TAXI':
    case 'LINE UP':
      return ['', 'TAXI', '']
    case 'TAKEOFF':
    case 'ROTATE':
    case 'GO-AROUND':
      return [n1, 'TO/GA', 'TO/GA']
    case 'INITIAL CLIMB':
      return [n1, lnav, 'TO/GA']
    case 'CLIMB':
      return [spd, lnav, 'VNAV SPD']
    case 'CRUISE':
    case 'DESCENT':
      return [spd, lnav, 'VNAV PTH']
    case 'APPROACH':
      return [spd, lnav, 'VNAV ALT']
    case 'FINAL':
      return [spd, 'VOR/LOC', 'G/S']
    case 'FLARE':
      return [at ? 'RETARD' : '', 'VOR/LOC', 'FLARE']
    case 'ROLLOUT':
      return ['', 'ROLLOUT', '']
    default:
      return ['', '', '']
  }
}
