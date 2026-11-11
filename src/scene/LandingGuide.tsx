// Landing guide for the arrival runway, drawn in the world rather than on the HUD.
//
//  far    — a tall beam of light standing on the touchdown point, sized to stay
//           visible from tens of miles out.
//  near   — the beam fades and the precise cues take over: the runway edges,
//           the threshold, a touchdown zone painted on the surface, and a row
//           of gates down a 3 degree glidepath to fly through.
//
// The runway comes from the destination (longest runway, landing in the
// direction we are arriving from) or from a "final approach" start. Its height
// starts from the airport data and is refined against the streamed terrain as
// we get close, so the markings sit on the surface that is actually drawn.

import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import { BoxGeometry, type BufferGeometry, Color, CylinderGeometry, DoubleSide, Group, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, Vector3 } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { angleDelta, navigationTo } from '../navigation/route'
import { landingRunway } from '../navigation/runwayGuide'
import { Flags, S, type AirportDetail, type Runway, type RunwayEnd } from '../sim/protocol'
import { sim } from '../sim/simClient'
import { useApp } from '../state/store'
import { frame, geodeticToEcef } from '../world/frame'
import type { WorldSystem } from '../world/worldSystem'
import type { OverlayPass } from './OverlayPass'

const FT = 0.3048
const NM = 1852
const GLIDE = Math.tan((3 * Math.PI) / 180)
/** Aim point: this far past the landing threshold. */
const AIM_M = 300
const TDZ_LENGTH_M = 300
const GATE_SPACING_M = 600
const GATE_COUNT = 10
/** Markings float this far above the surface so photogrammetry noise does not swallow them. */
const LIFT_M = 1.2
const SHOW_WITHIN_M = 90_000
/** The beam hands over to the surface markings between these ranges. */
const BEAM_FADE_NEAR_M = 1500
const BEAM_FADE_FAR_M = 5000
/** The scene is rendered in physical radiance with a high exposure; unlit colours must be dim. */
const GLOW = 0.07

interface Target {
  airport: string
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

function endHeight(end: RunwayEnd, detail: AirportDetail) {
  return (end.elevation_ft ?? detail.airport.elevation_ft) * FT + detail.geoid_m
}

/** One hollow rectangular gate on the glidepath, `d` metres before the aim point, centred on its own origin. */
function buildGate(d: number): BufferGeometry {
  const w = 70 + d * 0.012
  const h = w * 0.55
  const t = 1 + d * 0.0009
  const parts = [
    new BoxGeometry(w + t, t, t).translate(0, h / 2, 0),
    new BoxGeometry(w + t, t, t).translate(0, -h / 2, 0),
    new BoxGeometry(t, h, t).translate(-w / 2, 0, 0),
    new BoxGeometry(t, h, t).translate(w / 2, 0, 0),
  ]
  const merged = mergeGeometries(parts)
  parts.forEach((p) => p.dispose())
  return merged
}

const _a = new Vector3()
const _b = new Vector3()
const _f = new Vector3()
const _r = new Vector3()
const _up = new Vector3()
const _e = new Vector3()
const _n = new Vector3()
const _m = new Matrix4()

export function LandingGuide({ world, overlay }: { world: WorldSystem | null; overlay: OverlayPass }) {
  const destination = useApp((s) => s.destination)
  const spawn = useApp((s) => s.spawn)
  // A flight started on final approach has a runway to land on even without a destination.
  const approachIdent = !destination && spawn.kind === 'runway' && spawn.mode !== 'takeoff' ? spawn.airport : null
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
  const detail = destination ?? approach
  const fixedRunway = !destination && spawn.kind === 'runway' ? spawn.runway : null

  const [target, setTarget] = useState<Target | null>(null)
  const live = useRef({ lastPick: -1e9, lastProbe: -1e9, heights: null as [number, number] | null, refined: false, time: 0 })

  // Pick the runway once per airport; the landing end is re-picked in flight.
  useEffect(() => {
    live.current.lastPick = -1e9
    if (!detail) return setTarget(null)
    if (fixedRunway) {
      for (const runway of detail.runways) {
        const end = runway.ends.findIndex((e) => e.ident === fixedRunway)
        if (end >= 0) return setTarget({ airport: detail.airport.ident, runway, end: end as 0 | 1, fixed: true })
      }
    }
    const runway = longestRunway(detail)
    setTarget(runway ? { airport: detail.airport.ident, runway, end: 0, fixed: false } : null)
  }, [detail, fixedRunway])

  // Tell the HUD compass which runway we are guiding to.
  useEffect(() => {
    if (!target) return
    const near = target.runway.ends[target.end]
    const far = target.runway.ends[1 - target.end]
    landingRunway.current = { ident: near.ident, near: { lat: near.lat, lon: near.lon }, far: { lat: far.lat, lon: far.lon }, lengthM: target.runway.length_ft * FT }
    return () => {
      landingRunway.current = null
    }
  }, [target])

  const parts = useMemo(() => {
    if (!target) return null
    const { runway } = target
    const length = runway.length_ft * FT
    const width = Math.max(18, runway.width_ft * FT)
    const displaced = runway.ends[target.end].displaced_threshold_ft * FT
    const aimZ = -(displaced + AIM_M)
    const tint = new Color('#12ff8e').multiplyScalar(GLOW)
    const material = (opacity: number) => {
      const m = new MeshBasicMaterial({ color: tint, transparent: true, opacity, depthWrite: false, side: DoubleSide, fog: false })
      overlay.prepare(m)
      return m
    }
    const root = new Group()
    root.name = 'Landing guide'
    root.matrixAutoUpdate = false
    root.visible = false

    const edgeGeometry = new BoxGeometry(1, 0.4, length).translate(0, 0, -length / 2)
    const edges = material(0.85)
    const left = new Mesh(edgeGeometry, edges)
    left.position.x = -width / 2
    const right = new Mesh(edgeGeometry, edges)
    right.position.x = width / 2
    const threshold = new Mesh(new BoxGeometry(width, 0.4, 8).translate(0, 0, -displaced), edges)

    const zone = new Mesh(new PlaneGeometry(width * 0.82, TDZ_LENGTH_M).rotateX(-Math.PI / 2).translate(0, 0.3, aimZ), material(0.5))
    // Gates down the glidepath, in the guide's local frame (-Z runs down the runway).
    const gates: Mesh[] = []
    for (let i = 1; i <= GATE_COUNT; i++) {
      const d = i * GATE_SPACING_M
      const gate = new Mesh(buildGate(d), material(0.8))
      gate.position.set(0, d * GLIDE, aimZ + d)
      gates.push(gate)
    }
    // Open cylinder of unit radius and height, standing on the aim point.
    const beam = new Mesh(new CylinderGeometry(1, 1, 1, 16, 1, true).translate(0, 0.5, 0), material(0.6))
    beam.position.z = aimZ

    root.add(left, right, threshold, zone, beam, ...gates)
    // Unlit guide: drawn by the overlay pass after the post-process sun, sky and night lighting.
    root.traverse((o) => {
      o.frustumCulled = false
      o.renderOrder = 5
    })
    return { root, left, right, zone, gates, beam, length }
  }, [target, overlay])

  useEffect(() => {
    live.current.heights = null
    live.current.refined = false
    if (!parts) return
    overlay.overlay.add(parts.root)
    return () => {
      overlay.overlay.remove(parts.root)
      parts.root.traverse((o) => {
        const mesh = o as Mesh
        if (!mesh.isMesh) return
        mesh.geometry.dispose()
        ;(mesh.material as MeshBasicMaterial).dispose()
      })
    }
  }, [parts, overlay])

  // After FlightLoop (-1) has moved the floating origin and camera.
  useFrame(({ camera }, dt) => {
    if (!parts || !target || !detail) return
    const st = live.current
    const app = useApp.getState()
    const s = sim.latest
    const near = target.runway.ends[target.end]
    const far = target.runway.ends[1 - target.end]
    const nav = navigationTo({ lat: s[S.LAT], lon: s[S.LON] }, near)
    const range = nav.distanceNm * NM
    const flags = s[S.FLAGS] | 0
    // Rolled out and slowed down: the job is done.
    const landed = (flags & Flags.ON_GROUND) !== 0 && s[S.GS_KT] < 40
    const show = sim.render.valid && app.phase === 'flying' && !app.crashed && range < SHOW_WITHIN_M && !landed
    parts.root.visible = show
    if (!show) return

    const now = performance.now()
    // Land in the direction we are arriving from; stop reconsidering once established.
    if (!target.fixed && range > 5 * NM && now - st.lastPick > 3000) {
      st.lastPick = now
      const end = endFor(target.runway, navigationTo({ lat: s[S.LAT], lon: s[S.LON] }, detail.airport).bearing)
      if (end !== target.end) {
        setTarget({ ...target, end })
        return
      }
    }

    // Surface heights: airport data until the terrain near the runway is detailed enough to measure.
    if (!st.heights) st.heights = [endHeight(near, detail), endHeight(far, detail)]
    if (world && range < 12_000 && now - st.lastProbe > (st.refined ? 4000 : 1000)) {
      st.lastProbe = now
      const hn = world.probeGround(near.lat, near.lon, st.heights[0] + 400, 1500)
      const hf = world.probeGround(far.lat, far.lon, st.heights[1] + 400, 1500)
      if (hn && hf && hn.error <= 6 && hf.error <= 6) {
        st.heights = [hn.height, hf.height]
        st.refined = true
      }
    }

    // Local frame at the landing threshold: -Z down the runway, +Y up.
    geodeticToEcef(near.lat, near.lon, st.heights[0] + LIFT_M, _a)
    frame.ecefToWorld(_a.x, _a.y, _a.z, _a)
    geodeticToEcef(far.lat, far.lon, st.heights[1] + LIFT_M, _b)
    frame.ecefToWorld(_b.x, _b.y, _b.z, _b)
    frame.enuInWorld(near.lat, near.lon, _e, _n, _up)
    _f.subVectors(_b, _a).normalize()
    _r.crossVectors(_f, _up).normalize()
    _up.crossVectors(_r, _f)
    parts.root.matrix.copy(_m.makeBasis(_r, _up, _f.negate()).setPosition(_a))
    parts.root.updateMatrixWorld(true)

    // Scale the cues with range so each stays readable without hiding the runway.
    const eye = camera.position.distanceTo(_a)
    const edge = Math.min(40, Math.max(1.5, eye * 0.0026))
    parts.left.scale.x = parts.right.scale.x = edge
    const beamFade = Math.min(1, Math.max(0, (eye - BEAM_FADE_NEAR_M) / (BEAM_FADE_FAR_M - BEAM_FADE_NEAR_M)))
    parts.beam.visible = beamFade > 0.01
    const radius = Math.max(6, eye * 0.004)
    parts.beam.scale.set(radius, Math.max(400, eye * 0.05), radius)
    ;(parts.beam.material as MeshBasicMaterial).opacity = 0.6 * beamFade
    // Gates appear as the approach begins.
    const approach = 0.8 * Math.min(1, Math.max(0, (22_000 - eye) / 6000))
    for (const gate of parts.gates) {
      // A gate melts away as we fly through it instead of filling the view.
      const d = gate.getWorldPosition(_b).distanceTo(camera.position)
      const o = approach * Math.min(1, Math.max(0, (d - 250) / 700))
      gate.visible = o > 0.01
      ;(gate.material as MeshBasicMaterial).opacity = o
    }
    // The touchdown zone breathes to catch the eye.
    st.time += dt
    ;(parts.zone.material as MeshBasicMaterial).opacity = 0.34 + 0.12 * Math.sin(st.time * 3)
  }, -0.5)

  return null
}
