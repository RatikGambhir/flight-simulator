import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { Vector3 } from 'three'
import { navigationTo } from '../navigation/route'
import { S } from '../sim/protocol'
import { sim } from '../sim/simClient'
import { useApp } from '../state/store'
import { frame, geodeticToEcef } from '../world/frame'

/** Screen-sized beacon projected from the actual airport, including elevation and geoid. */
export function DestinationMarker() {
  const destination = useApp((s) => s.destination)
  const element = useRef<HTMLDivElement>(null)
  const distance = useRef<HTMLSpanElement>(null)
  const host = useThree((s) => s.gl.domElement.parentElement)
  const point = useMemo(() => new Vector3(), [])
  const ecef = useMemo(() => destination ? geodeticToEcef(destination.airport.lat, destination.airport.lon, destination.airport.elevation_ft * 0.3048 + destination.geoid_m) : null, [destination])

  // This component belongs to the Three reconciler; own the small DOM overlay
  // explicitly instead of sending DOM elements through the scene graph.
  useEffect(() => {
    if (!destination || !host) return
    const el = document.createElement('div')
    el.className = 'destination-beacon'
    el.style.display = 'none'
    const label = document.createElement('div')
    label.className = 'beacon-label'
    const name = document.createElement('b')
    name.textContent = `${destination.airport.ident} · ${destination.airport.name}`
    const range = document.createElement('span')
    label.append(name, range)
    const stem = document.createElement('span')
    stem.className = 'beacon-stem'
    const icon = document.createElement('span')
    icon.className = 'beacon-icon'
    icon.textContent = '✈'
    el.append(label, stem, icon)
    host.appendChild(el)
    element.current = el
    distance.current = range
    return () => { el.remove(); element.current = null; distance.current = null }
  }, [destination, host])

  // FlightLoop updates the camera and floating origin at -1; project afterwards.
  useFrame(({ camera, size }) => {
    const el = element.current
    if (!el) return
    const app = useApp.getState()
    if (!ecef || !destination || !sim.render.valid || app.phase !== 'flying' || !app.destinationMarkerVisible || app.pauseMenu || app.routeOpen || app.crashed) {
      el.style.display = 'none'
      return
    }
    camera.updateMatrixWorld()
    frame.ecefToWorld(ecef.x, ecef.y, ecef.z, point).applyMatrix4(camera.matrixWorldInverse)
    const ahead = point.z < -0.3
    point.applyMatrix4(camera.projectionMatrix)
    const visible = ahead && Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1
    el.style.display = visible ? 'flex' : 'none'
    if (!visible) return
    el.style.left = `${(point.x + 1) * size.width / 2}px`
    el.style.top = `${(1 - point.y) * size.height / 2}px`
    const nav = navigationTo({ lat: sim.latest[S.LAT], lon: sim.latest[S.LON] }, destination.airport)
    const label = `${nav.distanceNm.toFixed(1)} NM`
    if (distance.current && distance.current.textContent !== label) distance.current.textContent = label
  }, -0.5)

  return null
}
