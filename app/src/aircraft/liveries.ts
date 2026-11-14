// Aircraft picker options, shared by previews and the active aircraft.
export type LiveryId = 'default' | 'delta' | 'united' | 'fedex' | 'ups' | 'amazon'

const AIRLINE_LIVERIES = [
  { id: 'default', label: 'Default' },
  { id: 'delta', label: 'Delta' },
  { id: 'united', label: 'United' },
] as const

const MILITARY = { id: 'default', label: 'U.S. Military' } as const
const LOCKHEED_LIVERIES = [
  MILITARY,
  { id: 'fedex', label: 'FedEx' },
  { id: 'ups', label: 'UPS' },
  { id: 'amazon', label: 'Amazon' },
] as const

export function liveryOptions(aircraft: string): readonly { id: LiveryId; label: string }[] {
  if (aircraft === 'c5m' || aircraft === 'f16') return LOCKHEED_LIVERIES
  if (aircraft === 'c17') return [MILITARY, ...AIRLINE_LIVERIES.slice(1)]
  return AIRLINE_LIVERIES
}
