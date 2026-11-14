import { AdditiveBlending, BoxGeometry, CircleGeometry, ConeGeometry, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, Object3D, Quaternion as Quat, SphereGeometry, Vector3 } from 'three'
import { revolveZ, tubeGeometry, wingPanelGeometry, wingPoint, type Station, type WingParams } from '../geometry'
import { createMaterials, LIVERIES, paintFighter, paintFighterTail } from '../materials'
import { buildWings, gearLeg, mesh, navLights, newModel, tailSurface, type AircraftModel } from './parts'

// F-16-style single-engine fighter: blended body with a chin intake, bubble
// canopy, 40° cropped-delta wing with leading-edge extensions, all-moving
// anhedral stabilators, single fin with ventral fins and a variable nozzle
// with an afterburner plume. 15.1 m long, 9.96 m span over the tip rails.

function fighterStations(): Station[] {
  // z, half width, half height, centre height
  const pts: [number, number, number, number][] = [
    [-8.6, 0.02, 0.02, -0.05],
    [-8.45, 0.12, 0.12, -0.05],
    [-8.1, 0.25, 0.25, -0.04],
    [-7.6, 0.37, 0.37, -0.02],
    [-7.0, 0.46, 0.47, 0.0],
    [-6.3, 0.53, 0.55, 0.03],
    [-5.6, 0.57, 0.6, 0.05],
    [-4.8, 0.6, 0.62, 0.05],
    [-4.0, 0.64, 0.64, 0.04],
    [-3.2, 0.74, 0.66, 0.02],
    [-2.4, 0.86, 0.68, 0.0],
    [-1.4, 0.95, 0.7, 0.0],
    [0.0, 0.98, 0.7, 0.0],
    [1.5, 0.96, 0.68, 0.02],
    [2.8, 0.88, 0.64, 0.05],
    [3.8, 0.78, 0.6, 0.08],
    [4.8, 0.68, 0.56, 0.1],
    [5.6, 0.62, 0.54, 0.1],
    [6.05, 0.6, 0.53, 0.1],
  ]
  return pts.map(([z, hw, hh, yc]) => ({ z, hw, hh, yc }))
}

const st = (pts: [number, number, number, number][]): Station[] => pts.map(([z, hw, hh, yc]) => ({ z, hw, hh, yc }))

export function buildFighter(): AircraftModel {
  const livery = LIVERIES.f16
  const m = createMaterials(livery, paintFighter(livery), paintFighterTail(livery))
  // Matte military paint rather than glossy airline clearcoat.
  for (const mat of [m.fuselage, m.paint, m.belly, m.tail, m.accent]) {
    mat.clearcoat = 0.08
    mat.roughness = 0.62
    mat.metalness = 0.08
  }
  m.wing.color.set(livery.base)
  m.wing.metalness = 0.08
  m.wing.roughness = 0.62
  m.wing.clearcoat = 0.05
  // Gold-tinted canopy.
  m.glass.color.set('#3b3216')
  m.glass.metalness = 0.55
  m.glass.roughness = 0.04
  const model = newModel('f16', 'fighter', m)
  const root = model.root

  // Fuselage, dorsal spine and chin intake.
  const fus = mesh(tubeGeometry(fighterStations(), 56, 2.3), m.fuselage, root, 'fuselage')
  model.exteriorOnly.push(fus)
  const spine = tubeGeometry(
    st([
      [-3.6, 0.02, 0.02, 0.7],
      [-3.3, 0.36, 0.3, 0.7],
      [-2.0, 0.42, 0.28, 0.66],
      [0.0, 0.44, 0.26, 0.6],
      [2.0, 0.42, 0.24, 0.58],
      [3.8, 0.36, 0.2, 0.55],
      [4.8, 0.25, 0.12, 0.55],
      [5.2, 0.02, 0.02, 0.55],
    ]),
    32,
    2.2,
  )
  mesh(spine, m.paint, root)
  const intake = tubeGeometry(
    st([
      [-4.4, 0.5, 0.36, -0.8],
      [-3.5, 0.52, 0.37, -0.78],
      [-2.5, 0.55, 0.36, -0.72],
      [-1.0, 0.58, 0.32, -0.62],
      [0.5, 0.6, 0.25, -0.52],
      [1.6, 0.5, 0.08, -0.48],
    ]),
    40,
    2.8,
  )
  model.exteriorOnly.push(mesh(intake, m.belly, root))
  const mouth = new CircleGeometry(1, 32)
  mouth.scale(0.46, 0.32, 1)
  mouth.rotateY(Math.PI)
  mouth.translate(0, -0.8, -4.25)
  mesh(mouth, m.darkMetal, root)
  // Pitot boom.
  const pitot = new CylinderGeometry(0.012, 0.03, 0.75, 8)
  pitot.rotateX(Math.PI / 2)
  pitot.translate(0, -0.05, -8.95)
  model.exteriorOnly.push(mesh(pitot, m.metal, root))

  // Bubble canopy (exterior only; the cockpit view has its own frame).
  const canopy = new SphereGeometry(1, 40, 16, 0, Math.PI * 2, 0, Math.PI / 2)
  canopy.scale(0.43, 0.5, 1.8)
  canopy.translate(0, 0.56, -5.0)
  model.exteriorOnly.push(mesh(canopy, m.glass, root, 'canopy'))

  // Leading-edge extensions blending the forebody into the wing.
  const lerx: WingParams = { span: 0.78, rootChord: 3.6, tipChord: 0.35, sweep: 71.6, dihedral: 0, thicknessRoot: 0.05, thicknessTip: 0.04, camber: 0 }
  for (const side of [1, -1] as const) {
    const g = new Group()
    g.position.set(0.62 * side, -0.02, -4.3)
    root.add(g)
    mesh(wingPanelGeometry(lerx, 0, 1, 0, 1, side, 4, 12), m.paint, g)
  }

  // Wing: 40° leading-edge sweep, unswept trailing edge, flaperons and tip rails.
  const wing: WingParams = { span: 3.83, rootChord: 4.28, tipChord: 1.07, sweep: 40, dihedral: 0, thicknessRoot: 0.045, thicknessTip: 0.04, camber: 0.005 }
  const wingAt = new Vector3(0.9, -0.05, -2.03)
  const before = model.surfaces.length
  buildWings(model, root, { params: wing, at: wingAt, flaps: [[0.03, 0.5]], aileron: [0.5, 0.92], hingeChord: 0.78, mat: m.wing, surfaceMat: m.wing })
  // Flaperons droop ~20° rather than an airliner's 37°.
  for (const sfc of model.surfaces.slice(before)) if (sfc.kind === 'flap') sfc.max = 0.35
  const railX = wingAt.x + wing.span + 0.07
  for (const side of [1, -1] as const) {
    const rail = new BoxGeometry(0.1, 0.12, 3.1)
    rail.translate(railX * side, wingAt.y, 0.85)
    mesh(rail, m.paint, root)
    const nose = new ConeGeometry(0.06, 0.35, 10)
    nose.rotateX(-Math.PI / 2)
    nose.translate(railX * side, wingAt.y, -0.88)
    mesh(nose, m.paint, root)
  }
  model.span = 2 * (railX + 0.05)

  // All-moving stabilators with anhedral, pivoting about a spanwise axis.
  const stab: WingParams = { span: 2.1, rootChord: 2.2, tipChord: 0.85, sweep: 40, dihedral: -10, thicknessRoot: 0.05, thicknessTip: 0.04, camber: 0 }
  const pivotZ = 0.77
  for (const side of [1, -1] as const) {
    const g = new Group()
    g.position.set(0.62 * side, 0.02, 3.6)
    root.add(g)
    const pivot = new Object3D()
    pivot.position.set(0, 0, pivotZ)
    g.add(pivot)
    const geo = wingPanelGeometry(stab, 0, 1, 0, 1, side, 6, 12)
    geo.translate(0, 0, -pivotZ)
    mesh(geo, m.paint, pivot)
    model.surfaces.push({ pivot, restQuaternion: new Quat(), kind: 'elevator', max: 0.3, sign: 1 })
  }

  // Fin with rudder, plus canted ventral fins.
  const fin: WingParams = { span: 2.25, rootChord: 3.6, tipChord: 1.1, sweep: 47, dihedral: 0, thicknessRoot: 0.06, thicknessTip: 0.05, camber: 0, vertical: true }
  const finAt = new Vector3(0, 0.72, 2.2)
  tailSurface(model, root, fin, finAt, 'rudder', m.tail, m.tail, 0.72)
  const finTop = wingPoint(fin, 1, 0, 1).add(finAt)
  const ventral: WingParams = { span: 0.5, rootChord: 1.2, tipChord: 0.7, sweep: 50, dihedral: 0, thicknessRoot: 0.06, thicknessTip: 0.05, camber: 0, vertical: true }
  for (const side of [1, -1] as const) {
    const g = new Group()
    g.position.set(0.42 * side, -0.48, 3.6)
    g.rotation.z = Math.PI - side * 0.26
    root.add(g)
    mesh(wingPanelGeometry(ventral, 0, 1, 0, 1, 1, 2, 8), m.paint, g)
  }

  // Variable exhaust nozzle (faceted petals) with a hot core and afterburner plume.
  const noz = new Group()
  noz.position.set(0, 0.1, 6.0)
  root.add(noz)
  const petals = revolveZ(
    [
      [0.6, 0],
      [0.59, -0.25],
      [0.53, -0.7],
      [0.47, -0.95],
    ],
    15,
  )
  petals.scale(1, 1, -1)
  mesh(petals, m.darkMetal, noz)
  const liner = new CylinderGeometry(0.44, 0.5, 0.9, 24, 1, true)
  liner.rotateX(Math.PI / 2)
  liner.translate(0, 0, 0.48)
  mesh(liner, m.metal, noz)
  const coreMat = new MeshBasicMaterial({ color: '#ff7a2a', transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, side: DoubleSide })
  const core = new Mesh(new CircleGeometry(0.44, 24), coreMat)
  core.position.z = 0.35
  noz.add(core)
  const plume = new Group()
  plume.position.z = 0.95
  plume.visible = false
  noz.add(plume)
  const flameMat = (color: string) => new MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, side: DoubleSide })
  const outerMat = flameMat('#ff8a3c')
  const innerMat = flameMat('#9ec4ff')
  const outer = new ConeGeometry(0.43, 3.4, 24, 1, true)
  outer.rotateX(Math.PI / 2)
  outer.translate(0, 0, 1.7)
  plume.add(new Mesh(outer, outerMat))
  const inner = new ConeGeometry(0.3, 1.9, 20, 1, true)
  inner.rotateX(Math.PI / 2)
  inner.translate(0, 0, 0.95)
  plume.add(new Mesh(inner, innerMat))
  // Shock diamonds.
  const diamondMat = flameMat('#cfe0ff')
  for (let i = 0; i < 4; i++) {
    const d = new SphereGeometry(1, 12, 8)
    d.scale(0.2 - i * 0.03, 0.2 - i * 0.03, 0.14)
    d.translate(0, 0, 0.55 + i * 0.62)
    plume.add(new Mesh(d, diamondMat))
  }
  model.exhaust = (engine, ab, time) => {
    coreMat.opacity = 0.04 + 0.3 * engine * engine + 0.5 * ab
    coreMat.color.set(ab > 0 ? '#ffb070' : '#ff6a20')
    plume.visible = ab > 0.001
    if (!plume.visible) return
    const flicker = 1 + 0.05 * Math.sin(time * 47) + 0.03 * Math.sin(time * 113)
    plume.scale.set(0.9 + 0.1 * ab, 0.9 + 0.1 * ab, (0.55 + 0.45 * ab) * flicker)
    outerMat.opacity = 0.35 + 0.35 * ab
    innerMat.opacity = 0.45 + 0.3 * ab
    diamondMat.opacity = 0.3 + 0.4 * ab
  }

  // Landing gear: mains under the fuselage retracting inward, nose gear behind the intake lip retracting aft.
  const bottom = 1.9
  for (const side of [1, -1] as const) {
    gearLeg(model, root, new Vector3(1.18 * side, -0.62, 0.6), -bottom + 0.35, 0.35, [0], 'z', -side * (Math.PI / 2) * 0.98, m)
  }
  gearLeg(model, root, new Vector3(0, -1.08, -3.4), -bottom + 0.24, 0.24, [0], 'x', -(Math.PI / 2) * 0.97, m)

  // Lights: wingtip-rail nav lights, fin-tip tail light, anti-collision beacons and a taxi/landing light.
  navLights(model, new Vector3(railX + 0.06, wingAt.y, 1.6), new Vector3(0, finTop.y - 0.1, finTop.z + 1.05), new Vector3(0, finTop.y - 0.25, finTop.z + 0.4), new Vector3(0, -0.72, 1.2), {
    landing: [new Vector3(0, -1.25, -3.25)],
  })

  // Pilot eye: high under the bubble canopy.
  model.eye.set(0, 0.8, -5.3)
  // Eyes through the HUD, the panel just in view below.
  model.cockpitLookPitch = -0.06
  model.length = 15.06
  return model
}
