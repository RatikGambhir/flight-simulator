import { BoxGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry } from 'three'
import type { Cockpit } from './cockpit'
import { InstrumentCanvas } from './instruments'
import type { AircraftModel } from './models'
import { S } from '../sim/protocol'

/** Simplified Shuttle glass flight deck with live orbital instruments. */
export function buildEndeavourCockpit(model: AircraftModel): Cockpit {
  const root = new Group(); root.name = 'cockpit'; root.position.copy(model.eye)
  const panelMat = new MeshStandardMaterial({ color: '#4c535e', roughness: 0.9 })
  function box(w: number, h: number, d: number, x: number, y: number, z: number) {
    const m = new Mesh(new BoxGeometry(w, h, d), panelMat); m.position.set(x, y, z); root.add(m); return m
  }
  box(3.9, 1.2, 0.2, 0.6, -0.55, -2.9)
  box(3.9, 0.08, 1.8, 0.6, -1.25, -0.4)
  for (const x of [-1.3, 0.6, 2.5]) box(0.055, 1.4, 0.055, x, 0.3, -1.65)
  box(3.9, 0.065, 0.065, 0.6, 0.97, -1.65)
  const display = new InstrumentCanvas(1200, 360, (g, s, w, h) => {
    g.fillStyle = '#080e13'; g.fillRect(0, 0, w, h)
    const runway = s[S.SHUTTLE_PHASE] === 6
    g.font = '22px monospace'; g.fillStyle = '#90cacc'; g.fillText(`ENDEAVOUR  OV-105       ${runway ? 'RUNWAY' : 'ORBITAL'} FLIGHT SYSTEM`, 30, 42)
    const range = Math.hypot(s[S.ISS_X] - s[S.ECEF_X], s[S.ISS_Y] - s[S.ECEF_Y], s[S.ISS_Z] - s[S.ECEF_Z])
    const values = [
      ['ALTITUDE', runway ? `${Math.round(s[S.ALT_MSL_FT])} ft` : `${(s[S.ALT_MSL_FT] * 0.3048 / 1000).toFixed(1)} km`],
      [runway ? 'AIRSPEED' : 'VELOCITY', runway ? `${Math.round(s[S.IAS_KT])} kt` : `${(s[S.ORBITAL_SPEED] / 1000).toFixed(3)} km/s`],
      [runway ? 'LANDING GEAR' : 'ISS RANGE', runway ? s[S.GEAR] > 0.99 ? 'DOWN' : 'TRANSIT / UP' : `${(range / 1000).toFixed(3)} km`],
      ['GRAVITY', `${(runway ? 9.80665 : s[S.LOCAL_GRAVITY]).toFixed(2)} m/s²`],
      ['FELT LOAD', `${Math.hypot(s[S.NX], s[S.NY], s[S.NZ]).toFixed(3)} g`],
      [runway ? 'ASSIST THRUST' : 'OMS THRUST', `${Math.round(s[S.ENGINE] * 100)} %`],
    ]
    values.forEach(([label, value], i) => {
      const x = 30 + (i % 3) * 400; const y = 105 + Math.floor(i / 3) * 125
      g.fillStyle = '#91abae'; g.font = '20px monospace'; g.fillText(label, x, y)
      g.fillStyle = '#e3f4dc'; g.font = '36px monospace'; g.fillText(value, x, y + 52)
    })
  })
  display.update(new Float64Array(S.LEN))
  const face = new Mesh(new PlaneGeometry(3.6, 1.08), new MeshBasicMaterial({ map: display.texture, toneMapped: false }))
  face.name = 'endeavour-orbital-instruments'; face.position.set(0.6, -0.55, -2.785); root.add(face)
  const stick = new Group(); stick.position.set(0, -0.9, -0.5); root.add(stick)
  const handle = new Mesh(new BoxGeometry(0.07, 0.35, 0.1), panelMat); stick.add(handle)
  let nextDraw = 0
  root.traverse((o) => o.layers.enableAll())
  return { root, instruments: [display], yoke: null, stick, throttles: [],
    update(s, input) {
      const now = performance.now()
      if (now >= nextDraw) { display.update(s); nextDraw = now + 100 }
      stick.rotation.set(-input.pitch * 0.2, 0, -input.roll * 0.2)
    }, dispose() { display.dispose() } }
}
