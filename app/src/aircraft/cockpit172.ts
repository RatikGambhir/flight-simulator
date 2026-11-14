// A dedicated interior for the Skyhawk-style high-wing single: steam-gauge
// six-pack, centre radio stack, push-pull throttle and mixture, ram's-horn
// yokes, a one-piece windshield under the wing and a whiskey compass.
// Coordinates are metres in model space (x right, y up, nose toward -z).

import {
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
  type Texture,
} from 'three'
import { S, type SimCommand } from '../sim/protocol'
import type { Cockpit } from './cockpit'
import { drawGaEngine, drawSixPack, drawWhiskeyCompass, GA_PANEL, InstrumentCanvas } from './instruments'
import type { AircraftModel } from './models'

const PANEL_W = 1.06
const PANEL_H = 0.46
const CW = 2048
const CH = 888
/** Canvas pixels per metre of panel. */
const K = CW / PANEL_W
const INK = '#e6e6df'

/**
 * Paints the fixed part of the panel. Positions are metres: `x` from the
 * panel centreline, `d` down from the top edge.
 */
function paintPanel(): Texture {
  const c = document.createElement('canvas')
  c.width = CW
  c.height = CH
  const g = c.getContext('2d')!
  const X = (x: number) => (x + PANEL_W / 2) * K
  const Y = (d: number) => d * K
  const label = (t: string, x: number, d: number, size = 0.0075, color = INK) => {
    g.fillStyle = color
    g.font = `600 ${size * K}px Arial, sans-serif`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(t, X(x), Y(d))
  }
  const rect = (x0: number, d0: number, x1: number, d1: number, fill: string, stroke?: string, radius = 0.004) => {
    g.beginPath()
    g.roundRect(X(x0), Y(d0), (x1 - x0) * K, (d1 - d0) * K, radius * K)
    g.fillStyle = fill
    g.fill()
    if (stroke) {
      g.strokeStyle = stroke
      g.lineWidth = 2
      g.stroke()
    }
  }
  const disc = (x: number, d: number, r: number, fill: string, stroke?: string, lw = 3) => {
    g.beginPath()
    g.arc(X(x), Y(d), r * K, 0, Math.PI * 2)
    g.fillStyle = fill
    g.fill()
    if (stroke) {
      g.strokeStyle = stroke
      g.lineWidth = lw
      g.stroke()
    }
  }
  const screw = (x: number, d: number) => {
    disc(x, d, 0.0028, '#16181a', '#8d8f8c', 1)
  }
  const gauge = (x: number, d: number, r: number, name: string) => {
    disc(x, d, r * 1.12, '#1a1c1e', '#4a4d50', 2)
    disc(x, d, r, '#0b0c0e', '#555', 4)
    g.strokeStyle = INK
    g.lineWidth = 2
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      g.beginPath()
      g.moveTo(X(x) + Math.sin(a) * r * K * 0.8, Y(d) - Math.cos(a) * r * K * 0.8)
      g.lineTo(X(x) + Math.sin(a) * r * K * 0.94, Y(d) - Math.cos(a) * r * K * 0.94)
      g.stroke()
    }
    label(name, x, d + r * 0.45, r * 0.24, '#ccc')
  }
  const hand = (x: number, d: number, len: number, angle: number, width = 3) => {
    g.strokeStyle = INK
    g.lineWidth = width
    g.lineCap = 'round'
    g.beginPath()
    g.moveTo(X(x), Y(d))
    g.lineTo(X(x) + Math.sin(angle) * len * K, Y(d) - Math.cos(angle) * len * K)
    g.stroke()
  }

  // Painted metal with a lighter lower switch panel.
  g.fillStyle = GA_PANEL
  g.fillRect(0, 0, CW, CH)
  g.fillStyle = '#34373b'
  g.fillRect(0, Y(0.322), CW, CH - Y(0.322))
  g.fillStyle = '#17181a'
  g.fillRect(0, Y(0.32), CW, 3)
  for (const x of [-0.52, -0.3, -0.08, 0.2, 0.52]) for (const d of [0.008, 0.312, 0.332, 0.452]) screw(x, d)

  // Flight instrument cluster recess (the live six-pack sits on top).
  rect(-0.472, 0.014, -0.086, 0.258, '#202224', '#494c50', 0.008)

  // Clock and suction gauge at the far left.
  gauge(-0.501, 0.07, 0.021, 'CLOCK')
  hand(-0.501, 0.07, 0.012, -1.0, 4)
  hand(-0.501, 0.07, 0.017, 0.7)
  gauge(-0.501, 0.16, 0.021, 'SUCT')
  hand(-0.501, 0.16, 0.016, 0.25)
  label('PULL', -0.501, 0.218, 0.0055, '#aaa')
  label('ALT AIR', -0.501, 0.227, 0.0055, '#aaa')
  disc(-0.501, 0.25, 0.008, '#101112', '#666', 2)

  // Two course-deviation indicators beside the six-pack.
  for (const [d, name] of [
    [0.078, 'NAV 1'],
    [0.196, 'NAV 2'],
  ] as const) {
    const x = -0.036
    const r = 0.04
    disc(x, d, r * 1.1, '#1a1c1e', '#4a4d50', 2)
    disc(x, d, r, '#0b0c0e', '#555', 4)
    g.strokeStyle = INK
    g.fillStyle = INK
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2
      g.lineWidth = i % 3 === 0 ? 3 : 1.5
      g.beginPath()
      g.moveTo(X(x) + Math.sin(a) * r * K * (i % 3 === 0 ? 0.8 : 0.86), Y(d) - Math.cos(a) * r * K * (i % 3 === 0 ? 0.8 : 0.86))
      g.lineTo(X(x) + Math.sin(a) * r * K * 0.95, Y(d) - Math.cos(a) * r * K * 0.95)
      g.stroke()
    }
    for (const [t, a] of [['N', 0], ['E', 1], ['S', 2], ['W', 3]] as const) {
      label(t, x + Math.sin((a * Math.PI) / 2) * r * 0.66, d - Math.cos((a * Math.PI) / 2) * r * 0.66, r * 0.2)
    }
    for (let i = -4; i <= 4; i++) if (i !== 0) disc(x + i * r * 0.1, d, 0.0011, INK)
    disc(x, d, r * 0.07, 'rgba(0,0,0,0)', INK, 2)
    g.strokeStyle = '#f4f4ee'
    g.lineWidth = 3
    g.beginPath()
    g.moveTo(X(x + r * 0.06), Y(d - r * 0.5))
    g.lineTo(X(x + r * 0.06), Y(d + r * 0.5))
    g.stroke()
    label(name, x, d + r * 0.42, r * 0.16, '#bbb')
    label('OBS', x - r * 0.9, d + r * 1.02, 0.005, '#aaa')
    disc(x - r * 0.9, d + r * 0.82, 0.006, '#101112', '#666', 2)
  }

  // Centre radio stack.
  const sx0 = 0.03
  const sx1 = 0.19
  const sc = (sx0 + sx1) / 2
  rect(sx0 - 0.004, 0.014, sx1 + 0.004, 0.306, '#1b1c1e', '#4b4e52', 0.004)
  // Audio panel
  rect(sx0, 0.02, sx1, 0.048, '#111214', '#5a5d60', 0.002)
  ;['COM1', 'COM2', 'NAV1', 'NAV2', 'MKR', 'SPKR'].forEach((t, i) => {
    const x = sx0 + 0.016 + i * 0.0256
    rect(x - 0.01, 0.026, x + 0.01, 0.042, i === 0 || i === 5 ? '#254a2c' : '#26292c', '#70747a', 0.0015)
    label(t, x, 0.034, 0.005, i === 0 || i === 5 ? '#b8ffc4' : INK)
  })
  // GPS / COM 1
  rect(sx0, 0.052, sx1, 0.142, '#111214', '#5a5d60', 0.002)
  rect(sx0 + 0.03, 0.058, sx1 - 0.022, 0.136, '#06141f', '#33383d', 0.002)
  g.save()
  g.beginPath()
  g.rect(X(sx0 + 0.03), Y(0.058), (sx1 - sx0 - 0.052) * K, 0.078 * K)
  g.clip()
  g.fillStyle = '#0d2a1c'
  g.beginPath()
  g.moveTo(X(sx0 + 0.03), Y(0.136))
  g.lineTo(X(sx0 + 0.06), Y(0.1))
  g.lineTo(X(sx0 + 0.1), Y(0.112))
  g.lineTo(X(sx1 - 0.022), Y(0.09))
  g.lineTo(X(sx1 - 0.022), Y(0.136))
  g.fill()
  g.strokeStyle = '#ff4dff'
  g.lineWidth = 4
  g.beginPath()
  g.moveTo(X(sx0 + 0.036), Y(0.13))
  g.lineTo(X(sx0 + 0.08), Y(0.105))
  g.lineTo(X(sx1 - 0.03), Y(0.078))
  g.stroke()
  g.fillStyle = '#ffffff'
  g.beginPath()
  g.moveTo(X(sx0 + 0.08), Y(0.099))
  g.lineTo(X(sx0 + 0.084), Y(0.109))
  g.lineTo(X(sx0 + 0.076), Y(0.109))
  g.fill()
  g.restore()
  label('118.30', sx0 + 0.058, 0.066, 0.0085, '#7dff9a')
  label('121.90', sx0 + 0.098, 0.066, 0.007, '#9fd8ff')
  label('GPS', sx0 + 0.015, 0.064, 0.006, '#bbb')
  label('COM', sx0 + 0.015, 0.078, 0.0055, '#888')
  label('VLOC', sx0 + 0.015, 0.098, 0.0055, '#888')
  disc(sx0 + 0.015, 0.122, 0.008, '#0c0d0e', '#777', 2)
  disc(sx1 - 0.011, 0.074, 0.006, '#0c0d0e', '#777', 2)
  disc(sx1 - 0.011, 0.118, 0.009, '#0c0d0e', '#777', 2)
  // NAV / COM 2
  rect(sx0, 0.146, sx1, 0.196, '#111214', '#5a5d60', 0.002)
  rect(sx0 + 0.006, 0.152, sc - 0.004, 0.176, '#150a02')
  rect(sc + 0.004, 0.152, sx1 - 0.006, 0.176, '#150a02')
  label('124.85  119.10', (sx0 + sc) / 2 + 0.001, 0.164, 0.0078, '#ff9a2a')
  label('110.50  113.90', (sc + sx1) / 2 - 0.001, 0.164, 0.0078, '#ff9a2a')
  label('COMM', (sx0 + sc) / 2, 0.186, 0.005, '#999')
  label('NAV', (sc + sx1) / 2, 0.186, 0.005, '#999')
  disc(sc - 0.012, 0.186, 0.006, '#0c0d0e', '#777', 2)
  disc(sx1 - 0.014, 0.186, 0.006, '#0c0d0e', '#777', 2)
  // ADF-style receiver
  rect(sx0, 0.2, sx1, 0.244, '#111214', '#5a5d60', 0.002)
  rect(sx0 + 0.006, 0.206, sc + 0.02, 0.228, '#150a02')
  label('ADF   0365', sx0 + 0.052, 0.217, 0.0078, '#ff9a2a')
  ;['ADF', 'BFO', 'FRQ', 'FLT'].forEach((t, i) => label(t, sx0 + 0.018 + i * 0.022, 0.237, 0.0046, '#999'))
  disc(sx1 - 0.02, 0.222, 0.01, '#0c0d0e', '#777', 2)
  // Transponder
  rect(sx0, 0.248, sx1, 0.3, '#111214', '#5a5d60', 0.002)
  rect(sx0 + 0.03, 0.254, sx1 - 0.03, 0.28, '#150a02')
  label('1200  ALT', sc, 0.267, 0.0095, '#ff9a2a')
  ;['IDT', 'VFR', 'ON', 'ALT'].forEach((t, i) => {
    const x = sx0 + 0.036 + i * 0.03
    rect(x - 0.009, 0.284, x + 0.009, 0.296, '#26292c', '#70747a', 0.0015)
    label(t, x, 0.29, 0.0048)
  })
  disc(sx0 + 0.014, 0.268, 0.008, '#0c0d0e', '#777', 2)

  // Engine cluster recess (live tachometer and gauges sit on top).
  rect(0.214, 0.014, 0.466, 0.276, '#202224', '#494c50', 0.008)
  // Far right: ammeter, hour meter and vent.
  gauge(0.497, 0.07, 0.021, 'AMP')
  hand(0.497, 0.07, 0.016, 0.15)
  rect(0.474, 0.125, 0.52, 0.15, '#0b0c0e', '#555', 0.002)
  label('HOURS', 0.497, 0.118, 0.005, '#aaa')
  label('1284.6', 0.497, 0.1375, 0.0085)
  disc(0.497, 0.215, 0.022, '#0d0e0f', '#5a5d60', 3)
  for (let i = -3; i <= 3; i++) {
    g.fillStyle = '#3a3d40'
    g.fillRect(X(0.497 - 0.016), Y(0.215 + i * 0.005) - 2, 0.032 * K, 4)
  }
  // Placards
  rect(0.24, 0.286, 0.44, 0.31, '#0e0f10', '#666', 0.002)
  label('MANEUVERING SPEED 105 KIAS', 0.34, 0.2935, 0.0052)
  label('NORMAL CATEGORY · NO ACROBATIC MANEUVERS', 0.34, 0.3025, 0.0046, '#bbb')
  rect(-0.45, 0.268, -0.11, 0.306, '#0e0f10', '#666', 0.002)
  label('N172GF', -0.28, 0.287, 0.014)

  // Lower switch panel: ignition, master and the rocker row.
  disc(-0.49, 0.385, 0.017, '#101112', '#8d8f8c', 3)
  disc(-0.49, 0.385, 0.006, '#b9b9b2', '#444', 2)
  ;[['OFF', -1.9], ['R', -1.0], ['L', 0], ['BOTH', 1.0], ['START', 1.9]].forEach(([t, a]) => {
    label(t as string, -0.49 + Math.sin(a as number) * 0.026, 0.385 - Math.cos(a as number) * 0.026, 0.0048)
  })
  label('MASTER', -0.432, 0.35, 0.0055)
  rect(-0.447, 0.358, -0.433, 0.398, '#b3201c', '#30100e', 0.002)
  rect(-0.431, 0.358, -0.417, 0.398, '#c42622', '#30100e', 0.002)
  label('ALT', -0.44, 0.405, 0.0048)
  label('BAT', -0.424, 0.405, 0.0048)
  ;['FUEL\nPUMP', 'BCN', 'LAND', 'TAXI', 'NAV', 'STROBE', 'PITOT\nHEAT'].forEach((t, i) => {
    const x = -0.385 + i * 0.036
    const on = i === 1 || i === 4 || i === 5
    rect(x - 0.008, 0.36, x + 0.008, 0.396, '#e9e7df', '#3a3a38', 0.002)
    rect(x - 0.008, on ? 0.36 : 0.378, x + 0.008, on ? 0.378 : 0.396, '#c9c7bf', '#3a3a38', 0.002)
    t.split('\n').forEach((row, j, rows) => label(row, x, 0.349 - (rows.length - 1 - j) * 0.006, 0.0047))
  })
  label('AVIONICS', -0.118, 0.349, 0.0047)
  rect(-0.126, 0.36, -0.11, 0.396, '#e9e7df', '#3a3a38', 0.002)
  rect(-0.126, 0.36, -0.11, 0.378, '#c9c7bf', '#3a3a38', 0.002)
  // Circuit breakers
  for (let i = 0; i < 13; i++) {
    const x = -0.5 + i * 0.031
    disc(x, 0.432, 0.0062, '#0d0e0f', '#5c5f62', 2)
    label(['5', '10', '5', '10', '15', '5', '5', '10', '5', '60', '5', '10', '5'][i], x, 0.432, 0.0045, '#ddd')
  }
  label('CIRCUIT BREAKERS · PUSH TO RESET', -0.31, 0.416, 0.0044, '#aaa')

  // Engine controls (the knobs themselves are 3D).
  for (const [x, t] of [
    [0.055, 'THROTTLE'],
    [0.13, 'MIXTURE'],
  ] as const) {
    disc(x, 0.398, 0.014, '#101112', '#8d8f8c', 3)
    label(t, x, 0.35, 0.0055)
  }
  label('PUSH OPEN', 0.055, 0.438, 0.0044, '#aaa')
  label('PUSH RICH', 0.13, 0.438, 0.0044, '#aaa')
  disc(-0.03, 0.395, 0.011, '#101112', '#8d8f8c', 3)
  label('CARB HEAT', -0.03, 0.35, 0.0048)
  disc(-0.03, 0.395, 0.007, '#1c1d1f', '#555', 2)

  // Flap switch gate.
  rect(0.205, 0.346, 0.232, 0.444, '#141516', '#6a6d70', 0.003)
  label('WING FLAPS', 0.228, 0.337, 0.005)
  ;['UP', '10°', '20°', 'FULL'].forEach((t, i) => {
    const d = 0.357 + i * 0.0253
    g.fillStyle = INK
    g.fillRect(X(0.234), Y(d) - 1.5, 0.008 * K, 3)
    label(t, 0.256, d, 0.0052)
  })
  g.fillStyle = '#f2f2ea'
  g.fillRect(X(0.196), Y(0.352), 0.006 * K, 0.03 * K)
  g.fillStyle = '#2fbf4f'
  g.fillRect(X(0.196), Y(0.382), 0.006 * K, 0.056 * K)

  // Cabin controls and right-hand breakers.
  for (const [x, t] of [
    [0.31, 'ALT STATIC'],
    [0.375, 'CABIN HT'],
    [0.44, 'CABIN AIR'],
  ] as const) {
    disc(x, 0.39, 0.012, '#101112', '#8d8f8c', 3)
    disc(x, 0.39, 0.0075, t === 'ALT STATIC' ? '#b3201c' : '#1c1d1f', '#555', 2)
    label(t, x, 0.356, 0.0048)
    label('PULL ON', x, 0.412, 0.0042, '#aaa')
  }
  disc(0.497, 0.39, 0.01, '#0a0a0b', '#8d8f8c', 3)
  label('12V', 0.497, 0.368, 0.0048)
  for (let i = 0; i < 7; i++) disc(0.3 + i * 0.031, 0.436, 0.0062, '#0d0e0f', '#5c5f62', 2)

  const tex = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

export function build172Cockpit(model: Pick<AircraftModel, 'eye'>): Cockpit {
  const root = new Group()
  root.name = 'cockpit'
  const eye = model.eye
  const textures: Texture[] = []
  const std = (color: string, roughness = 0.85, metalness = 0.02) => new MeshStandardMaterial({ color, roughness, metalness, envMapIntensity: 0.3 })
  const trim = std('#b7b2a6')
  trim.side = DoubleSide
  const wall = std('#8f8b83', 0.92)
  wall.side = DoubleSide
  const headliner = std('#cbc8be', 0.95)
  const carpet = std('#34363a', 0.98)
  const glare = std('#0d0e10', 0.97)
  const seatMat = std('#7d6851', 0.8)
  const seatDark = std('#5b4a39', 0.85)
  const black = std('#101113', 0.55, 0.2)
  const chrome = std('#c9ccd0', 0.25, 0.9)
  const redKnob = std('#b21f1b', 0.5, 0.05)
  const cowlMat = std('#fbfbf8', 0.35, 0.1)
  const pedalMat = std('#6a6d71', 0.45, 0.7)

  const add = (geo: BufferGeometry, mat: Material, parent: Object3D, x = 0, y = 0, z = 0) => {
    const m = new Mesh(geo, mat)
    m.position.set(x, y, z)
    m.castShadow = true
    m.receiveShadow = true
    parent.add(m)
    return m
  }
  const box = (w: number, h: number, d: number, mat: Material, parent: Object3D, x: number, y: number, z: number, rx = 0) => {
    const m = add(new BoxGeometry(w, h, d), mat, parent, x, y, z)
    m.rotation.x = rx
    return m
  }
  /** Square-section beam between two points (pillars, yoke arms). */
  const beam = (a: Vector3, b: Vector3, t: number, mat: Material, parent: Object3D, depth = t) => {
    const m = add(new BoxGeometry(t, a.distanceTo(b), depth), mat, parent)
    m.position.copy(a).add(b).multiplyScalar(0.5)
    m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), b.clone().sub(a).normalize())
    return m
  }

  const panelTop = eye.y - 0.22
  const zPanel = eye.z - 0.62
  const floorY = eye.y - 0.95
  const sill = eye.y - 0.22
  const roofY = eye.y + 0.25
  const halfW = 0.56
  const zFront = zPanel - 0.3
  const zBow = zPanel + 0.12
  const zRear = eye.z + 1.55
  const instruments: InstrumentCanvas[] = []

  // --- Cabin shell -------------------------------------------------------
  box(halfW * 2 + 0.06, 0.04, zRear - zFront, carpet, root, 0, floorY - 0.02, (zRear + zFront) / 2)
  for (const s of [1, -1]) {
    // Door / side wall up to the window sill, with an armrest.
    box(0.04, sill - floorY, zRear - zFront, wall, root, (halfW + 0.02) * s, (sill + floorY) / 2, (zRear + zFront) / 2)
    box(0.07, 0.035, 0.42, seatDark, root, (halfW - 0.03) * s, sill - 0.2, eye.z + 0.08)
    box(0.05, 0.03, zRear - zFront, trim, root, (halfW + 0.01) * s, sill + 0.005, (zRear + zFront) / 2)
    // Boxed-in sill covering where the wing strut and main gear leg meet the fuselage.
    box(0.2, 0.18, 1.06, wall, root, (halfW - 0.08) * s, floorY + 0.09, 0.1)
    // Windshield pillar, door post and the rail under the wing root.
    beam(new Vector3(halfW * s, sill, zFront + 0.02), new Vector3(halfW * s, roofY, zBow), 0.036, trim, root)
    box(0.045, roofY - sill, 0.05, trim, root, halfW * s, (roofY + sill) / 2, eye.z + 0.36)
    box(0.06, 0.05, zRear - zBow, trim, root, halfW * s, roofY - 0.005, (zRear + zBow) / 2)
    // Sun visor folded up against the headliner.
    box(0.3, 0.008, 0.12, black, root, 0.27 * s, roofY - 0.035, zBow + 0.09, 0.12)
  }
  box(halfW * 2 + 0.06, 0.05, 0.07, trim, root, 0, roofY, zBow)
  box(halfW * 2 + 0.06, 0.03, zRear - zBow, headliner, root, 0, roofY + 0.03, (zRear + zBow) / 2)
  box(halfW * 2 + 0.06, roofY - floorY + 0.06, 0.04, wall, root, 0, (roofY + floorY) / 2, zRear)
  // Firewall and kick panel under the instrument panel.
  box(halfW * 2 + 0.06, panelTop - floorY, 0.04, carpet, root, 0, (panelTop + floorY) / 2, zPanel - 0.05)

  // Engine cowling seen over the glareshield (the fuselage shell is hidden in this view).
  // A forward-pointing half ellipsoid starting just ahead of the firewall.
  const cowl = new SphereGeometry(1, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2)
  cowl.rotateX(-Math.PI / 2)
  cowl.scale(0.5, 0.37, 1.5)
  add(cowl, cowlMat, root, 0, -0.04, zPanel - 0.1)

  // --- Glareshield and panel ---------------------------------------------
  box(PANEL_W + 0.1, 0.03, 0.36, glare, root, 0, panelTop + 0.006, zPanel - 0.1, 0.1)
  box(PANEL_W + 0.1, 0.05, 0.03, glare, root, 0, panelTop + 0.012, zPanel + 0.085)

  const tilt = -0.09
  const panel = new Group()
  panel.position.set(0, panelTop, zPanel)
  panel.rotation.x = tilt
  root.add(panel)
  box(PANEL_W, PANEL_H, 0.03, black, panel, 0, -PANEL_H / 2, -0.016)
  const panelTex = paintPanel()
  textures.push(panelTex)
  const lit = (map: Texture, emissive: number) => new MeshStandardMaterial({ map, emissive: '#ffffff', emissiveMap: map, emissiveIntensity: emissive, roughness: 0.6, envMapIntensity: 0.2 })
  add(new PlaneGeometry(PANEL_W, PANEL_H), lit(panelTex, 0.3), panel, 0, -PANEL_H / 2, 0)

  const six = new InstrumentCanvas(1024, 600, drawSixPack)
  const engine = new InstrumentCanvas(512, 512, drawGaEngine)
  const compass = new InstrumentCanvas(256, 96, drawWhiskeyCompass)
  instruments.push(six, engine, compass)
  add(new PlaneGeometry(0.38, 0.38 * (600 / 1024)), lit(six.texture, 0.8), panel, -0.279, -0.136, 0.002)
  add(new PlaneGeometry(0.245, 0.245), lit(engine.texture, 0.8), panel, 0.34, -0.145, 0.002)

  // Whiskey compass hanging from the windshield bow.
  const compassY = roofY - 0.085
  box(0.085, 0.05, 0.06, black, root, 0, compassY, zBow - 0.03)
  box(0.02, 0.06, 0.02, black, root, 0, compassY + 0.05, zBow - 0.03)
  add(new PlaneGeometry(0.07, 0.07 * (96 / 256)), lit(compass.texture, 0.7), root, 0, compassY, zBow + 0.001)

  // --- Engine controls -----------------------------------------------------
  const knob = (x: number, mat: Material, ribs: number) => {
    const g = new Group()
    g.position.set(x, -0.398, 0)
    panel.add(g)
    const shaft = new CylinderGeometry(0.005, 0.005, 0.16, 10)
    shaft.rotateX(Math.PI / 2)
    add(shaft, chrome, g, 0, 0, -0.06)
    const head = new CylinderGeometry(0.021, 0.019, 0.026, ribs)
    head.rotateX(Math.PI / 2)
    const grip = add(head, mat, g, 0, 0, 0.03)
    return { g, grip }
  }
  const throttle = knob(0.055, black, 20)
  const mixture = knob(0.13, redKnob, 8)
  mixture.g.position.z = 0.018
  throttle.grip.userData.cockpitCommand = { type: 'set_throttle', value: 0.1 } satisfies SimCommand
  throttle.grip.userData.cockpitShiftCommand = { type: 'set_throttle', value: 0 } satisfies SimCommand
  throttle.grip.userData.cockpitLabel = 'Throttle +10% · Shift-click to decrease'

  // Flap switch: a paddle that slides down its gate with the flaps.
  const flap = new Group()
  flap.position.set(0.2185, -0.357, 0)
  panel.add(flap)
  box(0.008, 0.008, 0.04, chrome, flap, 0, 0, 0.02)
  const paddle = box(0.034, 0.012, 0.018, std('#f1f0e8', 0.5), flap, 0, 0, 0.045)
  paddle.userData.cockpitCommand = { type: 'flaps_down' } satisfies SimCommand
  paddle.userData.cockpitShiftCommand = { type: 'flaps_up' } satisfies SimCommand
  paddle.userData.cockpitLabel = 'Flaps down one notch · Shift-click for flaps up'

  // Pedestal with the elevator trim wheel, and the fuel selector on the floor.
  const pedTop = panelTop - PANEL_H + 0.01
  box(0.17, pedTop - floorY, 0.1, black, root, 0.09, (pedTop + floorY) / 2, zPanel + 0.06)
  const trimWheel = new CylinderGeometry(0.075, 0.075, 0.022, 28)
  trimWheel.rotateZ(Math.PI / 2)
  add(trimWheel, black, root, 0.045, pedTop - 0.12, zPanel + 0.11)
  box(0.03, 0.09, 0.004, std('#e8e6de', 0.6), root, 0.09, pedTop - 0.12, zPanel + 0.112)
  const selector = new CylinderGeometry(0.06, 0.06, 0.012, 28)
  add(selector, black, root, 0, floorY + 0.008, zPanel + 0.42)
  box(0.018, 0.02, 0.085, redKnob, root, 0, floorY + 0.022, zPanel + 0.405)

  // --- Yokes, pedals and seats ---------------------------------------------
  const yokes: Group[] = []
  let yoke: Object3D | null = null
  const yokeReach = 0.3
  for (const sx of [eye.x, -eye.x]) {
    const column = new Group()
    column.position.set(sx, -0.292, 0)
    panel.add(column)
    const shaft = new CylinderGeometry(0.013, 0.013, yokeReach + 0.2, 14)
    shaft.rotateX(Math.PI / 2)
    add(shaft, chrome, column, 0, 0, (yokeReach - 0.2) / 2)
    const collar = new CylinderGeometry(0.022, 0.022, 0.02, 16)
    collar.rotateX(Math.PI / 2)
    add(collar, black, panel, sx, -0.292, 0.01)
    const wheel = new Group()
    wheel.position.z = yokeReach
    column.add(wheel)
    box(0.1, 0.06, 0.035, black, wheel, 0, 0, 0)
    for (const s of [1, -1]) {
      beam(new Vector3(0.04 * s, -0.005, 0), new Vector3(0.14 * s, 0.012, 0), 0.026, black, wheel, 0.03)
      const grip = new CylinderGeometry(0.015, 0.017, 0.115, 12)
      const gm = add(grip, black, wheel, 0.148 * s, 0.062, 0)
      gm.rotation.z = -s * 0.14
    }
    column.userData.wheel = wheel
    if (sx === eye.x) yoke = column
    yokes.push(column)

    for (const s of [1, -1]) {
      box(0.065, 0.085, 0.012, pedalMat, root, sx + 0.1 * s, floorY + 0.15, zPanel + 0.03, -0.45)
      box(0.014, 0.16, 0.014, black, root, sx + 0.1 * s, floorY + 0.07, zPanel + 0.01)
    }

    const seat = new Group()
    seat.position.set(sx, floorY, eye.z + 0.12)
    root.add(seat)
    box(0.42, 0.1, 0.44, seatMat, seat, 0, 0.19, 0)
    box(0.34, 0.14, 0.4, seatDark, seat, 0, 0.07, 0)
    box(0.42, 0.6, 0.09, seatMat, seat, 0, 0.5, 0.27, -0.14)
    box(0.22, 0.13, 0.07, seatDark, seat, 0, 0.86, 0.33, -0.14)
  }
  // Rear bench.
  box(1.0, 0.11, 0.42, seatMat, root, 0, floorY + 0.2, zRear - 0.36)
  box(1.0, 0.55, 0.09, seatMat, root, 0, floorY + 0.5, zRear - 0.1, -0.12)

  // Everything in the cockpit is lit by the scene lights.
  root.traverse((o) => o.layers.enableAll())

  let lastDraw = 0
  return {
    root,
    instruments,
    yoke,
    stick: null,
    throttles: [throttle.g],
    update(s, c) {
      const now = performance.now()
      if (now - lastDraw > 50) {
        lastDraw = now
        for (const i of instruments) i.update(s)
      }
      for (const column of yokes) {
        column.position.z = c.pitch * 0.06
        ;(column.userData.wheel as Group).rotation.z = -c.roll * 0.9
      }
      // Push-pull: fully in at full power.
      throttle.g.position.z = 0.075 - c.throttle * 0.065
      throttle.grip.userData.cockpitCommand.value = Math.min(1, c.throttle + 0.1)
      throttle.grip.userData.cockpitShiftCommand.value = Math.max(0, c.throttle - 0.1)
      flap.position.y = -0.357 - s[S.FLAPS] * 0.076
    },
    dispose() {
      for (const i of instruments) i.dispose()
      for (const t of textures) t.dispose()
    },
  }
}
