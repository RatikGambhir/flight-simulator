// Shares the selected runway with the compass HUD.

import { useFrame } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'
import { angleDelta, navigationTo } from '../navigation/route'
import { landingRunway } from '../navigation/runwayGuide'
import { S, type AirportDetail, type Runway } from '../sim/protocol'
import { sim } from '../sim/simClient'
import { useApp } from '../state/store'

interface Target {
  runway: Runway
  /** Index into runway.ends of the landing threshold. */
  end: 0 | 1
  /** Chosen by the user (a final-approach start) rather than by arrival direction. */
  fixed: boolean
}

function longestRunway(detail: AirportDetail): Runway | null {
  let best: Runway | null = null
  for (const r of detail.runways) if (!best || r.length_ft > best.length_ft) best = r
  return best
}

/** The end to land on when arriving on `bearing` (degrees true, aircraft to airport). */
function endFor(runway: Runway, bearing: number): 0 | 1 {
  const a = Math.abs(angleDelta(runway.ends[0].heading_deg, bearing))
  const b = Math.abs(angleDelta(runway.ends[1].heading_deg, bearing))
  return a <= b ? 0 : 1
}

export function useLandingRunway() {
  const destination = useApp((s) => s.destination)
  const spawn = useApp((s) => s.spawn)
  const runwayAlignment = useApp((s) => s.runwayAlignmentVisible)
  const approachIdent = runwayAlignment && !destination && spawn.kind === 'runway' ? spawn.airport : null
  const [approach, setApproach] = useState<AirportDetail | null>(null)
  useEffect(() => {
    setApproach(null)
    if (!approachIdent) return
    let alive = true
    sim.query<AirportDetail | null>({ type: 'airport', ident: approachIdent }).then((d) => alive && setApproach(d)).catch(() => {})
    return () => {
      alive = false
    }
  }, [approachIdent])
  const detail = runwayAlignment ? destination ?? approach : null
  // Guide to the runway the autopilot is landing on when it has chosen one;
  // otherwise to the runway a final-approach start lined up with.
  const autopilotRunway = useApp((s) => s.autopilotRunway)
  const fixedRunway =
    autopilotRunway && detail && autopilotRunway.airport === detail.airport.ident
      ? autopilotRunway.runway
      : !destination && spawn.kind === 'runway'
        ? spawn.runway
        : null

  const [target, setTarget] = useState<Target | null>(null)
  const lastPick = useRef(-Infinity)

  // Pick the runway once per airport; the landing end is re-picked in flight.
  useEffect(() => {
    lastPick.current = -Infinity
    if (!detail) return setTarget(null)
    if (fixedRunway) {
      for (const runway of detail.runways) {
        const end = runway.ends.findIndex((e) => e.ident === fixedRunway)
        if (end >= 0) return setTarget({ runway, end: end as 0 | 1, fixed: true })
      }
    }
    const runway = longestRunway(detail)
    setTarget(runway ? { runway, end: 0, fixed: false } : null)
  }, [detail, fixedRunway])

  // Tell the HUD compass which runway we are guiding to.
  useEffect(() => {
    if (!target) return
    const near = target.runway.ends[target.end]
    const far = target.runway.ends[1 - target.end]
    landingRunway.current = { ident: near.ident, near: { lat: near.lat, lon: near.lon }, far: { lat: far.lat, lon: far.lon }, lengthM: target.runway.length_ft * 0.3048 }
    return () => {
      landingRunway.current = null
    }
  }, [target])

  useFrame(() => {
    if (!target || !detail || target.fixed || !sim.render.valid || useApp.getState().phase !== 'flying') return
    const now = performance.now()
    if (now - lastPick.current <= 3000) return
    const s = sim.latest
    const position = { lat: s[S.LAT], lon: s[S.LON] }
    if (navigationTo(position, target.runway.ends[target.end]).distanceNm <= 5) return
    lastPick.current = now
    const end = endFor(target.runway, navigationTo(position, detail.airport).bearing)
    if (end !== target.end) setTarget({ ...target, end })
  }, -0.5)
}
