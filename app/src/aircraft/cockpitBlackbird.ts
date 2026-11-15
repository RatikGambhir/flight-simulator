// Forward pilot station based on T.O. SR-71A-1 figures 1-12 through 1-15
// and the U.S. Air Force museum's photographs of 61-7976.
import {
  BoxGeometry, BufferGeometry, CylinderGeometry, DoubleSide, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, Object3D, Shape, ShapeGeometry, TorusGeometry, Vector2, Vector3, type Material,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { Flags, S, hasFlag, type SimCommand } from '../sim/protocol'
import type { Cockpit } from './cockpit'
import { InstrumentCanvas } from './instruments'
import { DEG, font } from './instruments/style'
import type { AircraftModel } from './models'

const PANEL = '#292b2e'
const IVORY = '#deddd5'
const AMBER = '#e8a15d'
const FACE_WIDTH = 1000
const FACE_HEIGHT = 580
const PANEL_OUTLINE = [
  [1, 210], [226, 163], [408, 60], [452, 29], [548, 29], [592, 60], [774, 163], [999, 210],
  [999, 510], [636, 536], [630, 579], [370, 579], [364, 536], [1, 510],
] as const

type Point = [number, number, number]

function dial(g: CanvasRenderingContext2D, x: number, y: number, r: number, label: string, fraction: number, ticks: string[]) {
  g.save()
  g.translate(x, y)
  g.fillStyle = '#0c1011'
  g.strokeStyle = '#525751'
  g.lineWidth = 4
  g.beginPath()
  g.arc(0, 0, r, 0, 2 * Math.PI)
  g.fill()
  g.stroke()
  g.fillStyle = IVORY
  g.strokeStyle = IVORY
  g.font = font(Math.min(12, r * 0.23))
  for (let i = 0; i <= 20; i++) {
    const theta = (-136 + i * 13.6) * DEG
    const dx = Math.sin(theta)
    const dy = -Math.cos(theta)
    const major = i % 5 === 0
    g.lineWidth = major ? 2 : 1
    g.beginPath()
    g.moveTo(dx * r * 0.89, dy * r * 0.89)
    g.lineTo(dx * r * (major ? 0.76 : 0.83), dy * r * (major ? 0.76 : 0.83))
    g.stroke()
    if (major) g.fillText(ticks[i / 5], dx * r * 0.61, dy * r * 0.58)
  }
  g.font = font(Math.min(11, r * 0.24))
  g.fillText(label, 0, r * 0.72)
  g.rotate((-136 + 272 * Math.max(0, Math.min(1, fraction))) * DEG)
  g.fillStyle = IVORY
  g.beginPath()
  g.moveTo(-2, 9)
  g.lineTo(-2.6, -r * 0.53)
  g.lineTo(0, -r * 0.77)
  g.lineTo(2.6, -r * 0.53)
  g.lineTo(2, 9)
  g.fill()
  g.fillStyle = '#646863'
  g.beginPath()
  g.arc(0, 0, 4, 0, Math.PI * 2)
  g.fill()
  g.restore()
}

function attitude(g: CanvasRenderingContext2D, s: Float64Array, x: number, y: number, r: number, director = false) {
  const scale = r / 70
  g.fillStyle = '#141719'
  g.fillRect(x - r - 5, y - r - 5, 2 * r + 10, 2 * r + 10)
  g.save()
  g.translate(x, y)
  g.beginPath()
  g.arc(0, 0, r, 0, Math.PI * 2)
  g.clip()
  g.rotate(-s[S.ROLL] * DEG)
  g.translate(0, Math.max(-80, Math.min(80, s[S.PITCH] * 2.6 * scale)))
  g.fillStyle = '#bec4c5'
  g.fillRect(-200, -200, 400, 200)
  g.fillStyle = '#252831'
  g.fillRect(-200, 0, 400, 200)
  g.strokeStyle = IVORY
  g.fillStyle = IVORY
  g.lineWidth = 2
  g.font = font(11 * scale)
  g.beginPath()
  g.moveTo(-160, 0)
  g.lineTo(160, 0)
  for (const pitch of [-20, -10, 10, 20]) {
    const py = -pitch * 2.6 * scale
    g.moveTo(-27 * scale, py)
    g.lineTo(27 * scale, py)
    g.fillText(String(Math.abs(pitch)), -37 * scale, py)
    g.fillText(String(Math.abs(pitch)), 37 * scale, py)
  }
  g.stroke()
  g.restore()

  g.strokeStyle = '#121718'
  g.lineWidth = 6
  g.beginPath()
  g.arc(x, y, r, 0, Math.PI * 2)
  g.stroke()
  g.strokeStyle = AMBER
  g.lineWidth = 3
  g.beginPath()
  g.moveTo(x - r * 0.67, y)
  g.lineTo(x - r * 0.26, y)
  g.lineTo(x, y + r * 0.14)
  g.lineTo(x + r * 0.26, y)
  g.lineTo(x + r * 0.67, y)
  g.stroke()
  if (director) {
    const offset = Math.max(-r * 0.5, Math.min(r * 0.5, -s[S.VS_FPM] * 0.012))
    g.strokeStyle = '#d0d6a2'
    g.lineWidth = 1.5
    g.beginPath()
    g.moveTo(x - r * 0.59, y + offset)
    g.lineTo(x + r * 0.59, y + offset)
    g.stroke()
  }
}

/** Recover approximate pitot-indicated airspeed from the simulator's EAS and true Mach. */
function indicatedAirspeed(eas: number, mach: number) {
  if (mach < 0.3) return eas
  const pitotPressure = (m: number) => m < 1
    ? (1 + 0.2 * m * m) ** 3.5
    : ((36 * m * m) / (35 * m * m - 5)) ** 3.5 * (7 * m * m - 1) / 6
  const impact = 0.5 * 1.225 * (eas * 0.514444) ** 2 * (pitotPressure(mach) - 1) / (0.7 * mach * mach)
  const ratio = 1 + impact / 101325
  let low = 0
  let high = 3
  for (let i = 0; i < 16; i++) {
    const mid = (low + high) / 2
    if (pitotPressure(mid) < ratio) low = mid
    else high = mid
  }
  return 661.48 * (low + high) / 2
}

function hsi(g: CanvasRenderingContext2D, heading: number, x: number, y: number) {
  g.save()
  g.translate(x, y)
  g.fillStyle = '#111416'
  g.strokeStyle = '#555657'
  g.lineWidth = 4
  g.beginPath()
  g.arc(0, 0, 60, 0, 2 * Math.PI)
  g.fill()
  g.stroke()
  g.save()
  g.rotate(-heading * DEG)
  g.fillStyle = IVORY
  g.font = font(13)
  for (let i = 0; i < 36; i++) {
    g.fillRect(-0.6, -54, 1.2, i % 3 === 0 ? 8 : 4)
    if (i % 3 === 0) {
      g.fillText(i % 9 === 0 ? 'NESW'[i / 9] : String(i), 0, -37)
    }
    g.rotate(10 * DEG)
  }
  g.restore()
  g.fillStyle = AMBER
  g.fillRect(-2, -61, 4, 12)
  g.fillRect(-1.5, -22, 3, 34)
  g.fillRect(-15, -2, 30, 3)
  g.fillRect(-7, 8, 14, 3)
  g.restore()
}

function lamp(g: CanvasRenderingContext2D, x: number, y: number, label: string, lit = false, color = '#b33c2e') {
  g.fillStyle = lit ? color : '#151718'
  g.fillRect(x - 27, y - 8, 54, 16)
  g.fillStyle = lit ? IVORY : '#8b8b85'
  g.font = font(8)
  g.fillText(label, x, y)
}

function drawPanel(g: CanvasRenderingContext2D, s: Float64Array, w: number, h: number) {
  g.clearRect(0, 0, w, h)
  g.save()
  g.beginPath()
  for (const [i, [x, y]] of PANEL_OUTLINE.entries()) {
    if (i === 0) g.moveTo(x, y)
    else g.lineTo(x, y)
  }
  g.closePath()
  g.clip()

  g.fillStyle = PANEL
  g.fillRect(0, 0, w, h)
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillStyle = '#222427'
  g.fillRect(18, 185, 250, 343)
  g.fillRect(722, 179, 260, 353)
  g.strokeStyle = '#4c4d4e'
  g.strokeRect(20, 185, 247, 342)
  g.strokeRect(726, 182, 251, 346)

  attitude(g, s, 505, 104, 41)
  attitude(g, s, 505, 232, 73, true)
  hsi(g, s[S.HEADING], 505, 378)

  const eas = s[S.IAS_KT]
  const mach = s[S.MACH]
  const ias = indicatedAirspeed(eas, mach)
  const alt = s[S.ALT_MSL_FT]
  const alpha = s[S.ALPHA]
  dial(g, 303, 224, 38, 'ALPHA', (alpha + 5) / 30, ['−5', '', '10', '', '25'])
  dial(g, 390, 235, 48, 'KNOTS', ias / 600, ['0', '150', '300', '450', '600'])
  g.fillStyle = '#1b1d1f'
  g.fillRect(371, 247, 38, 13)
  g.fillStyle = IVORY
  g.font = font(10)
  g.fillText(mach.toFixed(2), 390, 254)
  dial(g, 642, 232, 51, 'ALT', (Math.max(0, alt) % 1000) / 1000, ['0', '2.5', '5', '7.5', '10'])
  g.fillStyle = '#0f1213'
  g.fillRect(620, 242, 44, 16)
  g.fillStyle = IVORY
  g.font = font(10)
  g.fillText(String(Math.round(alt / 10) * 10), 642, 250)
  dial(g, 643, 357, 47, 'V/S × 1000', (s[S.VS_FPM] + 6000) / 12000, ['−6', '−3', '0', '+3', '+6'])
  dial(g, 314, 372, 33, 'G', (s[S.G_LOAD] + 2) / 6, ['−2', '', '1', '', '4'])
  dial(g, 645, 135, 32, 'BANK', (s[S.ROLL] + 60) / 120, ['−60', '', '0', '', '60'])

  // Stacked numeric windows of the Triple Display Indicator, left of the HSI.
  g.fillStyle = '#111414'
  g.fillRect(354, 311, 84, 124)
  g.strokeStyle = '#575a57'
  g.strokeRect(354, 311, 84, 124)
  for (const [i, [label, value]] of [
    ['ALT', String(Math.round(alt / 50) * 50).padStart(5, '0')],
    ['KEAS', Math.round(eas).toString().padStart(3, '0')],
    ['MACH', mach.toFixed(2)],
  ].entries()) {
    const y = 323 + i * 37
    g.fillStyle = IVORY
    g.font = font(9)
    g.fillText(label, 396, y)
    g.fillStyle = '#1d221e'
    g.fillRect(362, y + 7, 68, 21)
    g.fillStyle = '#c7daad'
    g.font = font(19)
    g.fillText(value, 396, y + 18)
  }

  // Left inlet controls and trim indications; paired J58 instruments on the right.
  for (const [i, label] of ['CIT', 'SPIKE', 'FWD BYP', 'RESTART', 'PITCH TRIM', 'ROLL TRIM'].entries()) {
    const x = 82 + (i % 2) * 114
    const y = 234 + Math.floor(i / 2) * 103
    const spike = Math.max(0, Math.min(1, (mach - 1.6) / 1.6))
    dial(g, x, y, 31, label, label === 'SPIKE' ? spike : 0, ['', '', '', '', ''])
    g.fillStyle = '#727570'
    g.fillRect(x - 6, y + 36, 12, 4)
  }

  const engineGauges: [string, number, string[]][] = [
    ['RPM %', s[S.ENGINE], ['0', '', '50', '', '100']],
    ['EGT', 0, ['0', '', '4', '', '8']],
    ['NOZZLE', s[S.AFTERBURNER], ['', '', '', '', '']],
    ['FUEL FLOW', 0, ['', '', '', '', '']],
    ['OIL PRESS', 0, ['', '', '', '', '']],
  ]
  for (const [i, [label, value, ticks]] of engineGauges.entries()) {
    for (const x of [790, 909]) dial(g, x, 240 + i * 62, 28, label, value, ticks)
  }

  lamp(g, 789, 202, 'L FIRE')
  lamp(g, 910, 204, 'R FIRE')
  lamp(g, 789, 271, 'L A/B', s[S.AFTERBURNER] > 0.001, '#855324')
  lamp(g, 910, 271, 'R A/B', s[S.AFTERBURNER] > 0.001, '#855324')
  lamp(g, 316, 320, 'KEAS', hasFlag(s, Flags.OVERSPEED))
  lamp(g, 316, 282, 'AOA', hasFlag(s, Flags.STALL))
  for (const [x, y] of [[235, 309], [222, 326], [249, 326]]) {
    g.fillStyle = s[S.GEAR] > 0.98 ? '#93be71' : '#172318'
    g.fillRect(x - 4, y - 4, 8, 8)
  }

  g.fillStyle = '#101214'
  g.fillRect(445, 452, 120, 91)
  g.fillStyle = '#34383a'
  g.fillRect(454, 460, 102, 71)
  g.strokeStyle = '#676866'
  g.strokeRect(454, 460, 102, 71)
  g.font = font(8)
  g.fillStyle = '#9a9b8d'
  g.fillText('NAV MAP', 505, 541)

  for (const y of [476, 489]) {
    g.fillStyle = '#141617'
    g.fillRect(293, y, 99, 7)
  }
  for (const [x, y] of [[22, 216], [24, 499], [266, 182], [270, 521], [447, 76], [558, 76], [700, 194], [706, 518], [980, 221], [980, 500]]) {
    g.fillStyle = '#70716b'
    g.beginPath()
    g.arc(x, y, 2.6, 0, 2 * Math.PI)
    g.fill()
    g.fillStyle = '#242628'
    g.fillRect(x - 2, y, 4, 1)
  }
  g.restore()
}

export function buildBlackbirdCockpit(model: AircraftModel): Cockpit {
  const root = new Group()
  root.name = 'cockpit'
  root.position.copy(model.eye)
  const surround = new MeshStandardMaterial({ color: '#414756', roughness: 0.9 })
  const black = new MeshStandardMaterial({ color: '#181d1d', roughness: 0.92 })
  const coaming = new MeshStandardMaterial({ color: '#1d1f23', roughness: 0.98, side: DoubleSide })
  const panel = new MeshStandardMaterial({ color: PANEL, roughness: 1 })
  const metal = new MeshStandardMaterial({ color: '#929486', roughness: 0.56, metalness: 0.3 })
  const gasket = new MeshStandardMaterial({ color: '#895536', roughness: 0.86 })
  const khaki = new MeshStandardMaterial({ color: '#656647', roughness: 0.97 })
  const guard = new MeshStandardMaterial({ color: '#8e3430', roughness: 0.77 })
  const staticParts = new Map<Material, BufferGeometry[]>()
  const localBox = (w: number, h: number, d: number) => new BoxGeometry(w, h, d)
  const fixture = (geometry: BufferGeometry, mat: Material) => {
    const geometries = staticParts.get(mat) ?? []
    geometries.push(geometry)
    staticParts.set(mat, geometries)
  }
  const box = (size: Point, mat: Material, at: Point, tilt = 0) => {
    fixture(localBox(...size).rotateX(tilt).translate(...at), mat)
  }
  const beam = (from: Point, to: Point, width: number, mat: Material) => {
    const a = new Vector3(...from)
    const b = new Vector3(...to)
    const direction = b.clone().sub(a)
    const geometry = localBox(width, direction.length() + width * 0.5, width)
    const bar = new Object3D()
    bar.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize())
    bar.position.copy(a).lerp(b, 0.5)
    bar.updateMatrix()
    fixture(geometry.applyMatrix4(bar.matrix), mat)
  }
  const moving = (geometry: BufferGeometry, mat: Material, parent: Group, x: number, y: number, z: number) => {
    const m = new Mesh(geometry, mat)
    m.position.set(x, y, z)
    parent.add(m)
    return m
  }
  const clickable = (object: Mesh, label: string, cmd: SimCommand, shift?: SimCommand) => {
    object.userData.cockpitLabel = label
    object.userData.cockpitCommand = cmd
    if (shift) object.userData.cockpitShiftCommand = shift
    return object
  }

  box([1.07, 0.055, 2.05], surround, [0, -1.36, -0.36])
  box([1.10, 1.7, 0.08], surround, [0, -0.54, 0.65])
  box([0.53, 0.05, 1.01], black, [0, 0.355, 0.04])
  box([0.30, 0.40, 0.09], black, [0, -1.04, -1.03])
  for (let i = 0; i < 6; i++) box([0.24, 0.022, 0.015], panel, [0, -0.883 - i * 0.045, -0.977])
  box([0.47, 0.13, 0.69], khaki, [0, -1.08, 0.23])
  box([0.45, 0.65, 0.16], black, [0, -0.70, 0.47], -0.12)
  box([0.28, 0.15, 0.085], khaki, [0, -0.29, 0.44], -0.12)
  box([0.20, 0.11, 0.08], guard, [0, -0.98, -0.10], -0.16)
  fixture(new TorusGeometry(0.05, 0.009, 8, 18, Math.PI).scale(1.25, 0.72, 1).translate(0, -0.933, -0.121), metal)

  // The forward windscreen is a folded V made from two triangular panes. The
  // canopy's side windows start behind its thick diagonal frame.
  const peak: Point = [0, 0.40, -1.46]
  const ridgeFoot: Point = [0, -0.40, -2.46]
  const glassVertices: number[] = []
  const coamingVertices: number[] = []
  beam(ridgeFoot, peak, 0.039, black)
  beam(peak, [0, 0.35, -0.51], 0.067, black)
  const faceWidth = 1.25
  const faceHeight = 0.725
  const faceY = -0.489
  const faceZ = -1.09
  const faceTilt = -0.10
  const faceX = (x: number) => (x / FACE_WIDTH - 0.5) * faceWidth
  const faceUp = (y: number) => (0.5 - y / FACE_HEIGHT) * faceHeight
  const fasciaPoint = ([px, py]: readonly [number, number]): Point => {
    const y = faceUp(py)
    return [faceX(px), faceY + y * Math.cos(faceTilt), faceZ + y * Math.sin(faceTilt)]
  }
  const sills: Point[] = [[-0.64, -0.30, -1.02], [0.64, -0.30, -1.02]]
  const windscreenBase = (x: number) => new Vector3(...ridgeFoot).lerp(new Vector3(...sills[x < 0 ? 0 : 1]), Math.abs(x) / 0.64).toArray()
  for (let i = 0; i < 7; i++) {
    beam(fasciaPoint(PANEL_OUTLINE[i]), fasciaPoint(PANEL_OUTLINE[i + 1]), 0.033, black)
    const a = fasciaPoint(PANEL_OUTLINE[i])
    const b = fasciaPoint(PANEL_OUTLINE[i + 1])
    const frontA = windscreenBase(a[0])
    const frontB = windscreenBase(b[0])
    coamingVertices.push(...a, ...frontA, ...frontB, ...a, ...frontB, ...b)
  }
  for (const side of [-1, 1]) {
    const x = (n: number) => n * side
    const sill = sills[side === -1 ? 0 : 1]
    const roof: Point = [x(0.29), 0.34, -0.98]
    const header: Point = [x(0.30), 0.32, 0.43]
    const aft: Point = [x(0.65), -0.30, 0.43]
    glassVertices.push(...peak, ...sill, ...ridgeFoot, ...sill, ...roof, ...header, ...sill, ...header, ...aft)
    box([0.075, 1.02, 1.97], surround, [x(0.66), -0.81, -0.38])
    box([0.23, 0.18, 1.34], surround, [x(0.54), -0.66, -0.32])
    box([0.204, 0.018, 1.22], black, [x(0.54), -0.563, -0.32])
    beam(peak, sill, 0.077, surround)
    beam(peak, roof, 0.06, surround)
    beam(roof, header, 0.060, black)
    beam(header, aft, 0.076, surround)
    beam(sill, aft, 0.071, surround)
    beam(ridgeFoot, sill, 0.055, black)
    for (let i = 1; i < 13; i++) {
      const point = new Vector3(...peak).lerp(new Vector3(...sill), i / 13)
      fixture(new CylinderGeometry(0.012, 0.012, 0.009, 8).rotateX(Math.PI / 2).translate(point.x - x(0.026), point.y - 0.013, point.z + 0.036), gasket)
    }
    for (let i = 0; i < 10; i++) {
      const z = -0.87 + i * 0.113
      box([0.205, 0.005, 0.007], metal, [x(0.54), -0.552, z])
      for (const column of [0.49, 0.545, 0.60]) {
        const cap = i % 3 === 0 ? 0.018 : 0.010
        fixture(new CylinderGeometry(cap, cap * 0.88, 0.020, 8).translate(x(column), -0.541, z + 0.027), i === 3 && column === 0.49 ? guard : metal)
      }
    }
  }
  const glazing = new BufferGeometry()
  glazing.setAttribute('position', new Float32BufferAttribute(glassVertices, 3))
  root.add(new Mesh(glazing, new MeshBasicMaterial({ color: '#85a2a4', transparent: true, opacity: 0.075, depthWrite: false, side: DoubleSide, forceSinglePass: true })))
  const hood = new BufferGeometry()
  hood.setAttribute('position', new Float32BufferAttribute(coamingVertices, 3))
  hood.computeVertexNormals()
  root.add(new Mesh(hood, coaming))
  fixture(new CylinderGeometry(0.144, 0.144, 0.184, 24, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).translate(-0.54, -0.585, -0.48), surround)
  for (const [mat, geometries] of staticParts) {
    const baked = mergeGeometries(geometries)
    for (const geometry of geometries) geometry.dispose()
    root.add(new Mesh(baked, mat))
  }

  const outline = new Shape(PANEL_OUTLINE.map(([x, y]) => new Vector2(faceX(x), faceUp(y))))
  const face = new ShapeGeometry(outline)
  const uv = face.attributes.uv
  for (let i = 0; i < uv.count; i++) uv.setXY(i, face.attributes.position.getX(i) / faceWidth + 0.5, face.attributes.position.getY(i) / faceHeight + 0.5)
  const flightPanel = new InstrumentCanvas(FACE_WIDTH, FACE_HEIGHT, drawPanel)
  flightPanel.update(new Float64Array(S.LEN))
  const screen = moving(face, new MeshBasicMaterial({ map: flightPanel.texture, toneMapped: false }), root, 0, faceY, faceZ)
  screen.name = 'blackbird-flight-instruments'
  screen.rotation.x = faceTilt

  const stick = new Group()
  stick.position.set(0, -1.15, -0.68)
  root.add(stick)
  moving(new CylinderGeometry(0.047, 0.073, 0.17, 14), black, stick, 0, 0.09, 0)
  moving(new CylinderGeometry(0.026, 0.035, 0.255, 14), black, stick, 0, 0.277, 0)
  moving(localBox(0.075, 0.13, 0.073), black, stick, -0.016, 0.445, 0).rotation.z = 0.32
  moving(localBox(0.107, 0.052, 0.078), black, stick, -0.027, 0.512, 0.006)
  moving(new CylinderGeometry(0.019, 0.017, 0.014, 10).rotateX(Math.PI / 2), metal, stick, -0.028, 0.52, 0.049)
  moving(localBox(0.020, 0.018, 0.024), guard, stick, 0.012, 0.514, -0.034)

  const throttles = [-0.55, -0.45].map((x) => {
    const lever = new Group()
    lever.position.set(x, -0.69, -0.52)
    root.add(lever)
    moving(localBox(0.024, 0.20, 0.03), metal, lever, 0, 0.105, 0)
    const grip = clickable(moving(new CylinderGeometry(0.035, 0.038, 0.081, 14).rotateZ(Math.PI / 2), black, lever, 0, 0.22, 0),
      'Throttle +10% · Shift-click to decrease', { type: 'set_throttle', value: 0.1 }, { type: 'set_throttle', value: 0 })
    return { lever, grip }
  })
  const gearBase = -0.435
  const gear = clickable(moving(new CylinderGeometry(0.032, 0.032, 0.035, 16).rotateX(Math.PI / 2), guard, root, -0.51, gearBase, -0.915),
    'Landing gear', { type: 'toggle_gear' })
  gear.name = 'blackbird-gear'
  const ap = clickable(moving(localBox(0.052, 0.033, 0.045), metal, root, 0.47, -0.516, -0.36),
    'Autopilot', { type: 'toggle_autopilot' })
  ap.name = 'blackbird-autopilot'
  root.traverse((object) => object.layers.enableAll())

  let nextDraw = 0
  return {
    root, instruments: [flightPanel], yoke: null, stick, throttles: throttles.map(({ lever }) => lever),
    update(s, input) {
      const now = performance.now()
      if (now >= nextDraw) {
        nextDraw = now + 50
        flightPanel.update(s)
      }
      stick.rotation.x = -0.25 * input.pitch
      stick.rotation.z = -0.30 * input.roll
      for (const { lever, grip } of throttles) {
        lever.rotation.x = 0.42 - input.throttle * 1.04
        grip.userData.cockpitCommand.value = Math.min(1, input.throttle + 0.1)
        grip.userData.cockpitShiftCommand.value = Math.max(0, input.throttle - 0.1)
      }
      gear.position.y = gearBase - 0.12 * s[S.GEAR]
    },
    dispose() { flightPanel.dispose() },
  }
}
