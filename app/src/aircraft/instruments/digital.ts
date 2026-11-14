import { flightModes } from '../../sim/autopilotStatus'
import { Flags, S } from '../../sim/protocol'
import { DEG, font, WHITE } from './style'

const GREEN = '#33ff7a'
const MAGENTA = '#ff4dff'
const CYAN = '#3ad7ff'
const AMBER = '#ffb020'

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
  g.font = font(h * 0.032)
  g.textAlign = 'center'
  g.fillStyle = '#11161c'
  g.fillRect(0, 0, w, h * 0.08)
  const fma = flightModes(s)
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
export function drawEICAS(g: CanvasRenderingContext2D, s: Float64Array, w: number, h: number, engineCount: number) {
  g.fillStyle = '#05070a'
  g.fillRect(0, 0, w, h)
  const n1 = 20 + s[S.ENGINE] * 81
  for (let i = 0; i < engineCount; i++) {
    const x = w * (0.06 + 0.88 * (i + 0.5) / engineCount)
    const cy = h * 0.27
    const r = w * Math.min(0.17, 0.39 / engineCount)
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
    g.font = font(Math.min(h * 0.055, r * 0.45), 700)
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
