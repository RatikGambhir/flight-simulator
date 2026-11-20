import { useSyncExternalStore } from 'react'
import { S } from './protocol'
import { sim } from './simClient'

const phase = () => sim.latest[S.SHUTTLE_PHASE]

/** React only rerenders when the mission changes between launch, orbit and runway flight. */
export function useShuttlePhase() {
  return useSyncExternalStore(sim.subscribeSnapshots, phase)
}
