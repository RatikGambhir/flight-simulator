// A dedicated 737NG interior. Coordinates are metres, relative to pilot eye
// height/fore-aft position, with x=0 on the aircraft centreline.
import {
  BoxGeometry, CanvasTexture, CylinderGeometry, DoubleSide, Group, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, SRGBColorSpace,
  Vector3, type BufferGeometry, type Material, type Object3D,
} from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { Flags, S, type SimCommand } from '../sim/protocol'
import type { Cockpit } from './cockpit'
import type { AircraftModel } from './models'
import { drawND, drawPFD, InstrumentCanvas } from './instruments'

type Draw = (g: CanvasRenderingContext2D, w: number, h: number) => void
const INK = '#e3e4de'
const PANEL = '#3d444c'

function text(g: CanvasRenderingContext2D, value: string, x: number, y: number, size = 18, color = INK) {
  g.fillStyle = color
  g.font = `500 ${size}px Arial, sans-serif`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(value, x, y)
}

function screw(g: CanvasRenderingContext2D, x: number, y: number) {
  g.fillStyle = '#272a2d'
  g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill()
  g.strokeStyle = '#aaa9a0'; g.lineWidth = 1
  g.beginPath(); g.moveTo(x - 3, y); g.lineTo(x + 3, y); g.stroke()
}

function panelBackground(g: CanvasRenderingContext2D, w: number, h: number) {
  g.fillStyle = PANEL; g.fillRect(0, 0, w, h)
  // Fine deterministic stipple, baked once, gives painted metal a tactile finish.
  for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) {
    const n = ((x * 73 + y * 137) % 31) / 31
    g.fillStyle = `rgba(${n > 0.5 ? '255,255,255' : '0,0,0'},0.035)`
    g.fillRect(x, y, 1, 1)
  }
  g.strokeStyle = '#292c2f'; g.lineWidth = 3; g.strokeRect(2, 2, w - 4, h - 4)
  for (const x of [14, w - 14]) for (const y of [14, h - 14]) screw(g, x, y)
}

function button(g: CanvasRenderingContext2D, label: string, x: number, y: number, w = 65, h = 37, light = false) {
  g.fillStyle = '#24282b'; g.fillRect(x - w / 2, y - h / 2, w, h)
  g.strokeStyle = '#777b7a'; g.lineWidth = 1; g.strokeRect(x - w / 2, y - h / 2, w, h)
  const rows = label.split('\n')
  rows.forEach((row, i) => text(g, row, x, y + (i - (rows.length - 1) / 2) * 13, 12))
  if (light) { g.fillStyle = '#6bd890'; g.fillRect(x - w / 2 + 5, y - h / 2 + 3, w - 10, 3) }
}

function dial(g: CanvasRenderingContext2D, x: number, y: number, r: number, label: string) {
  g.fillStyle = '#161c20'; g.beginPath(); g.arc(x, y, r, 0, 2 * Math.PI); g.fill()
  g.strokeStyle = '#b6bbb9'; g.lineWidth = 2; g.stroke()
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * Math.PI * 2
    g.beginPath(); g.moveTo(x + Math.sin(a) * r * 0.78, y - Math.cos(a) * r * 0.78)
    g.lineTo(x + Math.sin(a) * r * 0.92, y - Math.cos(a) * r * 0.92); g.stroke()
  }
  g.beginPath(); g.moveTo(x, y); g.lineTo(x + r * 0.46, y - r * 0.6); g.stroke()
  text(g, label, x, y + r * 0.42, r * 0.24)
}

function drawFmc(g: CanvasRenderingContext2D, w: number, h: number) {
  panelBackground(g, w, h)
  g.fillStyle = '#090e0f'; g.fillRect(w * 0.15, h * 0.08, w * 0.7, h * 0.37)
  text(g, 'IDENT', w / 2, h * 0.12, 20)
  text(g, 'MODEL                 ENG RATING', w / 2, h * 0.18, 12)
  text(g, '737-800                26K', w / 2, h * 0.22, 18)
  text(g, 'NAV DATA', w * 0.3, h * 0.28, 12)
  text(g, 'GEOFLIGHT', w * 0.36, h * 0.32, 17, '#70c7e6')
  text(g, '<INDEX                 POS INIT>', w / 2, h * 0.41, 14)
  for (const x of [w * 0.075, w * 0.925]) for (let i = 0; i < 6; i++) button(g, '—', x, h * (0.12 + i * 0.06), 26, 15)
  const functions = ['INIT\nREF', 'RTE', 'CLB', 'CRZ', 'DES', 'MENU', 'LEGS', 'DEP\nARR', 'HOLD', 'PROG', 'EXEC', 'N1\nLIMIT']
  functions.forEach((label, i) => button(g, label, w * (0.1 + i % 6 * 0.16), h * (0.51 + Math.floor(i / 6) * 0.08), 43, 29, label === 'EXEC'))
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ /'
  for (let i = 0; i < 30; i++) button(g, letters[i] ?? '', w * (0.41 + i % 5 * 0.12), h * (0.69 + Math.floor(i / 5) * 0.05), 29, 23)
  for (let i = 0; i < 12; i++) button(g, '123456789.0-'[i], w * (0.09 + i % 3 * 0.1), h * (0.75 + Math.floor(i / 3) * 0.06), 23, 23)
}

function drawEfis(g: CanvasRenderingContext2D, w: number, h: number) {
  panelBackground(g, w, h)
  text(g, 'MINS', w * 0.2, 24, 16); text(g, 'BARO', w * 0.8, 24, 16)
  text(g, 'RADIO   BARO', w * 0.2, 50, 10); text(g, 'IN   HPA', w * 0.8, 50, 10)
  text(g, 'VOR  MAP  PLN', w * 0.3, h * 0.53, 11); text(g, 'RANGE', w * 0.74, h * 0.53, 12)
  for (const [i, label] of ['WXR', 'STA', 'WPT', 'ARPT', 'DATA', 'POS', 'TERR'].entries()) button(g, label, w * (0.08 + i * 0.14), h * 0.88, 31, 24)
}

function drawOverhead(g: CanvasRenderingContext2D, w: number, h: number) {
  panelBackground(g, w, h)
  const titles = ['FLT CONTROL', 'FUEL', 'ELECTRICAL', 'EQUIP COOLING', 'ANTI ICE', 'HYDRAULIC', 'AIR CONDITIONING', 'CABIN PRESS', 'LIGHTS', 'ENGINE START', 'APU', 'SIGNS']
  const cw = w / 3, ch = h / 4
  titles.forEach((title, index) => {
    const x = index % 3 * cw, y = Math.floor(index / 3) * ch
    g.strokeStyle = '#b0b3b0'; g.lineWidth = 2; g.strokeRect(x + 8, y + 8, cw - 16, ch - 16)
    text(g, title, x + cw / 2, y + 27, 17)
    for (let i = 0; i < 3; i++) {
      const xx = x + cw * (0.2 + i * 0.3)
      button(g, ['LOW\nPRESSURE', 'OFF', 'ON'][i], xx, y + ch * 0.3, 56, 30)
      text(g, 'ON', xx, y + ch * 0.48, 12)
      text(g, 'OFF', xx, y + ch * 0.8, 12)
      g.strokeStyle = '#aeb0aa'; g.beginPath(); g.moveTo(xx, y + ch * 0.55); g.lineTo(xx, y + ch * 0.72); g.stroke()
    }
    if (index === 2 || index === 7) dial(g, x + cw / 2, y + ch * 0.62, 27, index === 2 ? 'DC' : 'DIFF')
  })
}

/** Only supported sim values are live; decorative panels never invent systems state. */
function drawMcp(g: CanvasRenderingContext2D, s: Float64Array, w: number, h: number) {
  g.fillStyle = PANEL; g.fillRect(0, 0, w, h)
  const ap = !!((s[S.FLAGS] | 0) & Flags.AP_ENGAGED)
  const fields = [
    { x: 0.07, label: 'COURSE', value: '000', width: 0.09 },
    { x: 0.28, label: 'IAS / MACH', value: Math.round(ap ? s[S.AP_SPEED_KT] : s[S.IAS_KT]).toString().padStart(3, '0'), width: 0.13 },
    { x: 0.46, label: 'HEADING', value: (Math.round(ap ? s[S.AP_HEADING] : s[S.HEADING]) % 360).toString().padStart(3, '0'), width: 0.1 },
    { x: 0.63, label: 'ALTITUDE', value: Math.round(ap ? s[S.AP_ALT_FT] : s[S.ALT_MSL_FT]).toString().padStart(5, '0'), width: 0.14 },
    { x: 0.8, label: 'VERT SPEED', value: ap ? '-----' : '', width: 0.13 },
    { x: 0.94, label: 'COURSE', value: '000', width: 0.09 },
  ]
  for (const f of fields) {
    text(g, f.label, w * f.x, h * 0.13, 17)
    g.fillStyle = '#0b1110'; g.fillRect(w * (f.x - f.width / 2), h * 0.23, w * f.width, h * 0.25)
    g.fillStyle = '#e5e8d6'; g.font = `500 ${h * 0.2}px monospace`; g.textAlign = 'center'
    g.fillText(f.value, w * f.x, h * 0.36)
  }
  for (const [x, label] of [[0.16, 'F/D'], [0.2, 'A/T ARM'], [0.35, 'VNAV'], [0.38, 'LNAV'], [0.55, 'ALT HLD'], [0.72, 'V/S'], [0.86, 'CMD A']] as const) {
    button(g, label, w * x, h * 0.66, w * 0.055, h * 0.19, ap && ['CMD A', 'ALT HLD'].includes(label))
  }
  text(g, 'DISENGAGE', w * 0.86, h * 0.89, 12)
  text(g, 'SPEED', w * 0.28, h * 0.94, 11); text(g, 'HDG SEL', w * 0.46, h * 0.94, 11)
}

function draw737Engines(g: CanvasRenderingContext2D, s: Float64Array, w: number, h: number) {
  g.fillStyle = '#05070a'; g.fillRect(0, 0, w, h)
  // The sim has one normalized engine spool. Secondary readouts are cosmetic
  // approximations driven by that spool, not a separate engine-system model.
  const spool = Math.max(0, Math.min(1, s[S.ENGINE]))
  text(g, 'TAT  +15 C', w * 0.17, 24, 15)
  text(g, 'N1', w * 0.5, 63, 20, '#61db86')
  text(g, 'EGT', w * 0.5, 217, 18)
  for (const x of [w * 0.27, w * 0.73]) {
    for (const [y, value, limit, color] of [[118, 20 + spool * 81, 110, '#61db86'], [270, 360 + spool * 470, 950, '#f1f3ef']] as const) {
      const r = 66
      g.strokeStyle = '#e1e8e4'; g.lineWidth = 3
      g.beginPath(); g.arc(x, y, r, Math.PI * 0.65, Math.PI * 2.3); g.stroke()
      const a = Math.PI * 0.65 + value / limit * Math.PI * 1.65
      g.strokeStyle = color; g.lineWidth = 4; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * r * 0.91, y + Math.sin(a) * r * 0.91); g.stroke()
      g.fillStyle = '#05070a'; g.fillRect(x - 31, y + 13, 72, 34)
      g.strokeStyle = '#9da9a3'; g.lineWidth = 1; g.strokeRect(x - 31, y + 13, 72, 34)
      text(g, y === 118 ? value.toFixed(1) : String(Math.round(value)), x + 5, y + 30, 25)
    }
    text(g, (58 + spool * 41).toFixed(1), x, 373, 24)
    text(g, (0.3 + spool * 2.1).toFixed(2), x, 420, 24)
  }
  text(g, 'N2', w / 2, 373, 17); text(g, 'FF', w / 2, 420, 17)
  g.strokeStyle = '#56635b'; g.beginPath(); g.moveTo(25, 453); g.lineTo(w - 25, 453); g.stroke()
  text(g, `FLAPS  ${Math.round(s[S.FLAPS] * 100)}%`, w * 0.25, 480, 18)
  text(g, s[S.GEAR] > 0.99 ? 'GEAR DOWN' : s[S.GEAR] < 0.01 ? 'GEAR UP' : 'GEAR TRANSIT', w * 0.73, 480, 18, s[S.GEAR] > 0.99 ? '#61db86' : INK)
}

export function build737Cockpit(model: AircraftModel): Cockpit {
  const root = new Group(); root.name = 'cockpit'
  root.position.set(0, model.eye.y, model.eye.z)
  const staticRoot = new Group(); root.add(staticRoot)
  const textures: CanvasTexture[] = []
  const instruments: InstrumentCanvas[] = []
  const material = (color: string, roughness = 0.85) => new MeshStandardMaterial({ color, roughness, metalness: 0.04, emissive: color, emissiveIntensity: 0.12 })
  const shell = material('#646b70'), panel = material('#3d444c'), dark = material('#191c20'), rubber = material('#141619', 0.96)
  const silver = material('#949b9c', 0.42), ivory = material('#ddd9c9'), seat = material('#a6a294')
  const red = material('#9c2b22'), amber = material('#a87726')

  function mesh(geometry: BufferGeometry, mat: Material, parent: Object3D, x: number, y: number, z: number) {
    const m = new Mesh(geometry, mat); m.position.set(x, y, z); parent.add(m); return m
  }
  function box(w: number, h: number, d: number, mat: Material, x: number, y: number, z: number, parent: Object3D = staticRoot, radius = 0) {
    return mesh(radius ? new RoundedBoxGeometry(w, h, d, 2, radius) : new BoxGeometry(w, h, d), mat, parent, x, y, z)
  }
  function rod(a: number[], b: number[], radius: number, mat: Material, parent: Object3D = staticRoot) {
    const from = new Vector3(...a), to = new Vector3(...b), direction = to.clone().sub(from)
    const m = mesh(new CylinderGeometry(radius, radius, direction.length(), 10), mat, parent, ...from.add(to).multiplyScalar(0.5).toArray() as [number, number, number])
    m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize())
    return m
  }
  function knob(x: number, y: number, z: number, radius = 0.022, parent: Object3D = staticRoot, mat: Material = ivory) {
    const m = mesh(new CylinderGeometry(radius, radius * 1.08, 0.026, 12), mat, parent, x, y, z)
    m.rotation.x = Math.PI / 2
    const mark = box(0.003, radius * 0.7, 0.002, dark, x, y + radius * 0.35, z + 0.014, parent)
    mark.userData = m.userData
    return m
  }
  function surface(draw: Draw, width: number, height: number, x: number, y: number, z: number, parent: Object3D = staticRoot, resX = 1024, resY = 512) {
    const canvas = document.createElement('canvas'); canvas.width = resX; canvas.height = resY
    draw(canvas.getContext('2d')!, resX, resY)
    const texture = new CanvasTexture(canvas); texture.colorSpace = SRGBColorSpace; texture.anisotropy = 8; textures.push(texture)
    const mat = new MeshStandardMaterial({ map: texture, roughness: 0.9, emissiveMap: texture, emissive: '#ffffff', emissiveIntensity: 0.22, side: DoubleSide })
    return mesh(new PlaneGeometry(width, height), mat, parent, x, y, z)
  }
  function display(instrument: InstrumentCanvas, x: number, y: number, width = 0.265, height = 0.265, z = -1.02, parent: Object3D = staticRoot) {
    box(width + 0.037, height + 0.038, 0.035, dark, x, y, z - 0.008, parent, 0.014)
    const mat = new MeshBasicMaterial({ map: instrument.texture, toneMapped: false })
    const face = mesh(new PlaneGeometry(width, height), mat, parent, x, y, z + 0.012)
    face.name = 'live-display'
    for (const dx of [-1, 1]) for (const dy of [-1, 1]) knob(x + dx * (width / 2 + 0.009), y + dy * (height / 2 + 0.009), z + 0.01, 0.0035, parent, silver)
  }
  // Structural shell and sloped, multi-pane windshield. The centre post stays
  // on the aircraft centreline, never in front of the captain's eye.
  box(2.65, 0.06, 2.9, dark, 0, -1.25, -0.05)
  box(2.65, 0.06, 1.9, shell, 0, 0.62, 0.25)
  box(2.65, 1.85, 0.06, shell, 0, -0.31, 1.16)
  for (const side of [-1, 1]) {
    box(0.07, 1, 2.7, shell, side * 1.29, -0.8, -0.15)
    box(0.16, 0.09, 1.7, panel, side * 1.2, -0.27, -0.35, staticRoot, 0.02)
    rod([side * 1.11, -0.23, -1.38], [side * 0.94, 0.55, -1.05], 0.036, shell)
    rod([side * 0.94, 0.55, -1.05], [0, 0.59, -1.18], 0.04, shell)
    rod([side * 1.11, -0.23, -1.38], [0, -0.24, -1.53], 0.035, rubber)
    rod([side * 1.11, -0.23, -1.38], [side * 1.3, -0.22, 0.28], 0.042, shell)
    rod([side * 0.94, 0.55, -1.05], [side * 1.3, 0.53, 0.28], 0.035, shell)
    rod([side * 1.3, -0.22, 0.28], [side * 1.3, 0.53, 0.28], 0.045, shell)
    // Wiper arms parked along the lower window edge.
    rod([side * 0.15, -0.20, -1.48], [side * 0.64, -0.14, -1.44], 0.009, dark)
    rod([side * 0.48, -0.14, -1.44], [side * 0.92, -0.12, -1.40], 0.012, rubber)
  }
  rod([0, -0.24, -1.53], [0, 0.59, -1.18], 0.036, shell)
  box(2.42, 0.07, 0.39, rubber, 0, -0.255, -1.17, staticRoot, 0.025)
  box(2.42, 0.7, 0.065, panel, 0, -0.64, -1.06)
  box(2.42, 0.23, 0.2, shell, 0, -1.06, -1.14)
  surface((g, w, h) => {
    panelBackground(g, w, h)
    for (const x of [w * 0.14, w * 0.72]) {
      g.strokeStyle = '#303437'; g.lineWidth = 3; g.strokeRect(x, h * 0.09, w * 0.25, h * 0.79)
      button(g, 'A/P\nP/RST', x + w * 0.025, h * 0.10, 48, 26)
      button(g, 'A/T\nP/RST', x + w * 0.06, h * 0.10, 48, 26)
      button(g, 'FMC\nP/RST', x + w * 0.095, h * 0.10, 48, 26)
      text(g, 'DISENGAGE TEST', x + w * 0.175, h * 0.10, 11)
      for (const [i, label] of ['MAIN PANEL DU', 'LOWER DU', 'SPD REF', 'N1 SET'].entries()) {
        text(g, label, x + w * (0.03 + i * 0.06), h * 0.77, 10)
      }
      for (const xx of [x + 8, x + w * 0.25 - 8]) for (const yy of [h * 0.18, h * 0.86]) screw(g, xx, yy)
    }
    for (const x of [w * 0.08, w * 0.91]) { dial(g, x, h * 0.30, 57, 'CLOCK'); text(g, 'MAIN PANEL', x, h * 0.72, 17); text(g, 'DU   BRT', x, h * 0.79, 14) }
    text(g, 'STANDBY', w * 0.47, h * 0.11, 12)
    text(g, 'LANDING GEAR', w * 0.61, h * 0.25, 12)
    text(g, 'UP', w * 0.61, h * 0.40, 14); text(g, 'OFF', w * 0.61, h * 0.55, 14); text(g, 'DN', w * 0.61, h * 0.68, 14)
    text(g, 'AUTO BRAKE', w * 0.63, h * 0.86, 12)
    text(g, '737–800', w * 0.1, h * 0.91, 16)
  }, 2.4, 0.68, 0, -0.64, -1.025, staticRoot, 2048, 640)

  const pfd = new InstrumentCanvas(512, 512, drawPFD), nd = new InstrumentCanvas(512, 512, drawND)
  const engines = new InstrumentCanvas(512, 512, draw737Engines)
  const lower = new InstrumentCanvas(512, 512, (g, s, w, h) => {
    g.fillStyle = '#05070a'; g.fillRect(0, 0, w, h)
    text(g, 'FLIGHT CONTROLS', w / 2, 35, 19)
    for (const [i, [label, value]] of ([['AILERON', s[S.AILERON]], ['ELEVATOR', s[S.ELEVATOR]], ['RUDDER', s[S.RUDDER]]] as const).entries()) {
      const y = 110 + i * 100
      text(g, label, w / 2, y - 27, 16)
      g.strokeStyle = '#e1e5e3'; g.beginPath(); g.moveTo(100, y); g.lineTo(412, y); g.stroke()
      g.fillStyle = '#55ec94'; g.fillRect(252 + value * 140, y - 10, 8, 20)
    }
    text(g, `FLAPS ${Math.round(s[S.FLAPS] * 100)}%`, w / 2, 440, 22)
  })
  const standby = new InstrumentCanvas(256, 256, drawPFD)
  instruments.push(pfd, nd, engines, lower, standby)
  for (const side of [-1, 1]) {
    display(pfd, side * 0.78, -0.53)
    display(nd, side * 0.455, -0.53)
    for (const x of [0.78, 0.64, 0.49, 0.35]) knob(side * x, -0.85, -0.99, 0.015)
  }
  display(engines, 0.055, -0.51, 0.25, 0.25)
  display(lower, 0.055, -0.82, 0.25, 0.23)
  display(standby, -0.185, -0.46, 0.105, 0.12)
  surface((g, w, h) => { panelBackground(g, w, h); dial(g, w / 2, h / 2, h * 0.43, 'ALT') }, 0.108, 0.108, -0.185, -0.63, -0.985, staticRoot, 256, 256)
  const gear = new Group(); gear.position.set(0.285, -0.52, -0.95); root.add(gear)
  rod([0, 0, 0], [0, -0.06, 0.07], 0.009, silver, gear)
  const gearGrip = knob(0, -0.06, 0.075, 0.027, gear, ivory)
  gearGrip.userData.cockpitCommand = { type: 'toggle_gear' } satisfies SimCommand
  knob(0.31, -0.89, -0.98, 0.02)

  // MCP and EFIS, above the glareshield. Dynamic values share one texture.
  const mcp = new InstrumentCanvas(2048, 256, drawMcp); instruments.push(mcp)
  box(1.46, 0.185, 0.085, panel, 0.04, -0.15, -1.11, staticRoot, 0.012)
  mesh(new PlaneGeometry(1.44, 0.18), new MeshBasicMaterial({ map: mcp.texture, toneMapped: false }), staticRoot, 0.04, -0.15, -1.065)
  for (const u of [0.07, 0.28, 0.46, 0.63, 0.8, 0.94]) {
    const active = [0.28, 0.46, 0.63].includes(u)
    const control = knob(0.04 + (u - 0.5) * 1.44, -0.193, -1.042, u === 0.8 ? 0.012 : 0.019, active ? root : staticRoot)
    if (active) {
      control.userData.cockpitCommand = { type: 'autopilot', ...(u === 0.28 ? { speed_delta_kt: 5 } : u === 0.46 ? { heading_delta: 5 } : { altitude_delta_ft: 500 }) } satisfies SimCommand
      control.userData.cockpitShiftCommand = { type: 'autopilot', ...(u === 0.28 ? { speed_delta_kt: -5 } : u === 0.46 ? { heading_delta: -5 } : { altitude_delta_ft: -500 }) } satisfies SimCommand
      control.userData.cockpitLabel = `${u === 0.28 ? 'Speed +5 kt' : u === 0.46 ? 'Heading +5°' : 'Altitude +500 ft'} · Shift-click to decrease`
    }
  }
  const apButton = box(0.078, 0.034, 0.007, new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }), 0.04 + 0.36 * 1.44, -0.179, -1.055, root)
  apButton.userData.cockpitCommand = { type: 'toggle_autopilot' } satisfies SimCommand
  apButton.userData.cockpitLabel = 'Autopilot on / off · Z'
  gearGrip.userData.cockpitLabel = 'Landing gear up / down · G'
  for (const side of [-1, 1]) {
    const efis = new Group(); efis.position.set(side * 0.9, -0.15, -1.10); staticRoot.add(efis)
    box(0.29, 0.185, 0.07, panel, 0, 0, 0, efis, 0.009)
    surface(drawEfis, 0.285, 0.18, 0, 0, 0.036, efis, 512, 320)
    for (const [x, y] of [[-0.086, 0.032], [0.086, 0.032], [-0.057, -0.033], [0.069, -0.033]]) knob(x, y, 0.053, 0.015, efis)
    surface((g, w, h) => {
      g.fillStyle = '#17191b'; g.fillRect(0, 0, w, h)
      button(g, 'FIRE\nWARN', w * 0.25, h / 2, w * 0.42, h * 0.8)
      button(g, 'MASTER\nCAUTION', w * 0.75, h / 2, w * 0.42, h * 0.8)
    }, 0.135, 0.055, side * 1.13, -0.15, -1.045, staticRoot, 256, 96)
  }

  // Center pedestal slopes away under the instrument panel instead of covering it.
  box(0.46, 0.20, 1.25, panel, 0, -1.13, -0.15, staticRoot, 0.025)
  box(0.42, 0.24, 0.38, panel, 0, -0.97, -0.27, staticRoot, 0.018)
  box(0.44, 0.27, 0.57, panel, 0, -0.89, 0.24, staticRoot, 0.018)
  const fmcDeck = new Group(); fmcDeck.position.set(0, -0.87, -0.67); fmcDeck.rotation.x = -0.93; staticRoot.add(fmcDeck)
  for (const side of [-1, 1]) {
    box(0.21, 0.29, 0.025, dark, side * 0.116, 0, 0, fmcDeck, 0.008)
    surface(drawFmc, 0.2, 0.28, side * 0.116, 0, 0.014, fmcDeck, 384, 512)
  }
  const quadrant = new Group(); quadrant.position.set(0, -0.78, -0.27); root.add(quadrant)
  box(0.32, 0.13, 0.36, ivory, 0, -0.04, 0, quadrant, 0.03)
  for (const side of [-1, 1]) {
    const wheel = mesh(new CylinderGeometry(0.115, 0.115, 0.023, 32), rubber, quadrant, side * 0.19, -0.025, 0.03)
    wheel.rotation.z = Math.PI / 2
    rod([side * 0.207, -0.10, 0.03], [side * 0.207, 0.05, 0.03], 0.006, ivory, quadrant)
  }
  const throttles: Object3D[] = []
  const throttleGrips: Mesh[] = []
  for (const side of [-1, 1]) {
    const lever = new Group(); lever.position.set(side * 0.045, 0.02, 0); quadrant.add(lever)
    rod([0, 0, 0], [0, 0.19, 0], 0.011, silver, lever)
    const grip = box(0.069, 0.045, 0.07, ivory, 0, 0.2, 0, lever, 0.012)
    grip.userData.cockpitLabel = 'Throttle +10% · Shift-click to decrease'
    grip.userData.cockpitCommand = { type: 'set_throttle', value: 0.1 } satisfies SimCommand
    grip.userData.cockpitShiftCommand = { type: 'set_throttle', value: 0 } satisfies SimCommand
    throttleGrips.push(grip)
    box(0.055, 0.014, 0.075, dark, 0, 0.155, -0.022, lever, 0.004)
    const number = surface((g, w, h) => { g.fillStyle = '#d9d6c9'; g.fillRect(0, 0, w, h); text(g, side < 0 ? '1' : '2', w / 2, h / 2, 60, '#242626') }, 0.035, 0.025, 0, 0.2, 0.036, lever, 96, 64)
    number.userData = grip.userData
    throttles.push(lever)
  }
  rod([-0.13, 0, 0], [-0.13, 0.14, -0.05], 0.009, silver, quadrant)
  const speedbrake = box(0.025, 0.055, 0.06, dark, -0.13, 0.16, -0.05, quadrant, 0.007)
  speedbrake.userData.cockpitCommand = { type: 'toggle_spoilers' } satisfies SimCommand
  speedbrake.userData.cockpitLabel = 'Speed brakes extend / retract · /'
  const flapHandle = new Group(); flapHandle.position.set(0.14, 0, 0.06); quadrant.add(flapHandle)
  rod([0, 0, 0], [0, 0.13, 0], 0.008, silver, flapHandle)
  const flapGrip = box(0.05, 0.035, 0.06, ivory, 0, 0.14, 0, flapHandle, 0.008)
  flapGrip.userData.cockpitCommand = { type: 'flaps_down' } satisfies SimCommand
  flapGrip.userData.cockpitShiftCommand = { type: 'flaps_up' } satisfies SimCommand
  flapGrip.userData.cockpitLabel = 'Flaps down one notch · Shift-click for flaps up'
  // Aft radio / audio panels, fire handles and parking brake.
  const radios = new Group(); radios.position.set(0, -0.745, 0.24); radios.rotation.x = -Math.PI / 2; staticRoot.add(radios)
  surface((g, w, h) => {
    panelBackground(g, w, h)
    for (let row = 0; row < 4; row++) {
      const y = 30 + row * 120
      text(g, ['VHF 1', 'VHF 2', 'NAV', 'TRANSPONDER'][row], w / 2, y, 16)
      g.fillStyle = '#131711'; g.fillRect(40, y + 20, w - 80, 42)
      text(g, row === 3 ? '1200    STBY' : '---.---     ---.---', w / 2, y + 43, 25, '#d3d6ad')
      for (let col = 0; col < 5; col++) button(g, ['1', '2', '3', 'TEST', 'OFF'][col], 60 + col * 70, y + 85, 45, 20)
    }
  }, 0.40, 0.55, 0, 0, 0, radios, 400, 512)
  for (const x of [-0.1, 0, 0.1]) box(0.06, 0.03, 0.05, red, x, -0.73, 0.58, staticRoot, 0.005)

  // Characteristic floor-mounted Boeing U-shaped control columns.
  const yokes: Group[] = []
  for (const x of [model.eye.x, -model.eye.x]) {
    const column = new Group(); column.position.set(x, -0.66, -0.82); root.add(column)
    rod([0, -0.39, 0.12], [0, -0.04, 0], 0.035, dark, column)
    const wheel = new Group(); column.add(wheel)
    box(0.11, 0.10, 0.065, dark, 0, 0, 0, wheel, 0.02)
    const shape = [[-0.17, 0.09, 0.03], [-0.16, -0.025, 0.025], [-0.105, -0.065, 0], [0, -0.035, 0], [0.105, -0.065, 0], [0.16, -0.025, 0.025], [0.17, 0.09, 0.03]]
    for (let i = 1; i < shape.length; i++) rod(shape[i - 1], shape[i], 0.021, rubber, wheel)
    for (const side of [-1, 1]) box(0.04, 0.085, 0.046, rubber, side * 0.17, 0.075, 0.03, wheel, 0.014)
    box(0.016, 0.014, 0.025, red, -0.17, 0.117, 0.035, wheel, 0.003)
    surface((g, w, h) => { g.fillStyle = '#1d2022'; g.fillRect(0, 0, w, h); text(g, 'BOEING', w / 2, 25, 20); text(g, '737', w / 2, 54, 19); text(g, 'CHECKLIST', w / 2, 84, 10) }, 0.072, 0.067, 0, 0, 0.034, wheel, 128, 112)
    column.userData.wheel = wheel; yokes.push(column)
    box(0.45, 0.12, 0.48, seat, x, -0.93, 0.26, staticRoot, 0.055)
    box(0.45, 0.68, 0.14, seat, x, -0.59, 0.56, staticRoot, 0.055)
    for (const dx of [-0.12, 0.12]) {
      const pedal = box(0.16, 0.10, 0.035, dark, x + dx, -1.13, -0.83); pedal.rotation.x = -0.45
      for (let i = 0; i < 5; i++) box(0.14, 0.004, 0.006, silver, x + dx, -1.165 + i * 0.016, -0.80)
    }
  }

  // Overhead is a detailed shallow panel, with real three-dimensional toggles.
  const overhead = new Group(); overhead.position.set(0, 0.52, -0.3); overhead.rotation.x = 1.34; staticRoot.add(overhead)
  box(0.78, 1.03, 0.045, panel, 0, 0, 0, overhead, 0.015)
  surface(drawOverhead, 0.76, 1.01, 0, 0, 0.024, overhead, 1024, 1400)
  for (let row = 0; row < 4; row++) for (let col = 0; col < 3; col++) for (let i = 0; i < 3; i++) {
    const x = -0.38 + (col + 0.2 + i * 0.3) * 0.76 / 3
    const y = 0.505 - (row + 0.64) * 1.01 / 4
    knob(x, y, 0.031, 0.009, overhead, silver)
    rod([x, y, 0.04], [x, y + 0.012, 0.067], 0.004, ivory, overhead)
  }
  for (const x of [-0.29, 0.29]) box(0.044, 0.048, 0.025, red, x, 0.36, 0.045, overhead, 0.006)
  // Caution light lenses on the forward panel.
  for (const x of [0.245, 0.285, 0.325]) box(0.021, 0.014, 0.004, amber, x, -0.37, -0.982)

  // Bake decorative hardware by material: hundreds of small parts, only a few
  // draw calls. Animated controls and clickable hit targets stay separate.
  root.updateMatrixWorld(true)
  const inverse = root.matrixWorld.clone().invert()
  const batches = new Map<Material, BufferGeometry[]>()
  staticRoot.traverse((o) => {
    if (!(o instanceof Mesh)) return
    const mat = o.material as Material
    const geometry = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()).applyMatrix4(inverse.clone().multiply(o.matrixWorld))
    const batch = batches.get(mat) ?? []; batch.push(geometry); batches.set(mat, batch)
    o.geometry.dispose()
  })
  root.remove(staticRoot)
  for (const [mat, geometries] of batches) {
    const merged = mergeGeometries(geometries)
    if (merged) { const m = new Mesh(merged, mat); m.name = '737-static-panel'; root.add(m) }
    geometries.forEach((g) => g.dispose())
  }
  root.traverse((o) => o.layers.enableAll())
  let lastDraw = -Infinity
  return {
    root, instruments, yoke: yokes[0], stick: null, throttles,
    update(s, c) {
      const now = performance.now()
      if (now - lastDraw >= 50) { lastDraw = now; for (const i of instruments) i.update(s) }
      for (const column of yokes) {
        column.rotation.x = -c.pitch * 0.13
        ;(column.userData.wheel as Group).rotation.z = -c.roll * 0.9
      }
      throttles.forEach((t) => { t.rotation.x = -0.45 + c.throttle * 0.9 })
      for (const grip of throttleGrips) {
        grip.userData.cockpitCommand.value = Math.min(1, c.throttle + 0.1)
        grip.userData.cockpitShiftCommand.value = Math.max(0, c.throttle - 0.1)
      }
      gear.rotation.x = (1 - s[S.GEAR]) * -0.9
      flapHandle.rotation.x = s[S.FLAPS] * 0.8
    },
    dispose() { instruments.forEach((i) => i.dispose()); textures.forEach((t) => t.dispose()) },
  }
}
