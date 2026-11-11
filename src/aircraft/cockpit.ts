// Cockpit interiors: built around the pilot eye point, with working displays
// and animated yoke/sidestick and throttle levers.

import { BoxGeometry, CylinderGeometry, DoubleSide, Group, Mesh, MeshStandardMaterial, Object3D, PlaneGeometry, TorusGeometry, Vector3, type Material } from 'three'
import { drawEICAS, drawND, drawPFD, drawSixPack, InstrumentCanvas } from './instruments'
import type { AircraftModel } from './models'
import { build737Cockpit } from './cockpit737'

export interface Cockpit {
  root: Group
  instruments: InstrumentCanvas[]
  yoke: Object3D | null
  stick: Object3D | null
  throttles: Object3D[]
  update(s: Float64Array, controls: { pitch: number; roll: number; throttle: number }): void
  dispose(): void
}

function box(w: number, h: number, d: number, mat: Material, parent: Object3D, x: number, y: number, z: number, rx = 0) {
  const m = new Mesh(new BoxGeometry(w, h, d), mat)
  m.position.set(x, y, z)
  m.rotation.x = rx
  m.castShadow = true
  m.receiveShadow = true
  parent.add(m)
  return m
}

function screen(tex: InstrumentCanvas, w: number, h: number, parent: Object3D, pos: Vector3, tilt: number) {
  const mat = new MeshStandardMaterial({ map: tex.texture, emissive: '#ffffff', emissiveMap: tex.texture, emissiveIntensity: 0.9, roughness: 0.3 })
  const m = new Mesh(new PlaneGeometry(w, h), mat)
  m.position.copy(pos)
  m.rotation.x = tilt
  parent.add(m)
  return m
}

/** Window frame: posts and sills forming the windshield around the eye point. */
function windowFrame(parent: Object3D, mat: Material, eye: Vector3, width: number, depth: number, top: number, bottom: number, sideDepth: number) {
  const zf = eye.z - depth
  const t = 0.045
  // Centre post, outer posts and top bow.
  box(t, top - bottom, t, mat, parent, 0, (top + bottom) / 2, zf)
  for (const s of [1, -1]) {
    box(t, top - bottom, t, mat, parent, (width / 2) * s, (top + bottom) / 2, zf + 0.12)
    // Side window rear post and sill/header.
    box(t, top - bottom, t, mat, parent, (width / 2 + 0.12) * s, (top + bottom) / 2, eye.z + sideDepth)
    box(0.05, 0.07, sideDepth + depth, mat, parent, (width / 2 + 0.08) * s, top, eye.z - (depth - sideDepth) / 2)
    box(0.05, 0.12, sideDepth + depth, mat, parent, (width / 2 + 0.1) * s, bottom - 0.02, eye.z - (depth - sideDepth) / 2)
  }
  box(width + 0.3, 0.12, 0.08, mat, parent, 0, top + 0.03, zf + 0.02)
}

export function buildCockpit(model: AircraftModel): Cockpit {
  if (model.id === 'b737') return build737Cockpit(model)
  const root = new Group()
  root.name = 'cockpit'
  const eye = model.eye
  const ga = model.cockpit === 'ga'
  const sidestick = model.id === 'a320'
  const shell = new MeshStandardMaterial({ color: ga ? '#4a453f' : '#2b3036', roughness: 0.92, metalness: 0.02, side: DoubleSide, envMapIntensity: 0.3 })
  const panelMat = new MeshStandardMaterial({ color: ga ? '#1e1f21' : '#22262b', roughness: 0.75, metalness: 0.1, envMapIntensity: 0.3 })
  const glare = new MeshStandardMaterial({ color: '#101113', roughness: 0.97, envMapIntensity: 0.2 })
  const frameMat = new MeshStandardMaterial({ color: ga ? '#8f8a82' : '#3a4047', roughness: 0.7, side: DoubleSide, envMapIntensity: 0.3 })
  const seatMat = new MeshStandardMaterial({ color: ga ? '#5a4632' : '#2d3036', roughness: 0.9 })
  const blackMat = new MeshStandardMaterial({ color: '#0f1012', roughness: 0.6, metalness: 0.3 })

  const width = ga ? 1.05 : model.cockpit === 'bizjet' ? 1.5 : 1.75
  const panelDist = ga ? 0.62 : 0.78
  const panelTop = eye.y - (ga ? 0.24 : 0.3)
  const panelH = ga ? 0.42 : 0.5
  const zPanel = eye.z - panelDist
  const centerX = ga ? 0 : 0
  const instruments: InstrumentCanvas[] = []

  // Main panel, slightly tilted back.
  box(width, panelH, 0.06, panelMat, root, centerX, panelTop - panelH / 2, zPanel, -0.12)
  // Glareshield
  box(width, 0.04, ga ? 0.16 : 0.22, glare, root, centerX, panelTop + 0.02, zPanel - (ga ? 0.06 : 0.09))
  // Floor, side walls, ceiling and rear bulkhead to enclose the view.
  const floorY = eye.y - (ga ? 0.95 : 1.15)
  const ceilY = eye.y + (ga ? 0.42 : 0.5)
  const halfW = width / 2 + 0.2
  box(halfW * 2, 0.05, 2.6, shell, root, 0, floorY, eye.z - 0.2)
  for (const s of [1, -1]) box(0.05, eye.y - 0.25 - floorY, 2.6, shell, root, halfW * s, (eye.y - 0.25 + floorY) / 2, eye.z - 0.2)
  if (!ga) box(halfW * 2, 0.05, 1.6, shell, root, 0, ceilY, eye.z + 0.2)
  box(halfW * 2, ceilY - floorY, 0.05, shell, root, 0, (ceilY + floorY) / 2, eye.z + 1.05)
  // Nose cone below the panel (blocks the view of the fuselage interior).
  box(width, panelTop - panelH - floorY, 0.05, shell, root, 0, (panelTop - panelH + floorY) / 2, zPanel - 0.05)

  windowFrame(root, frameMat, eye, width, panelDist + (ga ? 0.15 : 0.32), ceilY - 0.02, panelTop + 0.06, ga ? 0.55 : 0.25)

  // Overhead panel (airliners) with switch rows.
  if (!ga) {
    const ov = box(width * 0.55, 0.05, 0.8, panelMat, root, 0, ceilY - 0.06, eye.z - 0.25, 0.25)
    for (let i = 0; i < 6; i++) box(width * 0.45, 0.012, 0.02, blackMat, ov, 0, -0.03, -0.3 + i * 0.12)
  }

  // Displays
  const tilt = -0.12
  const faceZ = zPanel + 0.035
  if (ga) {
    const six = new InstrumentCanvas(1024, 600, drawSixPack)
    instruments.push(six)
    screen(six, 0.62, 0.36, root, new Vector3(eye.x + 0.05, panelTop - 0.22, faceZ), tilt)
  } else {
    const pfd = new InstrumentCanvas(512, 512, drawPFD)
    const nd = new InstrumentCanvas(512, 512, drawND)
    const eicas = new InstrumentCanvas(512, 512, drawEICAS)
    instruments.push(pfd, nd, eicas)
    const sz = model.cockpit === 'bizjet' ? 0.2 : 0.2
    const y = panelTop - 0.2
    for (const s of [-1, 1]) {
      const x0 = s * width * 0.36
      screen(pfd, sz, sz, root, new Vector3(x0 + (s < 0 ? -0.06 : 0.06) * -1 - s * 0.05, y, faceZ), tilt)
      screen(nd, sz, sz, root, new Vector3(x0 - s * 0.29, y, faceZ), tilt)
    }
    screen(eicas, sz, sz, root, new Vector3(0, y, faceZ), tilt)
    // Centre pedestal
    box(0.36, 0.5, 0.75, panelMat, root, 0, floorY + 0.5, eye.z - 0.32)
  }

  // Yokes or sidesticks
  let yoke: Object3D | null = null
  let stick: Object3D | null = null
  const yokes: Object3D[] = []
  const seats = ga ? [eye.x, -eye.x] : [eye.x, -eye.x]
  for (const sx of seats) {
    if (sidestick) {
      const st = new Group()
      st.position.set(sx + Math.sign(sx) * 0.42, eye.y - 0.62, eye.z - 0.05)
      root.add(st)
      box(0.03, 0.16, 0.03, blackMat, st, 0, 0.08, 0)
      box(0.05, 0.06, 0.07, blackMat, st, 0, 0.18, 0)
      if (sx === eye.x) stick = st
      yokes.push(st)
    } else {
      const col = new Group()
      col.position.set(sx, eye.y - 0.5, zPanel + 0.32)
      root.add(col)
      const wheel = new Group()
      wheel.position.set(0, 0.12, 0)
      col.add(wheel)
      const rim = new Mesh(new TorusGeometry(ga ? 0.13 : 0.15, 0.015, 8, 28, Math.PI * 1.2), blackMat)
      rim.rotation.z = Math.PI * -0.1 + Math.PI
      wheel.add(rim)
      box(ga ? 0.24 : 0.28, 0.04, 0.03, blackMat, wheel, 0, -0.01, 0)
      const shaft = new Mesh(new CylinderGeometry(0.02, 0.02, ga ? 0.32 : 0.12, 8), blackMat)
      shaft.rotation.x = Math.PI / 2
      shaft.position.z = ga ? -0.16 : -0.06
      wheel.add(shaft)
      if (!ga) box(0.06, 0.55, 0.06, blackMat, col, 0, -0.3, 0)
      if (sx === eye.x) yoke = col
      yokes.push(col)
    }
  }

  // Throttle levers
  const throttles: Object3D[] = []
  const nEng = ga ? 1 : 2
  for (let i = 0; i < nEng; i++) {
    const lever = new Group()
    lever.position.set(ga ? 0.02 : (i - 0.5) * 0.08, ga ? panelTop - panelH + 0.06 : floorY + 0.78, ga ? zPanel + 0.05 : eye.z - 0.45)
    root.add(lever)
    box(0.015, 0.22, 0.015, blackMat, lever, 0, 0.11, 0)
    box(ga ? 0.04 : 0.06, 0.03, 0.03, ga ? new MeshStandardMaterial({ color: '#111' }) : blackMat, lever, 0, 0.23, 0)
    throttles.push(lever)
  }

  // Seats
  for (const sx of seats) {
    const seat = new Group()
    seat.position.set(sx, floorY, eye.z + 0.25)
    root.add(seat)
    box(0.5, 0.12, 0.5, seatMat, seat, 0, 0.45, 0)
    box(0.5, 0.75, 0.12, seatMat, seat, 0, 0.85, 0.28, -0.12)
  }

  // Everything in the cockpit is lit by the scene lights.
  root.traverse((o) => o.layers.enableAll())

  let lastDraw = 0
  return {
    root,
    instruments,
    yoke,
    stick,
    throttles,
    update(s, c) {
      const now = performance.now()
      if (now - lastDraw > 50) {
        lastDraw = now
        for (const i of instruments) i.update(s)
      }
      for (const y of yokes) {
        if (sidestick) {
          y.rotation.x = -c.pitch * 0.3
          y.rotation.z = -c.roll * 0.3
        } else {
          y.position.z = zPanel + 0.32 + c.pitch * 0.07
          const wheel = y.children[0]
          if (wheel) wheel.rotation.z = -c.roll * 0.9
        }
      }
      for (const t of throttles) t.rotation.x = -0.6 + c.throttle * 1.0
    },
    dispose() {
      for (const i of instruments) i.dispose()
    },
  }
}
