// Canvas-drawn flight instruments, refreshed from the latest sim snapshot.

import { CanvasTexture, SRGBColorSpace } from 'three'
import { ApModes, Flags, S } from '../sim/protocol'

const DEG = Math.PI / 180

export class InstrumentCanvas {
  readonly canvas: HTMLCanvasElement
  readonly ctx: CanvasRenderingContext2D
  readonly texture: CanvasTexture

  constructor(
    readonly width: number,
    readonly height: number,
    private draw: (g: CanvasRenderingContext2D, s: Float64Array, w: number, h: number) => void,
  ) {
    this.canvas = document.createElement('canvas')
    this.canvas.width = width
    this.canvas.height = height
    this.ctx = this.canvas.getContext('2d')!
    this.texture = new CanvasTexture(this.canvas)
    this.texture.colorSpace = SRGBColorSpace
    this.texture.anisotropy = 4
  }

  update(s: Float64Array) {
    this.draw(this.ctx, s, this.width, this.height)
    this.texture.needsUpdate = true
  }

  dispose() {
    this.texture.dispose()
  }
}

const font = (px: number, weight = 600) => `${weight} ${px}px "SF Mono", "Menlo", "Roboto Mono", monospace`
const GREEN = '#33ff7a'
const MAGENTA = '#ff4dff'
const CYAN = '#3ad7ff'
const AMBER = '#ffb020'
const WHITE = '#f2f5f7'

/** Primary flight display. */
export function drawPFD(g: CanvasRenderingContext2D, s: Float64Array, w: number, h: number) {
  const pitch = s[S.PITCH]
  const roll = s[S.ROLL]
  g.fillStyle = '#05070a'
  g.fillRect(0, 0, w, h)
  const cx = w * 0.5
  const cy = h * 0.47
  const ppd = h * 0.012 // pixels per degree of pitch
  // Attitude
  g.save()
  g.beginPath()
  g.rect(w * 0.2, h * 0.12, w * 0.6, h * 0.66)
  g.clip()
  g.translate(cx, cy)
  g.rotate(-roll * DEG)
  g.translate(0, pitch * ppd)
  g.fillStyle = '#2a7fd4'
  g.fillRect(-w, -h * 2, w * 2, h * 2)
  g.fillStyle = '#7a4a1f'
  g.fillRect(-w, 0, w * 2, h * 2)
  g.strokeStyle = WHITE
  g.lineWidth = 2
  g.beginPath()
  g.moveTo(-w, 0)
  g.lineTo(w, 0)
  g.stroke()
  g.font = font(h * 0.028)
  g.fillStyle = WHITE
  g.textAlign = 'right'
  g.textBaseline = 'middle'
  for (let p = -30; p <= 30; p += 2.5) {
    if (p === 0) continue
    const y = -p * ppd
    const major = p % 10 === 0
    const half = major ? w * 0.09 : p % 5 === 0 ? w * 0.05 : w * 0.025
    g.beginPath()
    g.moveTo(-half, y)
    g.lineTo(half, y)
    g.stroke()
    if (major) {
      g.fillText(String(Math.abs(p)), -half - 6, y)
    }
  }
  g.restore()
  // Roll scale
  g.save()
  g.translate(cx, cy)
  g.strokeStyle = WHITE
  g.lineWidth = 2
  const rr = h * 0.3
  for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
    const t = (a - 90) * DEG
    const len = a % 30 === 0 ? 16 : 9
    g.beginPath()
    g.moveTo(Math.cos(t) * rr, Math.sin(t) * rr)
    g.lineTo(Math.cos(t) * (rr + len), Math.sin(t) * (rr + len))
    g.stroke()
  }
  g.rotate(-roll * DEG)
  g.fillStyle = WHITE
  g.beginPath()
  g.moveTo(0, -rr + 2)
  g.lineTo(-9, -rr + 16)
  g.lineTo(9, -rr + 16)
  g.closePath()
  g.fill()
  g.restore()
  // Aircraft symbol
  g.strokeStyle = '#ffd400'
  g.lineWidth = 6
  g.beginPath()
  g.moveTo(cx - w * 0.16, cy)
  g.lineTo(cx - w * 0.06, cy)
  g.lineTo(cx - w * 0.06, cy + 12)
  g.moveTo(cx + w * 0.16, cy)
  g.lineTo(cx + w * 0.06, cy)
  g.lineTo(cx + w * 0.06, cy + 12)
  g.stroke()
  g.fillStyle = '#ffd400'
  g.fillRect(cx - 5, cy - 5, 10, 10)

  // Speed tape
  tape(g, s[S.IAS_KT], w * 0.02, h * 0.12, w * 0.15, h * 0.66, 10, 20, true)
  // Altitude tape
  tape(g, s[S.ALT_MSL_FT], w * 0.83, h * 0.12, w * 0.15, h * 0.66, 100, 200, false)
  // Heading
  g.fillStyle = '#11161c'
  g.fillRect(w * 0.2, h * 0.84, w * 0.6, h * 0.12)
  g.save()
  g.beginPath()
  g.rect(w * 0.2, h * 0.84, w * 0.6, h * 0.12)
  g.clip()
  const hdg = s[S.HEADING]
  const pxPerDeg = w * 0.012
  g.strokeStyle = WHITE
  g.fillStyle = WHITE
  g.font = font(h * 0.03)
  g.textAlign = 'center'
  for (let d = Math.floor(hdg) - 30; d <= hdg + 30; d++) {
    if (d % 5 !== 0) continue
    const x = cx + (d - hdg) * pxPerDeg
    g.beginPath()
    g.moveTo(x, h * 0.84)
    g.lineTo(x, h * 0.84 + (d % 10 === 0 ? 14 : 8))
    g.stroke()
    if (d % 10 === 0) g.fillText(String(((d % 360) + 360) % 360 / 10 | 0).padStart(2, '0'), x, h * 0.91)
  }
  g.restore()
  g.fillStyle = '#ffd400'
  g.beginPath()
  g.moveTo(cx, h * 0.84 + 2)
  g.lineTo(cx - 8, h * 0.84 - 10)
  g.lineTo(cx + 8, h * 0.84 - 10)
  g.fill()
  // FMA
  const flags = s[S.FLAGS] | 0
  const ap = (flags & Flags.AP_ENGAGED) !== 0
  const modes = s[S.AP_MODES] | 0
  g.font = font(h * 0.032)
  g.textAlign = 'center'
  g.fillStyle = '#11161c'
  g.fillRect(0, 0, w, h * 0.08)
  const fma = [
    ap && modes & ApModes.AUTOTHROTTLE ? `SPD ${Math.round(s[S.AP_SPEED_KT])}` : '',
    ap && modes & ApModes.HEADING ? `HDG ${String(Math.round(s[S.AP_HEADING])).padStart(3, '0')}` : '',
    ap && modes & ApModes.ALTITUDE ? `ALT ${Math.round(s[S.AP_ALT_FT])}` : '',
  ]
  fma.forEach((t, i) => {
    g.fillStyle = GREEN
    g.fillText(t, w * (0.2 + i * 0.3), h * 0.045)
  })
  if (ap) {
    g.fillStyle = GREEN
    g.fillText('AP', w * 0.93, h * 0.045)
  }
  // Vertical speed
  const vs = s[S.VS_FPM]
  g.fillStyle = vs >= 0 ? GREEN : WHITE
  g.font = font(h * 0.03)
  g.textAlign = 'right'
  g.fillText(`${vs >= 0 ? '+' : ''}${Math.round(vs / 10) * 10}`, w * 0.98, h * 0.82)
  if (flags & Flags.STALL) {
    g.fillStyle = '#ff2a2a'
    g.font = font(h * 0.06, 800)
    g.textAlign = 'center'
    g.fillText('STALL', cx, h * 0.24)
  }
}

function tape(g: CanvasRenderingContext2D, value: number, x: number, y: number, w: number, h: number, minor: number, label: number, left: boolean) {
  g.fillStyle = '#2b3138'
  g.fillRect(x, y, w, h)
  g.save()
  g.beginPath()
  g.rect(x, y, w, h)
  g.clip()
  const cy = y + h / 2
  const pxPer = h / (minor * 16)
  g.strokeStyle = WHITE
  g.fillStyle = WHITE
  g.lineWidth = 2
  g.font = font(h * 0.045)
  g.textBaseline = 'middle'
  const start = Math.floor((value - minor * 9) / minor) * minor
  for (let v = start; v <= value + minor * 9; v += minor) {
    const yy = cy - (v - value) * pxPer
    g.beginPath()
    if (left) {
      g.moveTo(x + w, yy)
      g.lineTo(x + w - 10, yy)
    } else {
      g.moveTo(x, yy)
      g.lineTo(x + 10, yy)
    }
    g.stroke()
    if (v % label === 0) {
      g.textAlign = left ? 'right' : 'left'
      g.fillText(String(v), left ? x + w - 14 : x + 14, yy)
    }
  }
  g.restore()
  // Readout box
  g.fillStyle = '#000'
  g.strokeStyle = WHITE
  g.fillRect(x - 2, cy - h * 0.045, w + 4, h * 0.09)
  g.strokeRect(x - 2, cy - h * 0.045, w + 4, h * 0.09)
  g.fillStyle = GREEN
  g.font = font(h * 0.055, 700)
  g.textAlign = 'center'
  g.fillText(String(Math.round(value)), x + w / 2, cy + 1)
}

/** Navigation display: compass arc with track and ground speed. */
export function drawND(g: CanvasRenderingContext2D, s: Float64Array, w: number, h: number) {
  g.fillStyle = '#05070a'
  g.fillRect(0, 0, w, h)
  const hdg = s[S.HEADING]
  const cx = w / 2
  const cy = h * 0.82
  const r = h * 0.68
  g.save()
  g.translate(cx, cy)
  g.strokeStyle = WHITE
  g.fillStyle = WHITE
  g.font = font(h * 0.04)
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.lineWidth = 2
  g.beginPath()
  g.arc(0, 0, r, Math.PI * 1.15, Math.PI * 1.85)
  g.stroke()
  for (let d = 0; d < 360; d += 5) {
    const a = (d - hdg - 90) * DEG
    if (a < -Math.PI * 0.86 || a > -Math.PI * 0.14) continue
    const len = d % 10 === 0 ? 16 : 8
    g.beginPath()
    g.moveTo(Math.cos(a) * r, Math.sin(a) * r)
    g.lineTo(Math.cos(a) * (r - len), Math.sin(a) * (r - len))
    g.stroke()
    if (d % 30 === 0) g.fillText(String(d / 10), Math.cos(a) * (r - 34), Math.sin(a) * (r - 34))
  }
  // Range rings
  g.strokeStyle = 'rgba(255,255,255,0.25)'
  g.setLineDash([6, 8])
  g.beginPath()
  g.arc(0, 0, r * 0.5, Math.PI * 1.15, Math.PI * 1.85)
  g.stroke()
  g.setLineDash([])
  // Track line
  const trk = (s[S.TRACK] - hdg - 90) * DEG
  g.strokeStyle = GREEN
  g.beginPath()
  g.moveTo(0, 0)
  g.lineTo(Math.cos(trk) * r, Math.sin(trk) * r)
  g.stroke()
  // AP heading bug
  if ((s[S.FLAGS] | 0) & Flags.AP_ENGAGED) {
    const a = (s[S.AP_HEADING] - hdg - 90) * DEG
    g.fillStyle = MAGENTA
    g.save()
    g.rotate(a + Math.PI / 2)
    g.fillRect(-8, -r - 4, 16, 10)
    g.restore()
  }
  // Ownship
  g.strokeStyle = '#ffd400'
  g.lineWidth = 4
  g.beginPath()
  g.moveTo(0, -24)
  g.lineTo(0, 20)
  g.moveTo(-18, -2)
  g.lineTo(18, -2)
  g.moveTo(-8, 16)
  g.lineTo(8, 16)
  g.stroke()
  g.restore()
  g.fillStyle = WHITE
  g.font = font(h * 0.04)
  g.textAlign = 'left'
  g.fillText(`GS ${Math.round(s[S.GS_KT])}  TAS ${Math.round(s[S.TAS_KT])}`, 14, 28)
  g.textAlign = 'right'
  g.fillStyle = CYAN
  g.fillText(`HDG ${String(Math.round(hdg) % 360).padStart(3, '0')}°`, w - 14, 28)
  g.fillStyle = WHITE
  g.textAlign = 'left'
  g.fillText(`${s[S.LAT].toFixed(4)}  ${s[S.LON].toFixed(4)}`, 14, h - 18)
}

/** Engine and systems display. */
export function drawEICAS(g: CanvasRenderingContext2D, s: Float64Array, w: number, h: number) {
  g.fillStyle = '#05070a'
  g.fillRect(0, 0, w, h)
  const n1 = 20 + s[S.ENGINE] * 81
  for (const [i, x] of [w * 0.28, w * 0.72].entries()) {
    const cy = h * 0.27
    const r = w * 0.17
    g.strokeStyle = WHITE
    g.lineWidth = 3
    g.beginPath()
    g.arc(x, cy, r, Math.PI * 0.75, Math.PI * 2.25)
    g.stroke()
    const a = Math.PI * 0.75 + (Math.min(n1, 110) / 110) * Math.PI * 1.5
    g.strokeStyle = GREEN
    g.lineWidth = 5
    g.beginPath()
    g.moveTo(x, cy)
    g.lineTo(x + Math.cos(a) * r * 0.92, cy + Math.sin(a) * r * 0.92)
    g.stroke()
    g.fillStyle = WHITE
    g.font = font(h * 0.055, 700)
    g.textAlign = 'center'
    g.fillText(n1.toFixed(1), x, cy + r * 0.62)
    g.font = font(h * 0.035)
    g.fillStyle = CYAN
    g.fillText(`N1 ${i + 1}`, x, cy - r - 10)
  }
  g.font = font(h * 0.045, 700)
  g.textAlign = 'left'
  const gear = s[S.GEAR]
  const gearTxt = gear > 0.99 ? 'DOWN' : gear < 0.01 ? 'UP' : 'TRANSIT'
  g.fillStyle = gear > 0.99 ? GREEN : gear < 0.01 ? WHITE : AMBER
  g.fillText(`GEAR  ${gearTxt}`, w * 0.08, h * 0.62)
  g.fillStyle = WHITE
  g.fillText(`FLAPS ${Math.round(s[S.FLAPS] * 100)}%`, w * 0.08, h * 0.72)
  g.fillText(`THR   ${Math.round(s[S.THROTTLE] * 100)}%`, w * 0.08, h * 0.82)
  const flags = s[S.FLAGS] | 0
  g.fillStyle = s[S.SPOILERS] > 0.05 ? AMBER : 'rgba(255,255,255,0.4)'
  g.fillText('SPEEDBRAKE', w * 0.56, h * 0.62)
  g.fillStyle = flags & Flags.PARKING_BRAKE ? AMBER : 'rgba(255,255,255,0.4)'
  g.fillText('PARK BRK', w * 0.56, h * 0.72)
  g.fillStyle = flags & Flags.OVERSPEED ? '#ff3030' : 'rgba(255,255,255,0.4)'
  g.fillText('OVERSPEED', w * 0.56, h * 0.82)
}

function dial(g: CanvasRenderingContext2D, x: number, y: number, r: number, label: string) {
  g.fillStyle = '#0b0c0e'
  g.beginPath()
  g.arc(x, y, r, 0, Math.PI * 2)
  g.fill()
  g.strokeStyle = '#555'
  g.lineWidth = 6
  g.stroke()
  g.fillStyle = '#ccc'
  g.font = font(r * 0.16)
  g.textAlign = 'center'
  g.fillText(label, x, y + r * 0.45)
}

function needle(g: CanvasRenderingContext2D, x: number, y: number, len: number, angle: number, width = 5, color = WHITE) {
  g.strokeStyle = color
  g.lineWidth = width
  g.lineCap = 'round'
  g.beginPath()
  g.moveTo(x, y)
  g.lineTo(x + Math.sin(angle) * len, y - Math.cos(angle) * len)
  g.stroke()
}

function ticks(g: CanvasRenderingContext2D, x: number, y: number, r: number, from: number, to: number, n: number, labels?: (i: number) => string) {
  g.strokeStyle = WHITE
  g.fillStyle = WHITE
  g.font = font(r * 0.17)
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  for (let i = 0; i <= n; i++) {
    const a = from + ((to - from) * i) / n
    g.lineWidth = 2
    g.beginPath()
    g.moveTo(x + Math.sin(a) * r * 0.82, y - Math.cos(a) * r * 0.82)
    g.lineTo(x + Math.sin(a) * r * 0.95, y - Math.cos(a) * r * 0.95)
    g.stroke()
    if (labels) {
      const t = labels(i)
      if (t) g.fillText(t, x + Math.sin(a) * r * 0.66, y - Math.cos(a) * r * 0.66)
    }
  }
}

/** Classic "six-pack" plus tachometer for the light aircraft. */
export function drawSixPack(g: CanvasRenderingContext2D, s: Float64Array, w: number, h: number) {
  g.fillStyle = '#1d1f22'
  g.fillRect(0, 0, w, h)
  const r = h * 0.21
  const cols = [w * 0.17, w * 0.5, w * 0.83]
  const rows = [h * 0.26, h * 0.74]
  // Airspeed
  {
    const [x, y] = [cols[0], rows[0]]
    dial(g, x, y, r, 'KNOTS')
    const map = (kt: number) => (Math.min(Math.max(kt, 0), 200) / 200) * Math.PI * 1.75
    g.lineWidth = 8
    for (const [a, b, c] of [
      [40, 85, '#ffffff'],
      [48, 129, '#2fbf4f'],
      [129, 163, '#ffd000'],
    ] as const) {
      g.strokeStyle = c
      g.beginPath()
      g.arc(x, y, r * 0.86, map(a) - Math.PI / 2, map(b) - Math.PI / 2)
      g.stroke()
    }
    ticks(g, x, y, r, 0, Math.PI * 1.75, 20, (i) => (i % 2 === 0 ? String(i * 10) : ''))
    needle(g, x, y, r * 0.8, map(s[S.IAS_KT]))
  }
  // Attitude
  {
    const [x, y] = [cols[1], rows[0]]
    g.save()
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.clip()
    g.translate(x, y)
    g.rotate(-s[S.ROLL] * DEG)
    g.translate(0, s[S.PITCH] * r * 0.03)
    g.fillStyle = '#2a7fd4'
    g.fillRect(-r * 2, -r * 3, r * 4, r * 3)
    g.fillStyle = '#7a4a1f'
    g.fillRect(-r * 2, 0, r * 4, r * 3)
    g.strokeStyle = WHITE
    g.lineWidth = 3
    g.beginPath()
    g.moveTo(-r * 2, 0)
    g.lineTo(r * 2, 0)
    for (const p of [-20, -10, 10, 20]) {
      const yy = -p * r * 0.03
      g.moveTo(-r * 0.25, yy)
      g.lineTo(r * 0.25, yy)
    }
    g.stroke()
    g.restore()
    g.strokeStyle = '#ff9a00'
    g.lineWidth = 6
    g.beginPath()
    g.moveTo(x - r * 0.55, y)
    g.lineTo(x - r * 0.15, y)
    g.lineTo(x, y + r * 0.12)
    g.lineTo(x + r * 0.15, y)
    g.lineTo(x + r * 0.55, y)
    g.stroke()
    g.strokeStyle = '#555'
    g.lineWidth = 6
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.stroke()
  }
  // Altimeter
  {
    const [x, y] = [cols[2], rows[0]]
    dial(g, x, y, r, 'ALT')
    ticks(g, x, y, r, 0, Math.PI * 2 - 0.0001, 50, (i) => (i % 5 === 0 && i < 50 ? String(i / 5) : ''))
    const alt = s[S.ALT_MSL_FT]
    needle(g, x, y, r * 0.5, ((alt / 10000) % 1) * Math.PI * 2, 9)
    needle(g, x, y, r * 0.82, ((alt / 1000) % 1) * Math.PI * 2, 4)
    g.fillStyle = WHITE
    g.font = font(r * 0.16)
    g.fillText(`${Math.round(alt)}`, x, y - r * 0.35)
  }
  // Turn coordinator
  {
    const [x, y] = [cols[0], rows[1]]
    dial(g, x, y, r, 'TURN COORD')
    const yawRate = Math.max(-6, Math.min(6, s[S.ROLL] * 0.15))
    g.save()
    g.translate(x, y)
    g.rotate((yawRate / 3) * 20 * DEG)
    g.strokeStyle = WHITE
    g.lineWidth = 7
    g.beginPath()
    g.moveTo(-r * 0.6, 0)
    g.lineTo(r * 0.6, 0)
    g.moveTo(0, 0)
    g.lineTo(0, -r * 0.2)
    g.stroke()
    g.restore()
    g.fillStyle = '#000'
    g.fillRect(x - r * 0.4, y + r * 0.55, r * 0.8, r * 0.16)
    g.fillStyle = WHITE
    g.beginPath()
    g.arc(x, y + r * 0.63, r * 0.07, 0, Math.PI * 2)
    g.fill()
  }
  // Heading indicator
  {
    const [x, y] = [cols[1], rows[1]]
    dial(g, x, y, r, '')
    g.save()
    g.translate(x, y)
    g.rotate(-s[S.HEADING] * DEG)
    g.fillStyle = WHITE
    g.strokeStyle = WHITE
    g.font = font(r * 0.18, 700)
    g.textAlign = 'center'
    for (let d = 0; d < 360; d += 10) {
      g.save()
      g.rotate(d * DEG)
      g.lineWidth = 2
      g.beginPath()
      g.moveTo(0, -r * 0.95)
      g.lineTo(0, -r * (d % 30 === 0 ? 0.8 : 0.87))
      g.stroke()
      if (d % 30 === 0) g.fillText(['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33'][d / 30], 0, -r * 0.66)
      g.restore()
    }
    g.restore()
    g.strokeStyle = '#ff9a00'
    g.lineWidth = 5
    g.beginPath()
    g.moveTo(x, y - r * 0.5)
    g.lineTo(x, y + r * 0.3)
    g.moveTo(x - r * 0.3, y - r * 0.1)
    g.lineTo(x + r * 0.3, y - r * 0.1)
    g.stroke()
  }
  // Vertical speed
  {
    const [x, y] = [cols[2], rows[1]]
    dial(g, x, y, r, 'VSI ×100')
    const map = (fpm: number) => -Math.PI / 2 + (Math.max(-2000, Math.min(2000, fpm)) / 2000) * Math.PI * 0.9
    ticks(g, x, y, r, -Math.PI / 2 - Math.PI * 0.9, -Math.PI / 2 + Math.PI * 0.9, 8, (i) => String(Math.abs(i - 4) * 5))
    needle(g, x, y, r * 0.82, map(s[S.VS_FPM]))
  }
  // Tach & flaps strip
  g.fillStyle = WHITE
  g.font = font(h * 0.04)
  g.textAlign = 'left'
  g.fillText(`RPM ${Math.round(700 + s[S.ENGINE] * 1950)}`, w * 0.02, h * 0.98)
  g.textAlign = 'right'
  g.fillText(`FLAPS ${Math.round(s[S.FLAPS] * 30)}°`, w * 0.98, h * 0.98)
}
