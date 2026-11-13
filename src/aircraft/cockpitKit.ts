// Parts shared by the airliner flight decks: painted-panel drawing helpers and a small
// builder for boxes, tubes, knobs, printed surfaces and live displays that bakes all
// decorative hardware into a few meshes. Coordinates are metres relative to the pilot's
// eye height and fore-aft position, with x = 0 on the aircraft centreline.
import {
  BoxGeometry, CanvasTexture, CylinderGeometry, DoubleSide, Group, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, SRGBColorSpace,
  Vector3, type BufferGeometry, type Material, type Object3D,
} from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { InstrumentCanvas } from './instruments'

export type Draw = (g: CanvasRenderingContext2D, w: number, h: number) => void
export const INK = '#e3e4de'
export const PANEL = '#3d444c'

export function text(g: CanvasRenderingContext2D, value: string, x: number, y: number, size = 18, color = INK) {
  g.fillStyle = color
  g.font = `500 ${size}px Arial, sans-serif`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(value, x, y)
}

export function screw(g: CanvasRenderingContext2D, x: number, y: number) {
  g.fillStyle = '#272a2d'
  g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill()
  g.strokeStyle = '#aaa9a0'; g.lineWidth = 1
  g.beginPath(); g.moveTo(x - 3, y); g.lineTo(x + 3, y); g.stroke()
}

export function panelBackground(g: CanvasRenderingContext2D, w: number, h: number, color = PANEL) {
  g.fillStyle = color; g.fillRect(0, 0, w, h)
  // Fine deterministic stipple, baked once, gives painted metal a tactile finish.
  for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) {
    const n = ((x * 73 + y * 137) % 31) / 31
    g.fillStyle = `rgba(${n > 0.5 ? '255,255,255' : '0,0,0'},0.035)`
    g.fillRect(x, y, 1, 1)
  }
  g.strokeStyle = '#292c2f'; g.lineWidth = 3; g.strokeRect(2, 2, w - 4, h - 4)
  for (const x of [14, w - 14]) for (const y of [14, h - 14]) screw(g, x, y)
}

export function button(g: CanvasRenderingContext2D, label: string, x: number, y: number, w = 65, h = 37, light = false) {
  g.fillStyle = '#24282b'; g.fillRect(x - w / 2, y - h / 2, w, h)
  g.strokeStyle = '#777b7a'; g.lineWidth = 1; g.strokeRect(x - w / 2, y - h / 2, w, h)
  const rows = label.split('\n')
  rows.forEach((row, i) => text(g, row, x, y + (i - (rows.length - 1) / 2) * 13, 12))
  if (light) { g.fillStyle = '#6bd890'; g.fillRect(x - w / 2 + 5, y - h / 2 + 3, w - 10, 3) }
}

export function dial(g: CanvasRenderingContext2D, x: number, y: number, r: number, label: string) {
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

/** Matte interior paint with a little self-illumination, so shaded panels stay readable. */
export function cockpitMaterial(color: string, roughness = 0.85) {
  return new MeshStandardMaterial({ color, roughness, metalness: 0.04, emissive: color, emissiveIntensity: 0.12 })
}

export type CockpitKit = ReturnType<typeof createCockpitKit>

/**
 * Builders that add to `root`. Parts go to a static group by default, which `bake` merges
 * by material; animated controls and click targets are added to `root` (or a group under
 * it) instead and stay separate.
 */
export function createCockpitKit(root: Group, hardware: { dark: Material; ivory: Material; silver: Material }) {
  const staticRoot = new Group(); root.add(staticRoot)
  const textures: CanvasTexture[] = []
  const { dark, ivory, silver } = hardware

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
  /** A painted panel: drawn once to a canvas. */
  function surface(draw: Draw, width: number, height: number, x: number, y: number, z: number, parent: Object3D = staticRoot, resX = 1024, resY = 512) {
    const canvas = document.createElement('canvas'); canvas.width = resX; canvas.height = resY
    draw(canvas.getContext('2d')!, resX, resY)
    const texture = new CanvasTexture(canvas); texture.colorSpace = SRGBColorSpace; texture.anisotropy = 8; textures.push(texture)
    const mat = new MeshStandardMaterial({ map: texture, roughness: 0.9, emissiveMap: texture, emissive: '#ffffff', emissiveIntensity: 0.22, side: DoubleSide })
    return mesh(new PlaneGeometry(width, height), mat, parent, x, y, z)
  }
  /** A bezel with a live instrument face. `faceParent` keeps the face out of the bake. */
  function display(instrument: InstrumentCanvas, x: number, y: number, width = 0.265, height = 0.265, z = -1.02, parent: Object3D = staticRoot, faceParent: Object3D = parent) {
    box(width + 0.037, height + 0.038, 0.035, dark, x, y, z - 0.008, parent, 0.014)
    const mat = new MeshBasicMaterial({ map: instrument.texture, toneMapped: false })
    const face = mesh(new PlaneGeometry(width, height), mat, faceParent, x, y, z + 0.012)
    face.name = 'live-display'
    for (const dx of [-1, 1]) for (const dy of [-1, 1]) knob(x + dx * (width / 2 + 0.009), y + dy * (height / 2 + 0.009), z + 0.01, 0.0035, parent, silver)
    return face
  }
  /**
   * Bake decorative hardware by material: hundreds of small parts, only a few draw
   * calls. Animated controls and clickable hit targets stay separate.
   */
  function bake(name: string) {
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
      if (merged) { const m = new Mesh(merged, mat); m.name = name; root.add(m) }
      geometries.forEach((g) => g.dispose())
    }
  }
  return { staticRoot, textures, mesh, box, rod, knob, surface, display, bake }
}
