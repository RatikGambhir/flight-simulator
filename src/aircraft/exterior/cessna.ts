import { BoxGeometry, CircleGeometry, CylinderGeometry, Group, Mesh, SphereGeometry, Vector3 } from 'three'
import { revolveZ, tubeGeometry, wingPoint, type Station, type WingParams } from '../geometry'
import { createMaterials, LIVERIES, paintFuselage, paintTail } from '../materials'
import { buildWings, mesh, navLights, newModel, tailSurface, wheel, type AircraftModel } from './parts'

function gaStations(): Station[] {
  const pts: [number, number, number, number][] = [
    // z, half width, half height, y centre
    [-2.32, 0.02, 0.02, -0.02],
    [-2.25, 0.16, 0.16, -0.02],
    [-2.1, 0.3, 0.3, -0.03],
    [-1.85, 0.44, 0.42, -0.02],
    [-1.4, 0.5, 0.52, 0.0],
    [-1.05, 0.53, 0.6, 0.08],
    [-0.6, 0.55, 0.68, 0.12],
    [0.2, 0.55, 0.68, 0.12],
    [1.0, 0.52, 0.6, 0.12],
    [1.6, 0.42, 0.5, 0.14],
    [2.6, 0.3, 0.38, 0.18],
    [3.8, 0.2, 0.3, 0.24],
    [4.9, 0.13, 0.24, 0.28],
    [5.85, 0.06, 0.16, 0.3],
    [5.95, 0.02, 0.02, 0.3],
  ]
  return pts.map(([z, hw, hh, yc]) => ({ z, hw, hh, yc }))
}

export function buildCessna(): AircraftModel {
  const livery = LIVERIES.c172
  const noseZ = -2.32
  const tailZ = 5.95
  const L = tailZ - noseZ
  const v = (z: number) => (z - noseZ) / L
  const fusTex = paintFuselage({
    livery,
    windowFrom: v(0.15),
    windowTo: v(1.0),
    windowCount: 2,
    windowU: 0.19,
    windowSize: [0.07, 0.085],
    cockpitV: [v(-1.0), v(-0.35)],
    cockpitU: [0.1, 0.19],
    doors: [],
    titleV: v(3.0),
    ga: true,
  })
  const m = createMaterials(livery, fusTex, paintTail(livery))
  const model = newModel('c172', 'ga', m)
  const root = model.root
  const fus = mesh(tubeGeometry(gaStations(), 48, 2.6), m.fuselage, root, 'fuselage')
  model.exteriorOnly.push(fus)
  // High wing (constant chord inboard, tapered outboard).
  const wingIn: WingParams = { span: 2.6, rootChord: 1.63, tipChord: 1.63, sweep: 0, dihedral: 1.7, thicknessRoot: 0.14, thicknessTip: 0.14 }
  const wingOut: WingParams = { span: 2.45, rootChord: 1.63, tipChord: 1.12, sweep: 4, dihedral: 1.7, thicknessRoot: 0.14, thicknessTip: 0.12 }
  const inAt = new Vector3(0.45, 0.86, -0.62)
  buildWings(model, root, { params: wingIn, at: inAt, flaps: [[0.02, 0.98]], mat: m.paint, surfaceMat: m.paint, hingeChord: 0.72 })
  const tipIn = wingPoint(wingIn, 1, 0, 1)
  const outAt = new Vector3(inAt.x + tipIn.x, inAt.y + tipIn.y, inAt.z + tipIn.z)
  buildWings(model, root, { params: wingOut, at: outAt, aileron: [0.05, 0.92], mat: m.paint, surfaceMat: m.paint, hingeChord: 0.72 })
  // Remove flap entries on the outer wing (none) — ailerons only.
  model.span = 2 * (outAt.x + wingOut.span)
  // Wing struts.
  for (const side of [1, -1] as const) {
    const a = new Vector3(0.5 * side, -0.32, -0.25)
    const b = new Vector3(2.6 * side, inAt.y - 0.08, -0.3)
    const len = a.distanceTo(b)
    const strut = new CylinderGeometry(0.035, 0.035, len, 8)
    strut.scale(1.8, 1, 1)
    const s = mesh(strut, m.paint, root)
    s.position.copy(a).add(b).multiplyScalar(0.5)
    s.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), b.clone().sub(a).normalize())
  }
  // Tail
  const hstab: WingParams = { span: 1.72, rootChord: 1.25, tipChord: 0.85, sweep: 8, dihedral: 0, thicknessRoot: 0.1, thicknessTip: 0.09 }
  tailSurface(model, root, hstab, new Vector3(0.12, 0.22, 4.75), 'elevator', m.paint, m.paint, 0.6)
  const fin: WingParams = { span: 1.5, rootChord: 1.55, tipChord: 0.72, sweep: 36, dihedral: 0, thicknessRoot: 0.1, thicknessTip: 0.09, vertical: true }
  tailSurface(model, root, fin, new Vector3(0, 0.42, 4.35), 'rudder', m.tail, m.tail, 0.62)
  // Engine cowling details: exhaust and air intakes are painted; add a spinner and propeller.
  const prop = new Group()
  prop.position.set(0, -0.02, -2.38)
  root.add(prop)
  const spinner = revolveZ([[0.16, 0], [0.12, 0.12], [0.02, 0.26]], 24)
  // Mirror so the tip points forward (-z) with outward-facing triangles.
  spinner.scale(1, 1, -1)
  spinner.translate(0, 0, 0.06)
  mesh(spinner, m.paint, prop)
  const blades = new Group()
  prop.add(blades)
  for (const ang of [0, Math.PI]) {
    const blade = new BoxGeometry(0.13, 0.92, 0.035)
    blade.translate(0, 0.52, 0)
    blade.rotateY(0.35)
    blade.rotateZ(ang)
    mesh(blade, m.darkMetal, blades)
  }
  const disc = new Mesh(new CircleGeometry(0.97, 48), m.propDisc)
  disc.visible = false
  prop.add(disc)
  model.spinners.push({ obj: prop, speed: 60, blurAbove: 0.25, blades, disc })
  // Fixed gear with wheel fairings.
  const pant = (pos: Vector3, scale: number) => {
    const g = new SphereGeometry(1, 18, 12)
    g.scale(0.14 * scale, 0.21 * scale, 0.42 * scale)
    const p = mesh(g, m.paint, root)
    p.position.copy(pos)
  }
  for (const side of [1, -1] as const) {
    const w = wheel(0.25, 0.15, m)
    w.position.set(1.22 * side, -0.8, 0.5)
    root.add(w)
    pant(new Vector3(1.22 * side, -0.76, 0.48), 1)
    const leg = new BoxGeometry(0.06, 0.95, 0.12)
    const l = mesh(leg, m.paint, root)
    l.position.set(0.85 * side, -0.55, 0.45)
    l.rotation.z = side * 1.05
  }
  const nw = wheel(0.2, 0.12, m)
  nw.position.set(0, -0.83, -1.55)
  root.add(nw)
  pant(new Vector3(0, -0.8, -1.55), 0.82)
  const nleg = new CylinderGeometry(0.04, 0.04, 0.55, 8)
  mesh(nleg, m.chrome, root).position.set(0, -0.55, -1.55)
  const tipR = new Vector3(outAt.x + wingOut.span + 0.03, outAt.y + 0.08, -0.3)
  navLights(model, tipR, new Vector3(0, 1.65, 5.95), new Vector3(0, 1.95, 5.6), new Vector3(0, -0.55, 0.8), { landing: [new Vector3(0, -0.3, -2.2)] })
  // Pilot eye: left seat.
  model.eye.set(-0.27, 0.55, -0.05)
  model.length = L
  return model
}
