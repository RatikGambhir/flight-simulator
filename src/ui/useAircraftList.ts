import { useEffect, useState } from 'react'
import { sim } from '../sim/simClient'
import type { AircraftSpec } from '../sim/protocol'

let cache: AircraftSpec[] | null = null
let pending: Promise<AircraftSpec[]> | null = null

export function loadAircraftList() {
  if (cache) return Promise.resolve(cache)
  pending ??= sim.query<AircraftSpec[]>({ type: 'aircraft_list' }).then((l) => (cache = l))
  return pending
}

export function useAircraftList(): AircraftSpec[] {
  const [list, setList] = useState<AircraftSpec[]>(() => cache ?? [])
  useEffect(() => {
    if (!cache) loadAircraftList().then(setList)
  }, [])
  return list
}
