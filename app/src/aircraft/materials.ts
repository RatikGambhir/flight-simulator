// Aircraft materials and procedurally painted liveries.

import {
  CanvasTexture,
  Color,
  DoubleSide,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from 'three'
import { liveryOptions, type LiveryId } from './liveries'

export interface Livery {
  base: string
  belly: string
  stripe: string
  accent: string
  tail: string
  tailLogo: string
  title: string
  brand?: Exclude<LiveryId, 'default'>
  military?: boolean
}

export const LIVERIES: Record<string, Livery> = {
  b737: { base: '#f4f6f8', belly: '#c9d1da', stripe: '#13407a', accent: '#e5a823', tail: '#13407a', tailLogo: '#e5a823', title: 'GEOFLIGHT' },
  a320: { base: '#f6f6f4', belly: '#d7dbe0', stripe: '#b3123c', accent: '#2b2f3a', tail: '#b3123c', tailLogo: '#ffffff', title: 'GEOFLIGHT' },
  a380: { base: '#f6f8fb', belly: '#cbd6df', stripe: '#15316a', accent: '#36b8cb', tail: '#15316a', tailLogo: '#36b8cb', title: 'GEOFLIGHT A380' },
  bizjet: { base: '#f7f7f7', belly: '#2d3440', stripe: '#8a6d3b', accent: '#2d3440', tail: '#f7f7f7', tailLogo: '#8a6d3b', title: 'N350GF' },
  longitude: { base: '#f8f8f6', belly: '#1c2a3f', stripe: '#1f6f86', accent: '#aeb6c0', tail: '#f8f8f6', tailLogo: '#1f6f86', title: 'N700GF' },
  c172: { base: '#fbfbf8', belly: '#fbfbf8', stripe: '#1f4f9c', accent: '#c8202f', tail: '#fbfbf8', tailLogo: '#1f4f9c', title: 'N172GF' },
  // Two-tone air-superiority grey: medium sides, light underside, dark spine.
  f16: { base: '#5f676e', belly: '#7b838a', stripe: '#454c53', accent: '#1f2226', tail: '#5f676e', tailLogo: '#383e44', title: 'U.S. AIR FORCE', military: true },
  sr71: { base: '#282b30', belly: '#22252a', stripe: '#777c80', accent: '#a2483c', tail: '#25282d', tailLogo: '#aa5547', title: 'U.S. AIR FORCE', military: true },
  c5m: { base: '#777f86', belly: '#697177', stripe: '#333a41', accent: '#aab0b4', tail: '#737b82', tailLogo: '#353c43', title: 'U.S. AIR FORCE', military: true },
  c17: { base: '#858c91', belly: '#6d757b', stripe: '#3e474f', accent: '#a0a8ad', tail: '#7c848a', tailLogo: '#3e474f', title: 'U.S. AIR FORCE', military: true },
}

const BRANDED_LIVERIES: Record<Exclude<LiveryId, 'default'>, Livery> = {
  delta: { brand: 'delta', base: '#f7f8fb', belly: '#0b2349', stripe: '#11294e', accent: '#d71932', tail: '#c60c30', tailLogo: '#102958', title: 'DELTA' },
  united: { brand: 'united', base: '#f6f8fc', belly: '#a5adb7', stripe: '#162c63', accent: '#1474ce', tail: '#1246a0', tailLogo: '#59c4f2', title: 'UNITED' },
  fedex: { brand: 'fedex', base: '#f9f7fc', belly: '#edeaf2', stripe: '#4d148c', accent: '#ff6600', tail: '#4d148c', tailLogo: '#ff7300', title: 'FedEx' },
  ups: { brand: 'ups', base: '#f5f2eb', belly: '#ddd7cc', stripe: '#351c15', accent: '#f5b727', tail: '#351c15', tailLogo: '#f5b727', title: 'UPS' },
  amazon: { brand: 'amazon', base: '#f2f6fa', belly: '#087cab', stripe: '#182a3a', accent: '#22a9db', tail: '#182a3a', tailLogo: '#27b5e4', title: 'Prime Air' },
}

export function aircraftLivery(aircraft: string, id: LiveryId = 'default'): Livery {
  if (id !== 'default' && liveryOptions(aircraft).some((option) => option.id === id)) {
    return BRANDED_LIVERIES[id]
  }
  return LIVERIES[aircraft]
}

function paintSideTitles(g: CanvasRenderingContext2D, livery: Livery, width: number, height: number, u: number, v: number, size: number) {
  g.font = `bold ${size}px "Helvetica Neue", Arial, sans-serif`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  for (const side of [1, -1]) {
    g.save()
    g.translate(width * (side === 1 ? u : 1 - u), height * v)
    g.rotate(-side * Math.PI / 2)
    g.fillStyle = livery.stripe
    if (livery.brand === 'fedex') {
      g.fillText('Fed', -size * 0.62, 0)
      g.fillStyle = livery.accent
      g.fillText('Ex', size * 0.77, 0)
    } else {
      g.fillText(livery.title, 0, 0)
    }
    g.restore()
  }
}

/** Fighter camouflage in the fuselage tube's UV space (u around, v along). */
export function paintFighter(livery: Livery): Texture {
  const W = 1024
  const H = 512
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  // u: 0 top, 0.25 right, 0.5 bottom, 0.75 left. Soft-edged bands, as sprayed.
  const grad = g.createLinearGradient(0, 0, W, 0)
  const stops: [number, string][] = [
    [0, livery.stripe],
    [0.09, livery.stripe],
    [0.15, livery.base],
    [0.33, livery.base],
    [0.4, livery.belly],
    [0.6, livery.belly],
    [0.67, livery.base],
    [0.85, livery.base],
    [0.91, livery.stripe],
    [1, livery.stripe],
  ]
  for (const [u, col] of stops) grad.addColorStop(u, col)
  g.fillStyle = grad
  g.fillRect(0, 0, W, H)
  // Radome (slightly different grey composite) and the dark anti-glare panel ahead of the canopy.
  g.fillStyle = '#7f878e'
  g.fillRect(0, 0, W, H * 0.045)
  g.fillStyle = livery.accent
  g.fillRect(0, H * 0.06, W * 0.07, H * 0.11)
  g.fillRect(W * 0.93, H * 0.06, W * 0.07, H * 0.11)
  // Panel lines.
  g.strokeStyle = 'rgba(40,45,50,0.35)'
  g.lineWidth = 2
  for (const v of [0.045, 0.2, 0.3, 0.44, 0.58, 0.72, 0.86]) {
    g.beginPath()
    g.moveTo(0, H * v)
    g.lineTo(W, H * v)
    g.stroke()
  }
  for (const u of [0.2, 0.3, 0.7, 0.8]) {
    g.beginPath()
    g.moveTo(W * u, H * 0.2)
    g.lineTo(W * u, H * 0.9)
    g.stroke()
  }
  paintSideTitles(g, livery, W, H, 0.20, 0.39, H * 0.05)
  const tex = new CanvasTexture(c)
  tex.flipY = false
  tex.colorSpace = SRGBColorSpace
  tex.anisotropy = 8
  tex.wrapS = RepeatWrapping
  return tex
}

/** Fighter fin: grey with a dark tip band and a low-visibility badge. Wing UVs (u = chord, v = span). */
export function paintFighterTail(livery: Livery): Texture {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 512
  const g = c.getContext('2d')!
  g.fillStyle = livery.tail
  g.fillRect(0, 0, 512, 512)
  // Dark band at the tip (canvas top = v 1 = fin tip).
  g.fillStyle = livery.stripe
  g.fillRect(0, 0, 512, 82)
  // Both fin skins share these UVs (one side sees it mirrored), so the badge is
  // left-right symmetric: a ring with a bar through it.
  g.strokeStyle = livery.tailLogo
  g.fillStyle = livery.tailLogo
  g.lineWidth = 18
  g.beginPath()
  g.arc(256, 250, 70, 0, Math.PI * 2)
  g.stroke()
  g.fillRect(130, 238, 252, 24)
  const tex = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  return tex
}

/** Dark titanium panels and low-visibility markings in the Blackbird's tube UVs. */
export function paintBlackbird(livery: Livery): Texture {
  const c = document.createElement('canvas')
  c.width = c.height = 1024
  const g = c.getContext('2d')!
  const grad = g.createLinearGradient(0, 0, c.width, 0)
  for (const [u, color] of [[0, livery.base], [0.5, livery.belly], [1, livery.base]] as const) grad.addColorStop(u, color)
  g.fillStyle = grad
  g.fillRect(0, 0, c.width, c.height)
  for (let i = 0; i < 23; i++) {
    const y = 46 + i * 41 + (i % 4) * 5
    g.fillStyle = i % 3 === 0 ? '#ffffff0a' : '#0000000a'
    g.fillRect(0, y, c.width, 24 + (i % 3) * 6)
    g.fillStyle = '#101217'
    g.fillRect(0, y, c.width, i === 2 ? 3 : 1)
  }
  for (const u of [0.15, 0.34, 0.66, 0.85]) g.fillRect(c.width * u, 110, 1, 865)
  paintSideTitles(g, livery, c.width, c.height, 0.21, 0.38, 19)
  g.fillStyle = livery.accent
  for (const u of [0.18, 0.82]) g.fillRect(c.width * u - 13, 219, 26, 5)
  const tex = new CanvasTexture(c)
  tex.flipY = false
  tex.wrapS = RepeatWrapping
  tex.anisotropy = 4
  tex.colorSpace = SRGBColorSpace
  return tex
}

/** Dark airfoil skin in chord/span UVs with the Blackbird's corrugated panels. */
export function paintBlackbirdAirfoil(livery: Livery): Texture {
  const c = document.createElement('canvas')
  c.width = c.height = 512
  const g = c.getContext('2d')!
  g.fillStyle = livery.tail
  g.fillRect(0, 0, c.width, c.height)
  for (let x = 65; x < 460; x += 13) {
    g.fillStyle = x % 3 === 0 ? '#42444a' : '#33363c'
    g.fillRect(x, 0, 2, c.height)
    g.fillStyle = '#191b20'
    g.fillRect(x + 2, 0, 1, c.height)
  }
  for (const y of [27, 118, 271, 407]) g.fillRect(0, y, c.width, 2)
  const tex = new CanvasTexture(c)
  tex.anisotropy = 4
  tex.colorSpace = SRGBColorSpace
  return tex
}

interface CabinDeckPaint {
  /** v (0 nose -> 1 tail) range with cabin windows. */
  windowFrom: number
  windowTo: number
  windowCount: number
  /** u of the window row centre (0.25 = right side midline). */
  windowU: number
  windowSize: [number, number]
  doors: number[]
}

export interface FuselagePaint extends CabinDeckPaint {
  livery: Livery
  upperDeck?: CabinDeckPaint
  /** Cockpit window band (v range) and u spread from top. */
  cockpitV: [number, number]
  cockpitU: [number, number]
  titleV: number
  ga?: boolean
  cargo?: { noseDoorV?: number; rampV: number }
}

function px(n: number) {
  return Math.round(n)
}

/** Paints a fuselage texture in the tube's UV space (u around, v along). */
export function paintFuselage(p: FuselagePaint): Texture {
  const W = 2048
  const H = 1024
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  const L = p.livery
  // Lit cabin windows for night, in the same UV space (black elsewhere).
  const ec = document.createElement('canvas')
  ec.width = W / 2
  ec.height = H / 2
  const eg = ec.getContext('2d')!
  eg.fillStyle = '#000'
  eg.fillRect(0, 0, ec.width, ec.height)
  // u maps to x (around), v maps to y (along). Top u=0/1, right 0.25, bottom 0.5, left 0.75.
  g.fillStyle = L.base
  g.fillRect(0, 0, W, H)
  // Belly
  g.fillStyle = L.belly
  g.fillRect(W * 0.36, 0, W * 0.28, H)
  // Cheatline stripes on both sides, below windows.
  const stripe = (u: number, width: number, color: string) => {
    g.fillStyle = color
    g.fillRect(px(W * (u - width / 2)), 0, px(W * width), H)
  }
  if (!L.military && (!L.brand || L.brand === 'united' || L.brand === 'ups')) {
    const lightAircraft = p.ga && !L.brand
    const center = lightAircraft ? 0.30 : 0.335
    const trim = lightAircraft ? 0.325 : 0.36
    for (const u of [center, 1 - center]) stripe(u, lightAircraft ? 0.025 : 0.03, L.stripe)
    for (const u of [trim, 1 - trim]) stripe(u, lightAircraft ? 0.01 : 0.008, L.accent)
  }
  // Fade the stripe away towards the nose & tail.
  const grad = g.createLinearGradient(0, 0, 0, H)
  grad.addColorStop(0, L.base)
  grad.addColorStop(0.06, 'rgba(0,0,0,0)')
  grad.addColorStop(0.94, 'rgba(0,0,0,0)')
  grad.addColorStop(1, L.base)
  g.fillStyle = grad
  g.globalCompositeOperation = 'source-atop'
  g.globalCompositeOperation = 'source-over'

  const decks = p.upperDeck ? [p, p.upperDeck] : [p]
  for (const deck of decks) {
    // Cabin windows on both sides, with a separate emissive layer for night.
    g.fillStyle = '#1b2430'
    const [ww, wh] = deck.windowSize
    for (let i = 0; i < deck.windowCount; i++) {
      const v = deck.windowFrom + ((deck.windowTo - deck.windowFrom) * i) / Math.max(1, deck.windowCount - 1)
      if (deck.doors.some((d) => Math.abs(d - v) < 0.012)) continue
      for (const u of [deck.windowU, 1 - deck.windowU]) {
        const x = W * u - (W * ww) / 2
        const y = H * v - (H * wh) / 2
        g.beginPath()
        g.roundRect(x, y, W * ww, H * wh, Math.min(W * ww, H * wh) * 0.45)
        g.fill()
        // A few shades drawn or seats dark, so the row does not look printed on.
        const lit = [1, 0.85, 1, 0.25, 0.9, 1, 0.7, 1, 0.1, 0.95][(i * 7 + (u < 0.5 ? 0 : 3)) % 10]
        eg.fillStyle = `rgba(255, 214, 150, ${lit})`
        eg.beginPath()
        eg.roundRect(x / 2, y / 2, (W * ww) / 2, (H * wh) / 2, Math.min(W * ww, H * wh) * 0.22)
        eg.fill()
      }
    }
    g.strokeStyle = 'rgba(60,70,80,0.75)'
    g.lineWidth = 3
    for (const d of deck.doors) {
      for (const u of [deck.windowU + 0.02, 1 - deck.windowU - 0.02]) {
        g.beginPath()
        g.roundRect(W * u - W * 0.03, H * d - H * 0.012, W * 0.06, H * 0.024, 6)
        g.stroke()
      }
    }
  }
  // Cockpit windows: dark band split into panes.
  const [cv0, cv1] = p.cockpitV
  const [cu0, cu1] = p.cockpitU
  g.fillStyle = '#121820'
  for (const side of [1, -1]) {
    const ua = side === 1 ? cu0 : 1 - cu1
    const ub = side === 1 ? cu1 : 1 - cu0
    g.beginPath()
    g.moveTo(W * ua, H * cv1)
    g.lineTo(W * ub, H * cv1)
    g.lineTo(W * ub, H * (cv0 + (cv1 - cv0) * 0.35))
    g.lineTo(W * (ua + (ub - ua) * 0.15), H * cv0)
    g.closePath()
    g.fill()
  }
  // Front windshield panes across the top.
  g.fillRect(0, H * (cv0 + (cv1 - cv0) * 0.2), W * cu0 * 1.02, H * (cv1 - cv0) * 0.8)
  g.fillRect(W * (1 - cu0 * 1.02), H * (cv0 + (cv1 - cv0) * 0.2), W * cu0 * 1.02, H * (cv1 - cv0) * 0.8)
  // Window frames.
  g.strokeStyle = L.base
  g.lineWidth = 6
  for (const u of [0, cu0 * 0.98, cu1 * 0.6, 1 - cu0 * 0.98, 1 - cu1 * 0.6]) {
    g.beginPath()
    g.moveTo(W * u, H * cv0)
    g.lineTo(W * u, H * cv1)
    g.stroke()
  }
  if (p.cargo) {
    const { noseDoorV, rampV } = p.cargo
    g.strokeStyle = 'rgba(37,45,53,0.55)'
    g.lineWidth = 2
    // Seams around the hinged nose and upswept cargo ramp.
    if (noseDoorV !== undefined) {
      g.beginPath()
      g.moveTo(0, H * noseDoorV)
      g.lineTo(W * 0.16, H * (noseDoorV + 0.03))
      g.lineTo(W * 0.84, H * (noseDoorV + 0.03))
      g.lineTo(W, H * noseDoorV)
      g.stroke()
    }
    g.beginPath()
    g.roundRect(W * 0.32, H * rampV, W * 0.36, H * (0.97 - rampV), 10)
    g.stroke()
  }
  if (L.brand || p.cargo) {
    paintSideTitles(g, L, W, H, p.windowU - 0.055, p.titleV, H * (L.brand ? 0.051 : 0.031))
  } else {
    // Title above the main deck windows, between the rows on a double-decker.
    g.fillStyle = L.stripe
    g.font = `bold ${H * 0.045}px "Helvetica Neue", Arial, sans-serif`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    for (const [u, rot] of [
      [p.windowU - 0.055, Math.PI / 2],
      [1 - p.windowU + 0.055, -Math.PI / 2],
    ] as const) {
      g.save()
      g.translate(W * u, H * p.titleV)
      g.rotate(rot)
      g.fillText(L.title, 0, 0)
      g.restore()
    }
  }
  const tex = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  tex.anisotropy = 8
  tex.wrapS = RepeatWrapping
  const windows = new CanvasTexture(ec)
  windows.colorSpace = SRGBColorSpace
  windows.wrapS = RepeatWrapping
  if (L.brand || p.cargo) {
    tex.flipY = false
    windows.flipY = false
  }
  tex.userData.windows = windows
  return tex
}

/** Fin paint: colored tail with a stylized globe logo. Mapped through wing UVs (u = chord, v = span). */
export function paintTail(livery: Livery): Texture {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 512
  const g = c.getContext('2d')!
  g.fillStyle = livery.tail
  g.fillRect(0, 0, 512, 512)
  if (livery.brand) {
    paintBrandTail(g, livery)
  } else if (livery.military) {
    g.fillStyle = livery.tailLogo
    g.fillRect(0, 64, 512, 55)
    g.fillRect(88, 205, 306, 21)
    g.fillRect(122, 241, 238, 12)
  } else {
    g.save()
    g.translate(300, 280)
    g.strokeStyle = livery.tailLogo
    g.lineWidth = 16
    g.beginPath()
    g.arc(0, 0, 110, 0, Math.PI * 2)
    g.stroke()
    g.beginPath()
    g.ellipse(0, 0, 45, 110, 0, 0, Math.PI * 2)
    g.stroke()
    g.beginPath()
    g.moveTo(-110, 0)
    g.lineTo(110, 0)
    g.stroke()
    g.lineWidth = 22
    g.beginPath()
    g.moveTo(-150, 70)
    g.quadraticCurveTo(0, -40, 160, -120)
    g.stroke()
    g.restore()
  }
  const tex = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  return tex
}

function paintBrandTail(g: CanvasRenderingContext2D, livery: Livery) {
  g.fillStyle = livery.tailLogo
  g.strokeStyle = livery.tailLogo
  switch (livery.brand) {
    case 'delta':
      g.beginPath()
      g.moveTo(0, 0)
      g.lineTo(300, 0)
      g.lineTo(512, 512)
      g.lineTo(236, 512)
      g.closePath()
      g.fill()
      g.fillStyle = '#f7f8fb'
      g.beginPath()
      g.moveTo(220, 128)
      g.lineTo(323, 298)
      g.lineTo(220, 255)
      g.lineTo(117, 298)
      g.closePath()
      g.fill()
      break
    case 'united':
      g.lineWidth = 20
      for (const width of [72, 143, 216]) {
        g.beginPath()
        g.ellipse(258, 257, width, 196, 0, 0, Math.PI * 2)
        g.stroke()
      }
      for (const y of [157, 250, 343]) g.fillRect(65, y, 386, 17)
      break
    case 'fedex':
      g.fillRect(0, 358, 512, 48)
      g.beginPath()
      g.moveTo(136, 172)
      g.lineTo(310, 172)
      g.lineTo(310, 119)
      g.lineTo(435, 219)
      g.lineTo(310, 319)
      g.lineTo(310, 260)
      g.lineTo(136, 260)
      g.closePath()
      g.fill()
      break
    case 'ups':
      g.beginPath()
      g.moveTo(112, 111)
      g.quadraticCurveTo(254, 78, 395, 111)
      g.lineTo(386, 250)
      g.quadraticCurveTo(370, 332, 254, 391)
      g.quadraticCurveTo(136, 331, 119, 250)
      g.closePath()
      g.lineWidth = 26
      g.stroke()
      break
    case 'amazon':
      g.lineWidth = 25
      g.lineCap = 'round'
      g.beginPath()
      g.moveTo(91, 235)
      g.quadraticCurveTo(254, 382, 416, 215)
      g.moveTo(363, 215)
      g.lineTo(420, 208)
      g.lineTo(414, 263)
      g.stroke()
      break
  }
}

export interface AircraftMaterials {
  fuselage: MeshPhysicalMaterial
  paint: MeshPhysicalMaterial
  belly: MeshPhysicalMaterial
  tail: MeshPhysicalMaterial
  wing: MeshPhysicalMaterial
  wingDark: MeshStandardMaterial
  metal: MeshStandardMaterial
  darkMetal: MeshStandardMaterial
  chrome: MeshStandardMaterial
  tire: MeshStandardMaterial
  fan: MeshStandardMaterial
  glass: MeshPhysicalMaterial
  accent: MeshPhysicalMaterial
  propDisc: MeshBasicMaterial
  navRed: MeshBasicMaterial
  navGreen: MeshBasicMaterial
  navWhite: MeshBasicMaterial
  strobe: MeshBasicMaterial
}

export function createMaterials(livery: Livery, fuselageMap: Texture, tailMap: Texture): AircraftMaterials {
  const paint = (color: string, rough = 0.32) =>
    new MeshPhysicalMaterial({ color, roughness: rough, metalness: 0.05, clearcoat: 0.7, clearcoatRoughness: 0.18, side: DoubleSide })
  const navMat = (c: string) => new MeshBasicMaterial({ color: new Color(c).multiplyScalar(6), toneMapped: true })
  return {
    // Cabin windows glow at night: the controller raises emissiveIntensity from 0.
    fuselage: new MeshPhysicalMaterial({ map: fuselageMap, emissive: '#ffffff', emissiveMap: (fuselageMap.userData.windows as Texture | undefined) ?? null, emissiveIntensity: 0, roughness: 0.3, metalness: 0.05, clearcoat: 0.8, clearcoatRoughness: 0.15, side: DoubleSide }),
    paint: paint(livery.base),
    belly: paint(livery.belly),
    tail: new MeshPhysicalMaterial({ map: tailMap, roughness: 0.3, metalness: 0.05, clearcoat: 0.8, clearcoatRoughness: 0.15, side: DoubleSide }),
    wing: new MeshPhysicalMaterial({ color: '#c3c9d0', roughness: 0.42, metalness: 0.35, clearcoat: 0.3, side: DoubleSide }),
    wingDark: new MeshStandardMaterial({ color: '#8d949c', roughness: 0.55, metalness: 0.4, side: DoubleSide }),
    metal: new MeshStandardMaterial({ color: '#b9bec4', roughness: 0.35, metalness: 0.85, side: DoubleSide }),
    darkMetal: new MeshStandardMaterial({ color: '#3a3f46', roughness: 0.5, metalness: 0.7, side: DoubleSide }),
    chrome: new MeshStandardMaterial({ color: '#e6e9ec', roughness: 0.12, metalness: 1.0, side: DoubleSide }),
    tire: new MeshStandardMaterial({ color: '#1a1b1d', roughness: 0.9, metalness: 0.0, side: DoubleSide }),
    fan: new MeshStandardMaterial({ color: '#2a2e33', roughness: 0.35, metalness: 0.9, side: DoubleSide }),
    glass: new MeshPhysicalMaterial({ color: '#0e141c', roughness: 0.05, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.02, side: DoubleSide }),
    accent: paint(livery.stripe),
    propDisc: new MeshBasicMaterial({ color: '#2b2b2b', transparent: true, opacity: 0.18, depthWrite: false, side: DoubleSide }),
    navRed: navMat('#ff2a2a'),
    navGreen: navMat('#22ff66'),
    navWhite: navMat('#ffffff'),
    strobe: navMat('#ffffff'),
  }
}
