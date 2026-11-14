import { Flags, S } from '../../sim/protocol'
import { drawND } from './digital'
import { DEG, font } from './style'

export function drawAirliftStatus(g: CanvasRenderingContext2D, s: Float64Array, w: number, h: number) {
  g.fillStyle = '#080e0c'
  g.fillRect(0, 0, w, h)
  g.textAlign = 'left'
  g.textBaseline = 'middle'
  g.font = font(w * 0.063)
  g.fillStyle = '#8bd7af'
  g.fillText('AIRCRAFT STATUS', w * 0.09, h * 0.12)
  const flags = s[S.FLAGS] | 0
  const rows = [
    ['GEAR', s[S.GEAR] > 0.99 ? 'DOWN' : s[S.GEAR] < 0.01 ? 'UP' : 'TRANSIT'],
    ['FLAPS', `${Math.round(s[S.FLAPS] * 100)}%`],
    ['SPOILERS', s[S.SPOILERS] > 0.05 ? 'EXTENDED' : 'STOWED'],
    ['PARK BRAKE', flags & Flags.PARKING_BRAKE ? 'SET' : 'RELEASED'],
    ['AUTOPILOT', flags & Flags.AP_ENGAGED ? 'ENGAGED' : 'OFF'],
  ]
  rows.forEach(([label, value], index) => {
    const y = h * (0.28 + index * 0.138)
    g.textAlign = 'left'
    g.fillStyle = '#b6c6bd'
    g.fillText(label, w * 0.09, y)
    g.textAlign = 'right'
    g.fillStyle = '#54ec93'
    g.fillText(value, w * 0.91, y)
  })
}

/** Navigation and four-engine indications on the C-17 multifunction display. */
export function drawAirliftNav(g: CanvasRenderingContext2D, s: Float64Array, w: number, h: number) {
  drawND(g, s, w, h * 0.76)
  g.fillStyle = '#070e0c'
  g.fillRect(0, h * 0.76, w, h * 0.24)
  const n1 = 20 + s[S.ENGINE] * 81
  g.font = font(w * 0.038)
  g.textAlign = 'left'
  g.textBaseline = 'middle'
  for (let engine = 0; engine < 4; engine++) {
    const x = w * (0.06 + engine * 0.23)
    g.fillStyle = '#afc5b9'
    g.fillText(`N1 ${engine + 1}`, x, h * 0.82)
    g.fillStyle = '#54ec93'
    g.fillRect(x, h * 0.875, w * 0.17 * n1 / 105, h * 0.015)
    g.fillText(n1.toFixed(1), x, h * 0.947)
  }
}

/** C-17 flight symbology on a transparent collimated-style combiner. */
export function drawAirliftHud(g: CanvasRenderingContext2D, s: Float64Array, w: number, h: number, pixelsPerRadian: number) {
  g.clearRect(0, 0, w, h)
  g.lineWidth = 3.5
  g.strokeStyle = '#59ff8d'
  g.fillStyle = '#59ff8d'
  g.font = font(28, 700)
  g.textBaseline = 'middle'
  const cx = w / 2
  const cy = h / 2
  const ladderY = (angle: number) => Math.tan(angle * DEG) * pixelsPerRadian

  g.save()
  g.beginPath()
  g.rect(w * 0.2, h * 0.18, w * 0.6, h * 0.70)
  g.clip()
  g.translate(cx, cy)
  g.rotate(-s[S.ROLL] * DEG)
  for (let pitch = -30; pitch <= 30; pitch += 5) {
    const y = ladderY(s[S.PITCH] - pitch)
    if (Math.abs(y) > h) continue
    const length = w * (pitch === 0 ? 0.28 : 0.12)
    g.setLineDash(pitch < 0 ? [9, 6] : [])
    g.beginPath()
    for (const side of [-1, 1]) {
      g.moveTo(w * 0.037 * side, y)
      g.lineTo(length * side, y)
      if (pitch !== 0) g.lineTo(length * side, y + Math.sign(pitch) * 9)
    }
    g.stroke()
    if (pitch !== 0) {
      g.textAlign = 'center'
      for (const side of [-1, 1]) g.fillText(String(Math.abs(pitch)), (length + 26) * side, y)
    }
  }
  g.setLineDash([])
  g.restore()

  const heading = s[S.HEADING]
  g.textAlign = 'center'
  for (let tick = Math.floor(heading / 5) * 5 - 10; tick <= heading + 10; tick += 5) {
    const x = cx + ladderY(tick - heading) * 0.68
    g.beginPath()
    g.moveTo(x, h * 0.14)
    g.lineTo(x, h * (tick % 10 === 0 ? 0.113 : 0.125))
    g.stroke()
    if (tick % 10 === 0) g.fillText(String(((tick + 360) % 360) / 10).padStart(2, '0'), x, h * 0.075)
  }
  g.fillText('▲', cx, h * 0.17)

  const y = cy + ladderY(s[S.PITCH] - s[S.FPA])
  if (y > h * 0.18 && y < h * 0.89) {
    g.beginPath()
    g.arc(cx, y, 11, 0, Math.PI * 2)
    g.moveTo(cx - 11, y)
    g.lineTo(cx - 27, y)
    g.moveTo(cx + 11, y)
    g.lineTo(cx + 27, y)
    g.moveTo(cx, y - 11)
    g.lineTo(cx, y - 22)
    g.stroke()
  }
  g.strokeRect(8, cy - 21, w * 0.16, 42)
  g.fillText(String(Math.round(s[S.IAS_KT])), 8 + w * 0.08, cy)
  g.strokeRect(w * 0.82, cy - 21, w * 0.17 - 8, 42)
  g.fillText(String(Math.round(s[S.ALT_MSL_FT] / 10) * 10), w * 0.905 - 4, cy)
  if (s[S.GEAR] > 0.95) g.fillText('GEAR DOWN', cx, h * 0.94)
}
