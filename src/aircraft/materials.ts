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

export interface Livery {
  base: string
  belly: string
  stripe: string
  accent: string
  tail: string
  tailLogo: string
  title: string
}

export const LIVERIES: Record<string, Livery> = {
  b737: { base: '#f4f6f8', belly: '#c9d1da', stripe: '#13407a', accent: '#e5a823', tail: '#13407a', tailLogo: '#e5a823', title: 'GEOFLIGHT' },
  a320: { base: '#f6f6f4', belly: '#d7dbe0', stripe: '#b3123c', accent: '#2b2f3a', tail: '#b3123c', tailLogo: '#ffffff', title: 'GEOFLIGHT' },
  bizjet: { base: '#f7f7f7', belly: '#2d3440', stripe: '#8a6d3b', accent: '#2d3440', tail: '#f7f7f7', tailLogo: '#8a6d3b', title: 'N350GF' },
  c172: { base: '#fbfbf8', belly: '#fbfbf8', stripe: '#1f4f9c', accent: '#c8202f', tail: '#fbfbf8', tailLogo: '#1f4f9c', title: 'N172GF' },
}

export interface FuselagePaint {
  livery: Livery
  /** v (0 nose -> 1 tail) range with cabin windows. */
  windowFrom: number
  windowTo: number
  windowCount: number
  /** u of the window row centre (0.25 = right side midline). */
  windowU: number
  windowSize: [number, number]
  /** Cockpit window band (v range) and u spread from top. */
  cockpitV: [number, number]
  cockpitU: [number, number]
  doors: number[]
  titleV: number
  ga?: boolean
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
  if (!p.ga) {
    stripe(0.335, 0.03, L.stripe)
    stripe(0.665, 0.03, L.stripe)
    stripe(0.36, 0.008, L.accent)
    stripe(0.64, 0.008, L.accent)
  } else {
    stripe(0.3, 0.025, L.stripe)
    stripe(0.7, 0.025, L.stripe)
    stripe(0.325, 0.01, L.accent)
    stripe(0.675, 0.01, L.accent)
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

  // Cabin windows (both sides).
  g.fillStyle = '#1b2430'
  const [ww, wh] = p.windowSize
  for (let i = 0; i < p.windowCount; i++) {
    const v = p.windowFrom + ((p.windowTo - p.windowFrom) * i) / Math.max(1, p.windowCount - 1)
    if (p.doors.some((d) => Math.abs(d - v) < 0.012)) continue
    for (const u of [p.windowU, 1 - p.windowU]) {
      const x = W * u - (W * ww) / 2
      const y = H * v - (H * wh) / 2
      g.beginPath()
      g.roundRect(x, y, W * ww, H * wh, Math.min(W * ww, H * wh) * 0.45)
      g.fill()
    }
  }
  // Doors (outlines).
  g.strokeStyle = 'rgba(60,70,80,0.75)'
  g.lineWidth = 3
  for (const d of p.doors) {
    for (const u of [p.windowU + 0.02, 1 - p.windowU - 0.02]) {
      g.beginPath()
      g.roundRect(W * u - W * 0.03, H * d - H * 0.012, W * 0.06, H * 0.024, 6)
      g.stroke()
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
  // Title on both sides above the windows.
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
  const tex = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  tex.anisotropy = 8
  tex.wrapS = RepeatWrapping
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
  const tex = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  return tex
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
    fuselage: new MeshPhysicalMaterial({ map: fuselageMap, roughness: 0.3, metalness: 0.05, clearcoat: 0.8, clearcoatRoughness: 0.15, side: DoubleSide }),
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
