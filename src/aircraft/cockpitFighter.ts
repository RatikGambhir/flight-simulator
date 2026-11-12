// Single-seat fighter cockpit: a conformal head-up display on the combiner
// glass, two multifunction displays, side-stick on the right console and the
// throttle on the left, ejection seat and the canopy bow behind the pilot.
// Coordinates are metres in model space (x right, y up, nose toward -z).

import { BoxGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, TorusGeometry, Vector3, type Material, type Object3D } from 'three'
import { ApModes, Flags, S } from '../sim/protocol'
import type { Cockpit } from './cockpit'
import { drawND, InstrumentCanvas } from './instruments'
import type { AircraftModel } from './models'

/** Throttle lever position where the afterburner range starts (sim-core `f16.afterburner_detent`). */
const AB_DETENT = 0.8

/** Combiner glass size and distance from the eye (m). */
const HUD_W = 0.28
const HUD_H = 0.22
const HUD_DIST = 0.56
const HUD_PX_W = 700
const HUD_PX_H = 550
/** Canvas pixels per degree, so the symbology overlays the real world. */
const HUD_PPD = HUD_PX_W / ((2 * Math.atan(HUD_W / 2 / HUD_DIST) * 180) / Math.PI)

const HUD_GREEN = '#3dff86'
const DEG = Math.PI / 180

const font = (px: number, weight = 600) => `${weight} ${px}px "SF Mono", "Menlo", "Roboto Mono", monospace`

/** Head-up display: pitch ladder, flight path marker, speed, altitude, heading, g and Mach. */
function drawHud(g: CanvasRenderingContext2D, s: Float64Array, w: number, h: number) {
  g.clearRect(0, 0, w, h)
  // A faint dark halo keeps the symbology legible against bright cloud.
  g.shadowColor = 'rgba(0, 30, 10, 0.55)'
  g.shadowBlur = 3
  const cx = w / 2
  const cy = h / 2
  const ppd = HUD_PPD
  const flags = s[S.FLAGS] | 0
  g.strokeStyle = HUD_GREEN
  g.fillStyle = HUD_GREEN
  g.lineWidth = 4.5
  g.textBaseline = 'middle'

  // Pitch ladder (rotates with bank, conformal with the horizon).
  g.save()
  g.beginPath()
  g.rect(w * 0.18, h * 0.12, w * 0.64, h * 0.74)
  g.clip()
  g.translate(cx, cy)
  g.rotate(-s[S.ROLL] * DEG)
  const pitch = s[S.PITCH]
  g.font = font(26, 700)
  for (let p = -90; p <= 90; p += 5) {
    const y = (pitch - p) * ppd
    if (Math.abs(y) > h) continue
    if (p === 0) {
      g.beginPath()
      g.moveTo(-w * 0.45, y)
      g.lineTo(-w * 0.06, y)
      g.moveTo(w * 0.06, y)
      g.lineTo(w * 0.45, y)
      g.stroke()
      continue
    }
    const half = w * 0.13
    const gap = w * 0.045
    const tick = p > 0 ? 9 : -9
    g.setLineDash(p < 0 ? [8, 6] : [])
    g.beginPath()
    g.moveTo(-half, y + tick)
    g.lineTo(-half, y)
    g.lineTo(-gap, y)
    g.moveTo(gap, y)
    g.lineTo(half, y)
    g.lineTo(half, y + tick)
    g.stroke()
    g.setLineDash([])
    g.textAlign = 'right'
    g.fillText(String(Math.abs(p)), -half - 5, y)
    g.textAlign = 'left'
    g.fillText(String(Math.abs(p)), half + 5, y)
  }
  g.restore()

  // Boresight cross (gun cross) and flight path marker (where the jet is going).
  g.beginPath()
  g.moveTo(cx - 10, cy)
  g.lineTo(cx + 10, cy)
  g.moveTo(cx, cy - 10)
  g.lineTo(cx, cy + 10)
  g.stroke()
  const alpha = s[S.ALPHA]
  const fy = cy + Math.max(-8, Math.min(14, alpha)) * ppd
  g.beginPath()
  g.arc(cx, fy, 12, 0, Math.PI * 2)
  g.moveTo(cx - 12, fy)
  g.lineTo(cx - 34, fy)
  g.moveTo(cx + 12, fy)
  g.lineTo(cx + 34, fy)
  g.moveTo(cx, fy - 12)
  g.lineTo(cx, fy - 24)
  g.stroke()

  // Heading tape across the top.
  const hdg = s[S.HEADING]
  g.save()
  g.beginPath()
  g.rect(w * 0.22, 0, w * 0.56, h * 0.13)
  g.clip()
  g.font = font(26, 700)
  g.textAlign = 'center'
  for (let d = Math.floor(hdg / 5) * 5 - 25; d <= hdg + 25; d += 5) {
    const x = cx + (d - hdg) * ppd * 0.6
    g.beginPath()
    g.moveTo(x, h * 0.115)
    g.lineTo(x, h * 0.115 - (d % 10 === 0 ? 14 : 7))
    g.stroke()
    if (d % 10 === 0) g.fillText(String((((d % 360) + 360) % 360) / 10).padStart(2, '0'), x, h * 0.045)
  }
  g.restore()
  g.beginPath()
  g.moveTo(cx, h * 0.125)
  g.lineTo(cx - 8, h * 0.15)
  g.lineTo(cx + 8, h * 0.15)
  g.closePath()
  g.stroke()

  // Airspeed (left) and altitude (right) boxes.
  g.font = font(34, 700)
  const box = (x: number, text: string, align: CanvasTextAlign) => {
    g.strokeRect(x, cy - 24, w * 0.15, 48)
    g.textAlign = align
    g.fillText(text, align === 'right' ? x + w * 0.15 - 6 : x + 6, cy + 1)
  }
  box(w * 0.02, String(Math.round(s[S.IAS_KT])), 'right')
  const alt = Math.round(s[S.ALT_MSL_FT] / 10) * 10
  box(w * 0.83, alt.toLocaleString('en-US'), 'right')
  g.font = font(26, 700)
  g.textAlign = 'left'
  g.fillText(`M ${s[S.MACH].toFixed(2)}`, w * 0.02, cy + 58)
  g.fillText(`G ${s[S.NZ].toFixed(1)}`, w * 0.02, cy + 92)
  g.fillText(`α ${alpha.toFixed(1)}`, w * 0.02, cy + 126)
  const vs = s[S.VS_FPM]
  g.textAlign = 'right'
  g.fillText(`${vs >= 0 ? '+' : ''}${Math.round(vs / 100) * 100}`, w * 0.98, cy + 58)
  if (s[S.GEAR] > 0.5) g.fillText('GEAR', w * 0.98, cy + 92)
  if (s[S.AFTERBURNER] > 0) g.fillText('AB', w * 0.98, cy + 126)
  if (flags & Flags.AP_ENGAGED) {
    const m = s[S.AP_MODES] | 0
    g.textAlign = 'center'
    g.fillText(`AP ${m & ApModes.ALTITUDE ? 'ALT' : ''} ${m & ApModes.HEADING ? 'HDG' : ''}`.trim(), cx, h * 0.9)
  }
  // Warnings.
  g.font = font(36, 800)
  g.textAlign = 'center'
  if (flags & Flags.STALL) g.fillText('AOA', cx, h * 0.24)
  else if (flags & Flags.OVERSPEED) g.fillText('OVERSPEED', cx, h * 0.24)
  else if (s[S.NZ] > 8.5) g.fillText('OVER-G', cx, h * 0.24)
}

/** Engine and status page for the left display. */
function drawEnginePage(g: CanvasRenderingContext2D, s: Float64Array, w: number, h: number) {
  g.fillStyle = '#04070a'
  g.fillRect(0, 0, w, h)
  const eng = s[S.ENGINE]
  const ab = s[S.AFTERBURNER]
  const dry = Math.min(1, eng / AB_DETENT)
  const rpm = 68 + 32 * dry
  // Nozzle: open at idle, closes toward military power, opens wide in afterburner.
  const noz = ab > 0 ? 25 + 75 * ab : 85 - 80 * dry
  const ftit = 480 + 450 * dry * dry + 20 * ab
  const ff = 900 + 9_000 * dry * dry + 45_000 * ab
  const row = (label: string, value: string, y: number, color = '#3dff86') => {
    g.fillStyle = '#9fb2c4'
    g.font = font(h * 0.055)
    g.textAlign = 'left'
    g.fillText(label, w * 0.08, y)
    g.fillStyle = color
    g.font = font(h * 0.07, 700)
    g.textAlign = 'right'
    g.fillText(value, w * 0.92, y)
  }
  g.textBaseline = 'middle'
  g.fillStyle = '#3dff86'
  g.font = font(h * 0.06, 700)
  g.textAlign = 'center'
  g.fillText('ENGINE', w / 2, h * 0.08)
  row('RPM', `${Math.round(rpm)}%`, h * 0.2)
  row('NOZ POS', `${Math.round(noz)}%`, h * 0.31)
  row('FTIT', `${Math.round(ftit)}°C`, h * 0.42, ftit > 900 ? '#ffb020' : '#3dff86')
  row('FUEL FLOW', `${Math.round(ff / 100) * 100}`, h * 0.53)
  row('AFTERBURNER', ab > 0 ? `ZONE ${Math.max(1, Math.ceil(ab * 5))}` : 'OFF', h * 0.64, ab > 0 ? '#ffb020' : '#3dff86')
  const gear = s[S.GEAR]
  row('GEAR', gear > 0.99 ? 'DOWN' : gear < 0.01 ? 'UP' : 'TRANSIT', h * 0.77, gear > 0.01 && gear < 0.99 ? '#ffb020' : '#3dff86')
  row('SPD BRK', s[S.SPOILERS] > 0.05 ? 'OPEN' : 'CLOSED', h * 0.88, s[S.SPOILERS] > 0.05 ? '#ffb020' : '#3dff86')
}

function box(w: number, h: number, d: number, mat: Material, parent: Object3D, x: number, y: number, z: number, rx = 0) {
  const m = new Mesh(new BoxGeometry(w, h, d), mat)
  m.position.set(x, y, z)
  m.rotation.x = rx
  m.castShadow = true
  m.receiveShadow = true
  parent.add(m)
  return m
}

function screen(tex: InstrumentCanvas, w: number, h: number, parent: Object3D, pos: Vector3, tilt: number) {
  const mat = new MeshStandardMaterial({ map: tex.texture, emissive: '#ffffff', emissiveMap: tex.texture, emissiveIntensity: 0.9, roughness: 0.3 })
  const m = new Mesh(new PlaneGeometry(w, h), mat)
  m.position.copy(pos)
  m.rotation.x = tilt
  parent.add(m)
  return m
}

export function buildFighterCockpit(model: AircraftModel): Cockpit {
  const root = new Group()
  root.name = 'cockpit'
  const E = model.eye
  const shell = new MeshStandardMaterial({ color: '#30353b', roughness: 0.9, metalness: 0.05, side: DoubleSide, envMapIntensity: 0.3 })
  const panelMat = new MeshStandardMaterial({ color: '#23272c', roughness: 0.8, metalness: 0.1, envMapIntensity: 0.3 })
  const glare = new MeshStandardMaterial({ color: '#0f1012', roughness: 0.97, envMapIntensity: 0.2 })
  const blackMat = new MeshStandardMaterial({ color: '#111214', roughness: 0.6, metalness: 0.3 })
  const seatMat = new MeshStandardMaterial({ color: '#3a3f2e', roughness: 0.92 })
  const frameMat = new MeshStandardMaterial({ color: '#2c3136', roughness: 0.6, metalness: 0.3 })
  const instruments: InstrumentCanvas[] = []

  // Tub: floor, side walls up to the canopy sill and the side consoles.
  const floorY = E.y - 0.95
  const sillY = E.y - 0.28
  box(0.8, 0.04, 1.8, shell, root, 0, floorY, E.z - 0.25)
  for (const sx of [1, -1]) {
    box(0.04, sillY - floorY, 1.8, shell, root, 0.4 * sx, (sillY + floorY) / 2, E.z - 0.25)
    box(0.16, 0.05, 0.85, panelMat, root, 0.3 * sx, E.y - 0.5, E.z - 0.05)
    box(0.16, E.y - 0.5 - floorY, 0.85, shell, root, 0.3 * sx, (E.y - 0.5 + floorY) / 2, E.z - 0.05)
    // Canopy rails.
    box(0.05, 0.05, 1.4, frameMat, root, 0.42 * sx, sillY, E.z - 0.1)
  }

  // Instrument panel, glare shield and the nose bulkhead under it.
  const zPanel = E.z - 0.72
  box(0.66, 0.3, 0.05, panelMat, root, 0, E.y - 0.36, zPanel, -0.15)
  box(0.56, 0.025, 0.16, glare, root, 0, E.y - 0.2, zPanel + 0.04)
  box(0.7, E.y - 0.5 - floorY, 0.04, shell, root, 0, (E.y - 0.5 + floorY) / 2, zPanel - 0.02)
  // Up-front controls below the HUD.
  box(0.15, 0.07, 0.06, blackMat, root, 0, E.y - 0.24, E.z - HUD_DIST + 0.02, -0.3)

  // Multifunction displays.
  const left = new InstrumentCanvas(512, 512, drawEnginePage)
  const right = new InstrumentCanvas(512, 512, drawND)
  instruments.push(left, right)
  screen(left, 0.13, 0.13, root, new Vector3(-0.18, E.y - 0.37, zPanel + 0.03), -0.15)
  screen(right, 0.13, 0.13, root, new Vector3(0.18, E.y - 0.37, zPanel + 0.03), -0.15)

  // HUD: frame posts and the combiner glass with conformal symbology.
  const hudZ = E.z - HUD_DIST
  // Frame posts up to a thin top bar around the combiner glass.
  const postBottom = E.y - 0.2
  const postTop = E.y + HUD_H / 2 + 0.01
  for (const sx of [1, -1]) box(0.012, postTop - postBottom, 0.012, frameMat, root, (HUD_W / 2 + 0.01) * sx, (postTop + postBottom) / 2, hudZ)
  box(HUD_W + 0.032, 0.012, 0.012, frameMat, root, 0, postTop, hudZ)
  const hud = new InstrumentCanvas(HUD_PX_W, HUD_PX_H, drawHud)
  instruments.push(hud)
  const hudMat = new MeshBasicMaterial({ map: hud.texture, transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false })
  const combiner = new Mesh(new PlaneGeometry(HUD_W, HUD_H), hudMat)
  combiner.position.set(0, E.y, hudZ)
  combiner.renderOrder = 10
  root.add(combiner)

  // Side-stick (right console) and throttle (left console).
  const stick = new Group()
  stick.position.set(0.3, E.y - 0.47, E.z - 0.12)
  root.add(stick)
  box(0.035, 0.11, 0.045, blackMat, stick, 0, 0.055, 0)
  box(0.03, 0.025, 0.03, blackMat, stick, 0, 0.12, -0.01)
  const throttle = new Group()
  throttle.position.set(-0.3, E.y - 0.47, E.z - 0.05)
  root.add(throttle)
  box(0.025, 0.12, 0.025, blackMat, throttle, 0, 0.06, 0)
  box(0.05, 0.05, 0.07, blackMat, throttle, 0, 0.13, 0)

  // Ejection seat: pan, reclined back and headrest behind the pilot.
  const seat = new Group()
  seat.position.set(0, floorY, E.z + 0.25)
  root.add(seat)
  box(0.42, 0.1, 0.45, seatMat, seat, 0, 0.42, -0.1)
  box(0.42, 0.8, 0.1, seatMat, seat, 0, 0.85, 0.12, -0.3)
  box(0.3, 0.25, 0.14, blackMat, seat, 0, 1.12 + 0.2, 0.32, -0.3)

  // Canopy bow behind the pilot's head.
  const bow = new Mesh(new TorusGeometry(0.44, 0.022, 8, 40, Math.PI), frameMat)
  bow.position.set(0, sillY, E.z + 0.6)
  root.add(bow)

  root.traverse((o) => o.layers.enableAll())
  // Transparent glass must stay out of the lighting-mask layer: the mask pass
  // draws with a depth-writing override, which would leave the scenery behind
  // the combiner unlit (see OverlayPass). Layer 0 alone renders it normally.
  combiner.layers.set(0)

  let lastDraw = 0
  return {
    root,
    instruments,
    yoke: null,
    stick,
    throttles: [throttle],
    update(s, c) {
      const now = performance.now()
      if (now - lastDraw > 33) {
        lastDraw = now
        for (const i of instruments) i.update(s)
      }
      // The real side-stick barely moves (it senses force); show a little travel.
      stick.rotation.x = -c.pitch * 0.12
      stick.rotation.z = -c.roll * 0.12
      throttle.rotation.x = -0.45 + c.throttle * 0.9
    },
    dispose() {
      for (const i of instruments) i.dispose()
      hudMat.dispose()
    },
  }
}
