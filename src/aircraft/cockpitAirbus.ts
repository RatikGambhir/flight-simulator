// Airbus-style flight deck for the A320 and A380: sidesticks on the side consoles, a
// row of large displays behind a low glareshield with the flight control unit, round
// thrust-lever grips (two or four) and slide-out tables where a yoke would be.
// Coordinates are metres relative to the pilot's eye height and fore-aft position,
// with x = 0 on the aircraft centreline.
import { CylinderGeometry, Group, Mesh, MeshBasicMaterial, PlaneGeometry, type Object3D } from 'three'
import { Flags, S, type SimCommand } from '../sim/protocol'
import type { Cockpit } from './cockpit'
import { button, cockpitMaterial, createCockpitKit, dial, INK, panelBackground, text } from './cockpitKit'
import { drawEICAS, drawND, drawPFD, InstrumentCanvas, InstrumentSchedule } from './instruments'
import type { AircraftModel } from './models'

/** The blue-grey paint of Airbus panels. */
const PAINT = '#4d5d70'
const LCD = '#ffb84a'

function lcdWindow(g: CanvasRenderingContext2D, label: string, value: string, x: number, y: number, w: number, h: number) {
  text(g, label, x, y - h * 0.78, h * 0.34)
  g.fillStyle = '#0c0d0b'; g.fillRect(x - w / 2, y - h / 2, w, h)
  g.strokeStyle = '#6f7780'; g.lineWidth = 2; g.strokeRect(x - w / 2, y - h / 2, w, h)
  g.fillStyle = LCD; g.font = `600 ${h * 0.72}px monospace`; g.textAlign = 'center'; g.textBaseline = 'middle'
  g.fillText(value, x, y + h * 0.04)
}

/** Flight control unit. Only values the simulation holds are shown; the rest is dashed. */
function drawFcu(g: CanvasRenderingContext2D, s: Float64Array, w: number, h: number) {
  g.fillStyle = '#2a2f36'; g.fillRect(0, 0, w, h)
  g.strokeStyle = '#15181c'; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6)
  const ap = !!((s[S.FLAGS] | 0) & Flags.AP_ENGAGED)
  const digits = (value: number, length: number) => Math.round(value).toString().padStart(length, '0')
  lcdWindow(g, 'SPD', ap ? digits(s[S.AP_SPEED_KT], 3) : '---', w * 0.14, h * 0.4, w * 0.13, h * 0.3)
  lcdWindow(g, 'HDG', ap ? digits(((s[S.AP_HEADING] % 360) + 360) % 360, 3) : '---', w * 0.34, h * 0.4, w * 0.13, h * 0.3)
  lcdWindow(g, 'ALT', ap ? digits(s[S.AP_ALT_FT], 5) : digits(Math.round(s[S.ALT_MSL_FT] / 100) * 100, 5), w * 0.66, h * 0.4, w * 0.17, h * 0.3)
  lcdWindow(g, 'V/S', '-----', w * 0.87, h * 0.4, w * 0.15, h * 0.3)
  for (const [x, label, lit] of [[0.24, 'LOC', false], [0.44, 'AP1', ap], [0.5, 'AP2', false], [0.56, 'A/THR', ap], [0.76, 'EXPED', false], [0.94, 'APPR', false]] as const) {
    button(g, label, w * x, h * 0.82, w * 0.05, h * 0.2, lit)
  }
}

/** Where the gear lever sits: between the engine display and the first officer's ND. */
const GEAR_X = 0.175

/** The painted main panel, `width` metres across with its top edge 0.30 m below eye height. */
function drawPanel(model: string, wide: boolean, width: number) {
  return (g: CanvasRenderingContext2D, w: number, h: number) => {
    const X = (metres: number) => w * (0.5 + metres / width)
    const Y = (metres: number) => h * (-0.3 - metres) / 0.7
    panelBackground(g, w, h, PAINT)
    for (const side of [-1, 1]) {
      const x = X(side * (width / 2 - 0.085))
      dial(g, x, Y(-0.44), h * 0.085, 'CLOCK')
      text(g, 'PFD   ND', x, Y(-0.59), 13); text(g, 'OFF        BRT', x, Y(-0.63), 11)
    }
    text(g, 'LDG GEAR', X(GEAR_X + 0.03), Y(-0.37), 13)
    text(g, 'UP', X(GEAR_X + 0.055), Y(-0.45), 13); text(g, 'DOWN', X(GEAR_X + 0.055), Y(-0.6), 13)
    text(g, 'AUTO BRK', X(GEAR_X + 0.03), Y(-0.7), 12)
    const modes = wide ? ['BTV', 'LO', 'HI', 'RTO'] : ['LO', 'MED', 'MAX']
    modes.forEach((label, i) => button(g, label, X(GEAR_X + 0.03 + (i - (modes.length - 1) / 2) * 0.036), Y(-0.75), w * 0.0125, h * 0.06))
    text(g, 'A/SKID & N/W STRG', X(GEAR_X + 0.03), Y(-0.82), 10)
    dial(g, X(wide ? -0.215 : -0.2), Y(-0.64), h * 0.085, 'BRAKES')
    text(g, 'ISIS', X(wide ? -0.215 : -0.2), Y(-0.365), 12)
    text(g, model, X(-width / 2 + 0.085), Y(-0.95), 15)
  }
}

/** Side console top: tiller, sidestick well and stowage. */
function drawConsole(g: CanvasRenderingContext2D, w: number, h: number) {
  panelBackground(g, w, h, PAINT)
  g.strokeStyle = '#2c3440'; g.lineWidth = 3
  g.strokeRect(w * 0.08, h * 0.05, w * 0.84, h * 0.22); text(g, 'N/W STEERING', w / 2, h * 0.08, 15)
  g.strokeRect(w * 0.08, h * 0.31, w * 0.84, h * 0.22); text(g, 'SIDE STICK', w / 2, h * 0.34, 15)
  g.strokeRect(w * 0.08, h * 0.57, w * 0.84, h * 0.38); text(g, 'OXY MASK', w / 2, h * 0.61, 15)
  g.fillStyle = '#20252c'; g.fillRect(w * 0.16, h * 0.66, w * 0.68, h * 0.24)
  text(g, 'PULL', w / 2, h * 0.78, 18, '#d9c24a')
}

function drawEfis(g: CanvasRenderingContext2D, w: number, h: number) {
  panelBackground(g, w, h, PAINT)
  text(g, 'QNH', w * 0.16, h * 0.14, 15)
  g.fillStyle = '#0c0d0b'; g.fillRect(w * 0.05, h * 0.22, w * 0.22, h * 0.2)
  text(g, '1013', w * 0.16, h * 0.32, 22, LCD)
  text(g, 'inHg   hPa', w * 0.16, h * 0.86, 11)
  text(g, 'LS  VOR  NAV  ARC  PLAN', w * 0.52, h * 0.44, 10)
  text(g, '10  20  40  80  160  320', w * 0.84, h * 0.44, 9)
  for (const [i, label] of ['CSTR', 'WPT', 'VOR.D', 'NDB', 'ARPT'].entries()) button(g, label, w * (0.36 + i * 0.13), h * 0.16, w * 0.11, h * 0.16)
  for (const [i, label] of ['FD', 'LS'].entries()) button(g, label, w * (0.09 + i * 0.14), h * 0.62, w * 0.11, h * 0.14, i === 0)
}

function drawMcdu(g: CanvasRenderingContext2D, w: number, h: number) {
  panelBackground(g, w, h, PAINT)
  g.fillStyle = '#07090a'; g.fillRect(w * 0.14, h * 0.07, w * 0.72, h * 0.36)
  text(g, 'INIT', w / 2, h * 0.11, 20)
  text(g, 'CO RTE                    FROM/TO', w / 2, h * 0.17, 11)
  text(g, 'GEOFLIGHT', w * 0.32, h * 0.21, 16, '#58d3f0')
  text(g, 'FLT NBR                 COST INDEX', w / 2, h * 0.28, 11)
  text(g, '<INDEX              INIT REQUEST*', w / 2, h * 0.4, 13, LCD)
  for (const x of [w * 0.07, w * 0.93]) for (let i = 0; i < 6; i++) button(g, '—', x, h * (0.12 + i * 0.055), 26, 14)
  const pages = ['DIR', 'PROG', 'PERF', 'INIT', 'DATA', 'F-PLN', 'RAD\nNAV', 'FUEL\nPRED', 'SEC\nF-PLN', 'ATC\nCOMM', 'MCDU\nMENU', 'AIR\nPORT']
  pages.forEach((label, i) => button(g, label, w * (0.12 + i % 6 * 0.152), h * (0.5 + Math.floor(i / 6) * 0.075), 46, 30))
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ/ '
  for (let i = 0; i < 28; i++) button(g, letters[i], w * (0.42 + i % 5 * 0.118), h * (0.67 + Math.floor(i / 5) * 0.052), 30, 24)
  for (let i = 0; i < 12; i++) button(g, '123456789.0-'[i], w * (0.09 + i % 3 * 0.098), h * (0.72 + Math.floor(i / 3) * 0.06), 24, 24)
}

function drawOverhead(g: CanvasRenderingContext2D, w: number, h: number) {
  panelBackground(g, w, h, PAINT)
  const titles = ['ADIRS', 'FIRE', 'EVAC', 'FLT CTL', 'HYD', 'FLT CTL', 'FUEL', 'ELEC', 'CARGO', 'AIR COND', 'ANTI ICE', 'CABIN PRESS', 'EXT LT', 'APU', 'SIGNS']
  const cw = w / 3, ch = h / 5
  titles.forEach((title, index) => {
    const x = index % 3 * cw, y = Math.floor(index / 3) * ch
    g.strokeStyle = '#c5cad0'; g.lineWidth = 2; g.strokeRect(x + 8, y + 8, cw - 16, ch - 16)
    text(g, title, x + cw / 2, y + 26, 17)
    // Square pushbutton lights: dark when everything is normal.
    for (let row = 0; row < 2; row++) for (let i = 0; i < 4; i++) {
      const xx = x + cw * (0.17 + i * 0.22), yy = y + ch * (0.42 + row * 0.33)
      g.fillStyle = '#15181b'; g.fillRect(xx - 21, yy - 21, 42, 42)
      g.strokeStyle = '#8a9198'; g.lineWidth = 1; g.strokeRect(xx - 21, yy - 21, 42, 42)
      text(g, ['FAULT', 'OFF', 'ON', 'AUTO'][(i + row + index) % 4], xx, yy + 9, 10, '#5d666e')
    }
  })
}

/** System display: the flight controls and configuration the simulation actually has. */
function drawSystems(g: CanvasRenderingContext2D, s: Float64Array, w: number, h: number) {
  g.fillStyle = '#05070a'; g.fillRect(0, 0, w, h)
  text(g, 'F/CTL', w * 0.14, 30, 22)
  g.strokeStyle = INK; g.lineWidth = 2; g.beginPath(); g.moveTo(w * 0.04, 46); g.lineTo(w * 0.24, 46); g.stroke()
  for (const [i, [label, value]] of ([['AIL', s[S.AILERON]], ['ELEV', s[S.ELEVATOR]], ['RUD', s[S.RUDDER]]] as const).entries()) {
    const y = 120 + i * 92
    text(g, label, w * 0.12, y, 18)
    g.strokeStyle = '#dfe4e2'; g.beginPath(); g.moveTo(w * 0.24, y); g.lineTo(w * 0.9, y); g.stroke()
    for (const tick of [0.24, 0.57, 0.9]) { g.beginPath(); g.moveTo(w * tick, y - 9); g.lineTo(w * tick, y + 9); g.stroke() }
    g.fillStyle = '#4fe98b'
    const x = w * (0.57 + Math.max(-1, Math.min(1, value)) * 0.33)
    g.beginPath(); g.moveTo(x, y - 4); g.lineTo(x - 9, y - 20); g.lineTo(x + 9, y - 20); g.fill()
  }
  g.strokeStyle = '#56635b'; g.beginPath(); g.moveTo(25, 392); g.lineTo(w - 25, 392); g.stroke()
  text(g, `FLAPS ${Math.round(s[S.FLAPS] * 100)}%`, w * 0.25, 430, 20)
  text(g, `SPLR ${Math.round(s[S.SPOILERS] * 100)}%`, w * 0.72, 430, 20)
  const gear = s[S.GEAR]
  text(g, gear > 0.99 ? 'L/G DOWN' : gear < 0.01 ? 'L/G UP' : 'L/G IN TRANSIT', w / 2, 478, 20, gear > 0.99 ? '#4fe98b' : gear < 0.01 ? INK : LCD)
}

export function buildAirbusCockpit(model: AircraftModel): Cockpit {
  const root = new Group(); root.name = 'cockpit'
  root.position.set(0, model.eye.y, model.eye.z)
  const wide = model.id === 'a380'
  const engineCount = model.spinners.length
  const instruments: InstrumentCanvas[] = []
  const material = cockpitMaterial
  const lining = material('#7f8891'), frame = material('#4a515a'), panel = material(PAINT), dark = material('#1b1e23'), rubber = material('#14161a', 0.96)
  const silver = material('#949b9c', 0.42), ivory = material('#d9d8cf'), seat = material('#3f4d68'), fleece = material('#b8b5a8', 0.98)
  const red = material('#a32b22')
  const { staticRoot, textures, mesh, box, rod, knob, surface, display, bake } = createCockpitKit(root, { dark, ivory, silver })

  /** Half-width of the flight deck at the side walls, and the pilots' seat positions. */
  const half = wide ? 1.5 : 1.3
  const seatX = Math.abs(model.eye.x)

  // Shell: floor, lining, and a windshield of two front panes and two side windows a side.
  box(half * 2 + 0.05, 0.06, 2.9, dark, 0, -1.25, -0.05)
  box(half * 2 + 0.05, 0.06, 1.9, lining, 0, 0.62, 0.25)
  box(half * 2 + 0.05, 1.85, 0.06, lining, 0, -0.31, 1.16)
  for (const side of [-1, 1]) {
    box(0.07, 1, 2.7, lining, side * (half - 0.01), -0.8, -0.15)
    const sill = [side * (half - 0.19), -0.23, -1.38], brow = [side * (half - 0.36), 0.55, -1.05]
    rod(sill, brow, 0.03, frame)
    rod(brow, [0, 0.59, -1.18], 0.034, frame)
    rod(sill, [0, -0.24, -1.53], 0.03, rubber)
    rod(sill, [side * half, -0.22, 0.28], 0.036, frame)
    rod(brow, [side * half, 0.53, 0.28], 0.03, frame)
    rod([side * half, -0.22, 0.28], [side * half, 0.53, 0.28], 0.038, frame)
    // The post between the sliding window and the fixed rear one.
    rod([side * (half - 0.07), -0.225, -0.42], [side * (half - 0.13), 0.54, -0.3], 0.024, frame)
    rod([side * 0.14, -0.2, -1.48], [side * 0.62, -0.14, -1.44], 0.008, dark)
    // Side console, as far inboard as the pilot's forearm, with its printed top.
    const inner = seatX + 0.33, consoleX = side * (half + inner) / 2
    box(half - inner, 0.5, 1.55, panel, consoleX, -0.84, -0.22, staticRoot, 0.02)
    const top = surface(drawConsole, Math.min(0.4, half - inner - 0.04), 1.2, consoleX - side * (half - inner - Math.min(0.4, half - inner - 0.04)) / 2 + side * 0.02, -0.588, -0.25, staticRoot, 256, 768)
    top.rotation.x = -Math.PI / 2
  }
  rod([0, -0.24, -1.53], [0, 0.59, -1.18], 0.03, frame)

  // Glareshield and main panel.
  const panelHalf = half - 0.09
  box(panelHalf * 2, 0.06, 0.42, rubber, 0, -0.262, -1.17, staticRoot, 0.025)
  box(panelHalf * 2, 0.72, 0.065, panel, 0, -0.65, -1.06)
  box(panelHalf * 2, 0.23, 0.2, lining, 0, -1.06, -1.14)
  surface(drawPanel(wide ? 'A380-800' : 'A320-200', wide, panelHalf * 2 - 0.02), panelHalf * 2 - 0.02, 0.7, 0, -0.65, -1.025, staticRoot, 2048, 600)

  // Displays. The faces stay out of the bake so each keeps its own frame of reference.
  const pfd = new InstrumentCanvas(512, 512, drawPFD), nd = new InstrumentCanvas(512, 512, drawND)
  const engines = new InstrumentCanvas(512, 512, (g, s, w, h) => drawEICAS(g, s, w, h, engineCount))
  const systems = new InstrumentCanvas(512, 512, drawSystems)
  const standby = new InstrumentCanvas(256, 256, drawPFD)
  instruments.push(pfd, nd, engines, systems, standby)
  const size = 0.25
  for (const side of [-1, 1]) {
    display(pfd, side * (seatX + 0.2), -0.52, size, size, -1.02, staticRoot, root)
    display(nd, side * (seatX - 0.085), -0.52, size, size, -1.02, staticRoot, root)
    for (const x of [seatX + 0.3, seatX + 0.16, seatX + 0.01, seatX - 0.13]) knob(side * x, -0.86, -0.99, 0.014)
    if (wide) {
      // Onboard information terminal outboard of each primary display.
      box(0.22, 0.27, 0.03, dark, side * (seatX + 0.47), -0.52, -1.028, staticRoot, 0.012)
      surface((g, w, h) => {
        g.fillStyle = '#0a0d12'; g.fillRect(0, 0, w, h)
        text(g, 'OIS', w / 2, 26, 20); text(g, 'FLT OPS MENU', w / 2, 60, 14, '#58d3f0')
        for (const [i, label] of ['OPS LIBRARY', 'PERFORMANCE', 'LOADSHEET', 'TERMINAL CHARTS', 'LOGBOOK'].entries()) button(g, label, w / 2, 100 + i * 46, w * 0.78, 34)
      }, 0.19, 0.24, side * (seatX + 0.47), -0.52, -1.01, staticRoot, 256, 320)
    }
  }
  display(engines, 0, -0.5, 0.235, 0.235, -1.02, staticRoot, root)
  display(systems, 0, -0.79, 0.235, 0.215, -1.02, staticRoot, root)
  display(standby, wide ? -0.215 : -0.2, -0.45, 0.105, 0.115, -1.02, staticRoot, root)
  const gear = new Group(); gear.position.set(GEAR_X, -0.5, -0.95); root.add(gear)
  // Short, so that from the captain's seat it does not cross the first officer's display.
  rod([0, 0, 0], [0, -0.045, 0.04], 0.009, silver, gear)
  const gearGrip = knob(0, -0.045, 0.045, 0.024, gear, ivory)
  gearGrip.userData.cockpitCommand = { type: 'toggle_gear' } satisfies SimCommand
  gearGrip.userData.cockpitLabel = 'Landing gear up / down · G'

  // Flight control unit on the glareshield, flanked by the EFIS panels.
  const fcu = new InstrumentCanvas(1536, 256, drawFcu, (s) => {
    const ap = ((s[S.FLAGS] | 0) & Flags.AP_ENGAGED) !== 0
    return ap ? `ap ${Math.round(s[S.AP_SPEED_KT])} ${Math.round(s[S.AP_HEADING])} ${Math.round(s[S.AP_ALT_FT])}` : Math.round(s[S.ALT_MSL_FT] / 100)
  })
  instruments.push(fcu)
  const fcuWidth = 0.96
  box(fcuWidth + 0.03, 0.175, 0.09, dark, 0, -0.145, -1.12, staticRoot, 0.012)
  mesh(new PlaneGeometry(fcuWidth, 0.16), new MeshBasicMaterial({ map: fcu.texture, toneMapped: false }), root, 0, -0.145, -1.072).name = 'live-display'
  for (const [u, delta, label] of [[0.14, { speed_delta_kt: 5 }, 'Speed +5 kt'], [0.34, { heading_delta: 5 }, 'Heading +5°'], [0.66, { altitude_delta_ft: 500 }, 'Altitude +500 ft']] as const) {
    const control = knob((u - 0.5) * fcuWidth, -0.2, -1.05, 0.017, root)
    const [key, step] = Object.entries(delta)[0]
    control.userData.cockpitCommand = { type: 'autopilot', ...delta } satisfies SimCommand
    control.userData.cockpitShiftCommand = { type: 'autopilot', [key]: -step } as SimCommand
    control.userData.cockpitLabel = `${label} · Shift-click to decrease`
  }
  knob(0.37 * fcuWidth, -0.2, -1.05, 0.012)
  const apButton = box(0.05, 0.034, 0.007, new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }), -0.06 * fcuWidth, -0.196, -1.062, root)
  apButton.userData.cockpitCommand = { type: 'toggle_autopilot' } satisfies SimCommand
  apButton.userData.cockpitLabel = 'Autopilot on / off · Z'
  for (const side of [-1, 1]) {
    const efis = new Group(); efis.position.set(side * (fcuWidth / 2 + 0.2), -0.145, -1.115); staticRoot.add(efis)
    box(0.31, 0.175, 0.07, panel, 0, 0, 0, efis, 0.009)
    surface(drawEfis, 0.305, 0.17, 0, 0, 0.036, efis, 512, 288)
    for (const [x, y] of [[-0.105, -0.045], [0.02, -0.04], [0.115, -0.04]]) knob(x, y, 0.053, 0.014, efis)
    surface((g, w, h) => {
      g.fillStyle = '#17191b'; g.fillRect(0, 0, w, h)
      button(g, 'MASTER\nWARN', w * 0.2, h / 2, w * 0.34, h * 0.8)
      button(g, 'MASTER\nCAUT', w * 0.56, h / 2, w * 0.34, h * 0.8)
      button(g, 'SIDE STICK\nPRIORITY', w * 0.88, h / 2, w * 0.2, h * 0.8)
    }, 0.2, 0.05, side * (fcuWidth / 2 + 0.5), -0.19, -1.05, staticRoot, 320, 80)
  }

  // Pedestal: MCDUs, thrust levers, speed brake and flap levers, radios.
  box(0.5, 0.2, 1.25, panel, 0, -1.13, -0.15, staticRoot, 0.025)
  box(0.46, 0.24, 0.38, panel, 0, -0.97, -0.27, staticRoot, 0.018)
  box(0.48, 0.27, 0.57, panel, 0, -0.89, 0.24, staticRoot, 0.018)
  const deck = new Group(); deck.position.set(0, -0.87, -0.67); deck.rotation.x = -0.93; staticRoot.add(deck)
  for (const side of [-1, 1]) {
    box(0.21, 0.29, 0.025, dark, side * 0.116, 0, 0, deck, 0.008)
    surface(drawMcdu, 0.2, 0.28, side * 0.116, 0, 0.014, deck, 384, 512)
  }
  const quadrant = new Group(); quadrant.position.set(0, -0.78, -0.27); root.add(quadrant)
  const spacing = wide ? 0.058 : 0.075
  const quadrantWidth = spacing * engineCount + 0.14
  box(quadrantWidth, 0.13, 0.34, dark, 0, -0.04, 0, quadrant, 0.03)
  for (const side of [-1, 1]) {
    // Pitch trim wheels either side of the thrust levers.
    const wheel = mesh(new CylinderGeometry(0.105, 0.105, 0.02, 32), rubber, quadrant, side * (quadrantWidth / 2 + 0.018), -0.03, 0.04)
    wheel.rotation.z = Math.PI / 2
  }
  const throttles: Object3D[] = []
  const throttleGrips: Mesh[] = []
  for (let i = 0; i < engineCount; i++) {
    const lever = new Group(); lever.position.set((i - (engineCount - 1) / 2) * spacing, 0.02, 0); quadrant.add(lever)
    rod([0, 0, 0], [0, 0.15, 0], 0.01, silver, lever)
    // The round Airbus grip, on its side.
    const grip = mesh(new CylinderGeometry(0.031, 0.031, spacing * 0.72, 20), dark, lever, 0, 0.17, 0)
    grip.rotation.z = Math.PI / 2
    grip.userData.cockpitLabel = 'Thrust +10% · Shift-click to decrease'
    grip.userData.cockpitCommand = { type: 'set_throttle', value: 0.1 } satisfies SimCommand
    grip.userData.cockpitShiftCommand = { type: 'set_throttle', value: 0 } satisfies SimCommand
    throttleGrips.push(grip)
    const number = surface((g, w, h) => { g.fillStyle = '#d9d6c9'; g.fillRect(0, 0, w, h); text(g, String(i + 1), w / 2, h / 2, 54, '#242626') }, 0.026, 0.022, 0, 0.17, 0.0325, lever, 80, 64)
    number.userData = grip.userData
    throttles.push(lever)
    // Engine master switch behind each lever.
    box(0.018, 0.03, 0.022, i % 2 ? ivory : silver, (i - (engineCount - 1) / 2) * spacing, 0.04, 0.15, quadrant, 0.004)
  }
  rod([-quadrantWidth / 2 + 0.03, 0, 0.02], [-quadrantWidth / 2 + 0.03, 0.12, -0.03], 0.008, silver, quadrant)
  const speedbrake = box(0.05, 0.03, 0.045, dark, -quadrantWidth / 2 + 0.03, 0.135, -0.035, quadrant, 0.007)
  speedbrake.userData.cockpitCommand = { type: 'toggle_spoilers' } satisfies SimCommand
  speedbrake.userData.cockpitLabel = 'Speed brakes extend / retract · /'
  const flapHandle = new Group(); flapHandle.position.set(quadrantWidth / 2 - 0.03, 0, 0.07); quadrant.add(flapHandle)
  rod([0, 0, 0], [0, 0.11, 0], 0.008, silver, flapHandle)
  const flapGrip = box(0.05, 0.03, 0.05, ivory, 0, 0.12, 0, flapHandle, 0.008)
  flapGrip.userData.cockpitCommand = { type: 'flaps_down' } satisfies SimCommand
  flapGrip.userData.cockpitShiftCommand = { type: 'flaps_up' } satisfies SimCommand
  flapGrip.userData.cockpitLabel = 'Flaps down one notch · Shift-click for flaps up'
  const radios = new Group(); radios.position.set(0, -0.745, 0.24); radios.rotation.x = -Math.PI / 2; staticRoot.add(radios)
  surface((g, w, h) => {
    panelBackground(g, w, h, PAINT)
    for (let row = 0; row < 4; row++) {
      const y = 30 + row * 120
      text(g, ['RMP 1', 'RMP 2', 'ACP', 'ATC / TCAS'][row], w / 2, y, 16)
      g.fillStyle = '#131711'; g.fillRect(40, y + 20, w - 80, 42)
      text(g, row === 3 ? '1200    STBY' : '---.---     ---.---', w / 2, y + 43, 25, LCD)
      for (let col = 0; col < 5; col++) button(g, ['VHF1', 'VHF2', 'HF1', 'CAB', 'PA'][col], 60 + col * 70, y + 85, 48, 20)
    }
  }, 0.42, 0.55, 0, 0, 0, radios, 400, 512)
  box(0.05, 0.035, 0.05, red, 0.15, -0.73, 0.56, staticRoot, 0.006)

  // Sidesticks outboard, tables instead of yokes, seats and pedals.
  let stick: Group | null = null
  const sticks: Group[] = []
  for (const x of [model.eye.x, -model.eye.x]) {
    const side = Math.sign(x)
    const st = new Group(); st.position.set(x + side * 0.45, -0.59, -0.16); root.add(st)
    mesh(new CylinderGeometry(0.034, 0.045, 0.035, 14), rubber, st, 0, 0.012, 0)
    rod([0, 0.02, 0], [0, 0.13, -0.012], 0.016, dark, st)
    box(0.04, 0.05, 0.048, dark, 0, 0.15, -0.014, st, 0.014)
    box(0.012, 0.012, 0.012, red, -side * 0.012, 0.176, -0.02, st, 0.003)
    if (x === model.eye.x) stick = st
    sticks.push(st)
    // Nose-wheel tiller ahead of the stick.
    knob(x + side * 0.5, -0.575, -0.62, 0.024, staticRoot, dark).rotation.x = 0
    // Stowed table under the panel, with the edge of its keyboard showing.
    box(0.5, 0.022, 0.2, dark, x, -0.925, -0.93, staticRoot, 0.008)
    box(0.46, 0.006, 0.05, silver, x, -0.912, -0.84)
    box(0.47, 0.12, 0.5, seat, x, -0.93, 0.26, staticRoot, 0.055)
    box(0.47, 0.7, 0.14, seat, x, -0.58, 0.56, staticRoot, 0.055)
    box(0.36, 0.5, 0.03, fleece, x, -0.55, 0.485, staticRoot, 0.012)
    box(0.07, 0.035, 0.36, dark, x - side * 0.27, -0.66, 0.24, staticRoot, 0.012)
    box(0.07, 0.035, 0.36, dark, x + side * 0.27, -0.66, 0.24, staticRoot, 0.012)
    for (const dx of [-0.12, 0.12]) {
      const pedal = box(0.16, 0.1, 0.035, dark, x + dx, -1.13, -0.83); pedal.rotation.x = -0.45
      for (let i = 0; i < 5; i++) box(0.14, 0.004, 0.006, silver, x + dx, -1.165 + i * 0.016, -0.8)
    }
  }

  // Overhead panel of pushbutton lights.
  const overhead = new Group(); overhead.position.set(0, 0.52, -0.3); overhead.rotation.x = 1.34; staticRoot.add(overhead)
  box(0.8, 1.03, 0.045, panel, 0, 0, 0, overhead, 0.015)
  surface(drawOverhead, 0.78, 1.01, 0, 0, 0.024, overhead, 1024, 1320)
  for (const x of [-0.3, 0.3]) box(0.05, 0.05, 0.025, red, x, 0.4, 0.045, overhead, 0.006)

  bake('airbus-static-panel')
  root.traverse((o) => o.layers.enableAll())
  const schedule = new InstrumentSchedule(instruments)
  return {
    root, instruments, yoke: null, stick, throttles,
    update(s, c) {
      schedule.update(s)
      for (const st of sticks) {
        st.rotation.x = -c.pitch * 0.3
        st.rotation.z = -c.roll * 0.3
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
