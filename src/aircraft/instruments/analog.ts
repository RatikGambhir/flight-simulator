import { S } from '../../sim/protocol'
import { DEG, font, WHITE } from './style'

/** Panel paint behind the light-aircraft gauges (shared with the panel texture). */
export const GA_PANEL = '#2b2d30'

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

/** Classic "six-pack" of flight instruments for the light aircraft. */
export function drawSixPack(g: CanvasRenderingContext2D, s: Float64Array, w: number, h: number) {
  g.fillStyle = GA_PANEL
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
}

/** Small arc gauge with a coloured normal range, as used for fuel and oil. */
function miniGauge(g: CanvasRenderingContext2D, x: number, y: number, r: number, label: string, value: number, green: [number, number], unit: string) {
  dial(g, x, y, r, '')
  const a0 = -Math.PI * 0.7
  const a1 = Math.PI * 0.7
  const at = (v: number) => a0 + (a1 - a0) * Math.min(1, Math.max(0, v))
  g.lineWidth = r * 0.12
  g.strokeStyle = '#2fbf4f'
  g.beginPath()
  g.arc(x, y, r * 0.84, at(green[0]) - Math.PI / 2, at(green[1]) - Math.PI / 2)
  g.stroke()
  g.strokeStyle = '#e03030'
  g.beginPath()
  g.arc(x, y, r * 0.84, at(0.96) - Math.PI / 2, at(1) - Math.PI / 2)
  g.stroke()
  ticks(g, x, y, r, a0, a1, 4)
  g.fillStyle = '#ddd'
  g.font = font(r * 0.24)
  g.textAlign = 'center'
  g.fillText(label, x, y + r * 0.48)
  g.font = font(r * 0.18, 500)
  g.fillText(unit, x, y - r * 0.38)
  needle(g, x, y, r * 0.74, at(value), Math.max(3, r * 0.06))
  g.fillStyle = '#111'
  g.beginPath()
  g.arc(x, y, r * 0.12, 0, Math.PI * 2)
  g.fill()
}

/** Tachometer with fuel and oil gauges for the piston single. */
export function drawGaEngine(g: CanvasRenderingContext2D, s: Float64Array, w: number, h: number) {
  g.fillStyle = GA_PANEL
  g.fillRect(0, 0, w, h)
  const eng = s[S.ENGINE]
  const rpm = 700 + eng * 1950
  // Tachometer
  const x = w * 0.5
  const y = h * 0.34
  const r = h * 0.3
  dial(g, x, y, r, 'RPM')
  const a0 = -Math.PI * 0.75
  const a1 = Math.PI * 0.75
  const at = (v: number) => a0 + ((a1 - a0) * Math.min(3500, Math.max(0, v))) / 3500
  g.lineWidth = r * 0.07
  g.strokeStyle = '#2fbf4f'
  g.beginPath()
  g.arc(x, y, r * 0.87, at(2100) - Math.PI / 2, at(2700) - Math.PI / 2)
  g.stroke()
  g.strokeStyle = '#e03030'
  g.beginPath()
  g.arc(x, y, r * 0.87, at(2700) - Math.PI / 2, at(2760) - Math.PI / 2)
  g.stroke()
  ticks(g, x, y, r, a0, a1, 35, (i) => (i % 5 === 0 ? String(i) : ''))
  g.fillStyle = '#bbb'
  g.font = font(r * 0.11, 500)
  g.fillText('× 100', x, y - r * 0.3)
  // Hour meter
  g.fillStyle = '#000'
  g.fillRect(x - r * 0.3, y + r * 0.58, r * 0.6, r * 0.17)
  g.fillStyle = WHITE
  g.font = font(r * 0.13)
  g.fillText('1284.6', x, y + r * 0.67)
  needle(g, x, y, r * 0.8, at(rpm), 6)
  g.fillStyle = '#111'
  g.beginPath()
  g.arc(x, y, r * 0.09, 0, Math.PI * 2)
  g.fill()
  // Fuel and oil
  const rr = h * 0.105
  const yy = h * 0.83
  miniGauge(g, w * 0.14, yy, rr, 'FUEL L', 0.72, [0.08, 1], 'GAL')
  miniGauge(g, w * 0.38, yy, rr, 'FUEL R', 0.7, [0.08, 1], 'GAL')
  miniGauge(g, w * 0.62, yy, rr, 'OIL T', 0.38 + eng * 0.22, [0.3, 0.9], '°F')
  miniGauge(g, w * 0.86, yy, rr, 'OIL P', 0.3 + eng * 0.38, [0.35, 0.8], 'PSI')
}

/** Magnetic "whiskey" compass card seen through its window. */
export function drawWhiskeyCompass(g: CanvasRenderingContext2D, s: Float64Array, w: number, h: number) {
  g.fillStyle = '#050607'
  g.fillRect(0, 0, w, h)
  const hdg = s[S.HEADING]
  const ppd = w / 70
  g.fillStyle = WHITE
  g.strokeStyle = WHITE
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.font = font(h * 0.36, 700)
  g.lineWidth = 2
  const first = Math.floor((hdg - 40) / 5) * 5
  for (let d = first; d <= hdg + 40; d += 5) {
    // The card reads backwards: higher headings appear to the left.
    const x = w / 2 - (d - hdg) * ppd
    const n = ((d % 360) + 360) % 360
    g.beginPath()
    g.moveTo(x, h * 0.62)
    g.lineTo(x, h * (n % 10 === 0 ? 0.86 : 0.76))
    g.stroke()
    if (n % 30 === 0) g.fillText(['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33'][n / 30], x, h * 0.33)
  }
  g.strokeStyle = '#ffb020'
  g.lineWidth = 3
  g.beginPath()
  g.moveTo(w / 2, 0)
  g.lineTo(w / 2, h)
  g.stroke()
}
