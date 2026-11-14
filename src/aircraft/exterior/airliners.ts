import { BoxGeometry, Group, SphereGeometry, Vector3 } from 'three'
import { airlinerStations, tubeGeometry, wingPanelGeometry, wingPoint, type WingParams } from '../geometry'
import { createMaterials, LIVERIES, paintFuselage, paintTail } from '../materials'
import { buildWings, gearLeg, mesh, navLights, newModel, tailSurface, turbofan, type AircraftModel } from './parts'

interface AirlinerSpec {
  id: 'b737' | 'a320'
  noseZ: number
  tailZ: number
  radius: number
  noseLen: number
  tailLen: number
  blunt: number
  droop: number
  wing: WingParams
  wingAt: Vector3
  winglet: WingParams
  wingletCant: number
  engineSpan: number
  engineY: number
  engineLen: number
  engineR: number
  engineFlatten: number
  hstab: WingParams
  hstabAt: Vector3
  fin: WingParams
  finAt: Vector3
  mainGear: { x: number; z: number; wheelR: number; bottom: number }
  noseGear: { z: number; wheelR: number; bottom: number }
}

function buildAirliner(s: AirlinerSpec): AircraftModel {
  const livery = LIVERIES[s.id]
  const L = s.tailZ - s.noseZ
  const v = (z: number) => (z - s.noseZ) / L
  const fusTex = paintFuselage({
    livery,
    windowFrom: v(s.noseZ + 6.4),
    windowTo: v(s.tailZ - 9.2),
    windowCount: Math.round((L - 15.6) / 0.51),
    windowU: 0.205,
    windowSize: [0.012, 0.0085],
    cockpitV: [v(s.noseZ + 1.25), v(s.noseZ + 2.55)],
    cockpitU: [0.07, 0.2],
    doors: [v(s.noseZ + 5.4), v(s.tailZ - 8.4)],
    titleV: v(s.noseZ + 11),
  })
  const m = createMaterials(livery, fusTex, paintTail(livery))
  const model = newModel(s.id, 'airliner', m)
  const root = model.root

  const fus = mesh(
    tubeGeometry(
      airlinerStations({ noseZ: s.noseZ, tailZ: s.tailZ, radius: s.radius, noseLen: s.noseLen, tailLen: s.tailLen, noseDroop: s.droop, noseBluntness: s.blunt, upsweep: 0.6 }),
      64,
    ),
    m.fuselage,
    root,
    'fuselage',
  )
  model.exteriorOnly.push(fus)

  // Wing-to-body fairing.
  const fairing = new SphereGeometry(1, 32, 16)
  fairing.scale(s.radius * 0.98, s.radius * 0.5, s.wing.rootChord * 0.78)
  fairing.translate(0, -s.radius * 0.62, s.wingAt.z + s.wing.rootChord * 0.48)
  model.exteriorOnly.push(mesh(fairing, m.belly, root))

  buildWings(model, root, {
    params: s.wing,
    at: s.wingAt,
    flaps: [
      [0.04, 0.33],
      [0.35, 0.68],
    ],
    aileron: [0.7, 0.93],
    spoilers: [0.36, 0.67],
    mat: m.wing,
    surfaceMat: m.wingDark,
  })
  // Winglets
  for (const side of [1, -1] as const) {
    const tip = wingPoint(s.wing, 1, 0, side).add(new Vector3(s.wingAt.x * side, s.wingAt.y, s.wingAt.z))
    const g = new Group()
    g.position.copy(tip)
    g.rotation.z = -side * s.wingletCant
    root.add(g)
    mesh(wingPanelGeometry(s.winglet, 0, 1, 0, 1, side, 6, 12), m.tail, g)
  }
  model.span = 2 * (s.wingAt.x + s.wing.span)

  // Engines + pylons
  for (const side of [1, -1] as const) {
    const e = (s.engineSpan - s.wingAt.x) / s.wing.span
    const le = wingPoint(s.wing, e, 0, side).add(new Vector3(s.wingAt.x * side, s.wingAt.y, s.wingAt.z))
    const front = new Vector3(s.engineSpan * side, s.engineY, le.z - s.engineLen * 0.62)
    turbofan(model, root, front, s.engineLen, s.engineR, m, s.engineFlatten)
    const pylon = new BoxGeometry(0.28, Math.max(0.3, le.y - s.engineY - s.engineR * 0.7), s.engineLen * 0.95)
    pylon.translate(s.engineSpan * side, (le.y + s.engineY + s.engineR * 0.6) / 2, front.z + s.engineLen * 0.62)
    mesh(pylon, m.paint, root)
  }

  // Empennage
  tailSurface(model, root, s.hstab, s.hstabAt, 'elevator', m.paint, m.wingDark)
  const finGroup = new Group()
  root.add(finGroup)
  tailSurface(model, finGroup, s.fin, s.finAt, 'rudder', m.tail, m.tail)

  // Landing gear
  const mg = s.mainGear
  const pivotY = s.wingAt.y - 0.05
  for (const side of [1, -1] as const) {
    gearLeg(model, root, new Vector3(mg.x * side, pivotY, mg.z), -mg.bottom + mg.wheelR, mg.wheelR, [-0.45, 0.45].map((x) => x + 0), 'z', -side * (Math.PI / 2) * 0.98, m)
  }
  const ng = s.noseGear
  gearLeg(model, root, new Vector3(0, -s.radius * 0.72, ng.z), -ng.bottom + ng.wheelR, ng.wheelR, [-0.22, 0.22], 'x', Math.PI / 2 * 0.97, m)

  // Lights
  const tipR = model.wingTipRight.clone()
  tipR.x = s.wingAt.x + s.wing.span + 0.05
  navLights(model, tipR, new Vector3(0, s.radius * 0.35 + 0.3, s.tailZ + 0.05), new Vector3(0, s.radius + 0.06, 0), new Vector3(0, -s.radius - 0.05, 1), {
    landing: [new Vector3(s.radius + 0.25, s.wingAt.y + 0.12, s.wingAt.z + 0.45), new Vector3(-s.radius - 0.25, s.wingAt.y + 0.12, s.wingAt.z + 0.45), new Vector3(0, -s.radius * 0.95, ng.z - 0.35)],
    logo: { at: new Vector3(0, s.finAt.y + s.fin.span * 0.5, s.finAt.z + s.fin.rootChord * 0.75), reach: s.fin.span * 0.6 },
  })

  model.eye.set(-0.52, 0.78, s.noseZ + 2.95)
  model.length = L
  return model
}

const B737: AirlinerSpec = {
  id: 'b737',
  noseZ: -17.4,
  tailZ: 22.1,
  radius: 1.88,
  noseLen: 5.0,
  tailLen: 10.5,
  blunt: 0.62,
  droop: 0.3,
  wing: { span: 16.0, rootChord: 7.0, tipChord: 1.25, sweep: 29, dihedral: 6, thicknessRoot: 0.15, thicknessTip: 0.1 },
  wingAt: new Vector3(1.1, -1.2, -4.6),
  winglet: { span: 2.4, rootChord: 1.25, tipChord: 0.45, sweep: 42, dihedral: 0, thicknessRoot: 0.09, thicknessTip: 0.08, vertical: true },
  wingletCant: 0.22,
  engineSpan: 4.95,
  engineY: -2.0,
  engineLen: 4.3,
  engineR: 1.02,
  engineFlatten: 0.1,
  hstab: { span: 6.6, rootChord: 3.7, tipChord: 1.2, sweep: 35, dihedral: 7, thicknessRoot: 0.1, thicknessTip: 0.09 },
  hstabAt: new Vector3(0.5, 0.55, 15.8),
  fin: { span: 7.3, rootChord: 6.4, tipChord: 2.2, sweep: 39, dihedral: 0, thicknessRoot: 0.1, thicknessTip: 0.09, vertical: true },
  finAt: new Vector3(0, 1.5, 13.6),
  mainGear: { x: 2.86, z: 1.4, wheelR: 0.57, bottom: 3.05 },
  noseGear: { z: -14.4, wheelR: 0.35, bottom: 2.88 },
}

const A320: AirlinerSpec = {
  id: 'a320',
  noseZ: -16.4,
  tailZ: 21.2,
  radius: 1.98,
  noseLen: 4.6,
  tailLen: 10.0,
  blunt: 0.5,
  droop: 0.18,
  wing: { span: 15.9, rootChord: 7.2, tipChord: 1.5, sweep: 27.5, dihedral: 5.1, thicknessRoot: 0.15, thicknessTip: 0.1 },
  wingAt: new Vector3(1.15, -1.3, -4.3),
  winglet: { span: 2.45, rootChord: 1.5, tipChord: 0.4, sweep: 38, dihedral: 0, thicknessRoot: 0.09, thicknessTip: 0.08, vertical: true },
  wingletCant: 0.08,
  engineSpan: 5.75,
  engineY: -2.15,
  engineLen: 4.4,
  engineR: 1.1,
  engineFlatten: 0,
  hstab: { span: 6.1, rootChord: 3.9, tipChord: 1.4, sweep: 32, dihedral: 6, thicknessRoot: 0.1, thicknessTip: 0.09 },
  hstabAt: new Vector3(0.5, 0.75, 15.2),
  fin: { span: 6.9, rootChord: 6.2, tipChord: 2.4, sweep: 36, dihedral: 0, thicknessRoot: 0.1, thicknessTip: 0.09, vertical: true },
  finAt: new Vector3(0, 1.55, 13.0),
  mainGear: { x: 3.8, z: 1.5, wheelR: 0.6, bottom: 3.2 },
  noseGear: { z: -12.7, wheelR: 0.38, bottom: 3.08 },
}

export function buildA380(): AircraftModel {
  const livery = LIVERIES.a380
  const noseZ = -34.7
  const length = 72.7
  const tailZ = noseZ + length
  const radius = 3.55
  const v = (metersFromNose: number) => metersFromNose / length
  const fusTex = paintFuselage({
    livery,
    windowFrom: v(8.8), windowTo: v(59), windowCount: 85,
    windowU: 0.242, windowSize: [0.013, v(0.29)],
    doors: [8.1, 16.6, 31.4, 47.1, 59.9].map(v),
    upperDeck: {
      windowFrom: v(10.7), windowTo: v(60.5), windowCount: 79,
      windowU: 0.146, windowSize: [0.014, v(0.29)],
      doors: [10.2, 23.2, 45.7, 61.3].map(v),
    },
    cockpitV: [v(3.4), v(5.85)], cockpitU: [0.09, 0.225],
    titleV: v(18.5),
  })
  const m = createMaterials(livery, fusTex, paintTail(livery))
  const model = newModel('a380', 'airliner', m)
  const root = model.root
  const fuselage = airlinerStations({
    noseZ, tailZ, radius, noseLen: 8.9, tailLen: 16.4,
    flatten: 4.3 / radius, noseBluntness: 0.47, noseDroop: 0.33, upsweep: 0.7,
  })
  model.exteriorOnly.push(mesh(tubeGeometry(fuselage, 72, 2.16), m.fuselage, root, 'fuselage'))

  const fairing = new SphereGeometry(1, 40, 20)
  fairing.scale(4.05, 1.55, 17.4)
  fairing.translate(0, -3.08, -1.7)
  model.exteriorOnly.push(mesh(fairing, m.belly, root))

  // The inner wing carries the trailing-edge kink where the outer wing begins.
  const inner: WingParams = { span: 11.9, rootChord: 23.2, tipChord: 13.2, sweep: 38.5, dihedral: 5, thicknessRoot: 0.15, thicknessTip: 0.11 }
  const outer: WingParams = { span: 25.1, rootChord: 13.2, tipChord: 2.2, sweep: 39, dihedral: 5, thicknessRoot: 0.11, thicknessTip: 0.09 }
  const innerAt = new Vector3(2.9, -2.28, -15.6)
  const outerAt = wingPoint(inner, 1, 0).add(innerAt)
  buildWings(model, root, { params: inner, at: innerAt, flaps: [[0.08, 0.96]], spoilers: [0.28, 0.95], mat: m.wing, surfaceMat: m.wingDark })
  buildWings(model, root, { params: outer, at: outerAt, flaps: [[0.03, 0.46]], aileron: [0.49, 0.96], spoilers: [0.05, 0.49], mat: m.wing, surfaceMat: m.wingDark })
  model.span = 2 * (outerAt.x + outer.span)
  model.length = length

  const tip = wingPoint(outer, 1, 0).add(outerAt)
  const engineLength = 5.5
  const engineRadius = 1.68
  const noseGearZ = noseZ + 4.97
  const wheelCenterY = (z: number, r: number) => -6.0 + r + z * Math.tan(0.2 * Math.PI / 180)
  for (const side of [1, -1] as const) {
    // Short upper and lower wingtip fences characteristic of the A380-800.
    for (const direction of [1, -1]) {
      const fence: WingParams = { span: direction > 0 ? 1.2 : 0.65, rootChord: outer.tipChord, tipChord: 0.57, sweep: 40, dihedral: 0, thicknessRoot: 0.09, thicknessTip: 0.07, vertical: true }
      const part = mesh(wingPanelGeometry(fence, 0, 1), m.tail, root)
      part.position.copy(tip).setX(tip.x * side)
      if (direction < 0) part.rotation.z = Math.PI
    }

    for (const [x, y] of [[14.8, -2.7], [25.7, -1.7]]) {
      const e = (x - outerAt.x) / outer.span
      const leading = wingPoint(outer, e, 0).add(outerAt)
      const front = new Vector3(x * side, y, leading.z - engineLength * 0.62)
      turbofan(model, root, front, engineLength, engineRadius, m)
      const pylonAt = wingPoint(outer, e, 0.1).add(outerAt).setX(x * side)
      const pylon: WingParams = {
        span: pylonAt.y - y - engineRadius * 0.53, rootChord: 5.0, tipChord: 2.6,
        sweep: -40, dihedral: 0, thicknessRoot: 0.13, thicknessTip: 0.14, vertical: true,
      }
      const mount = mesh(wingPanelGeometry(pylon, 0, 1), m.paint, root)
      mount.position.copy(pylonAt)
      mount.rotation.z = Math.PI
    }

    // Two four-wheel wing bogies and two six-wheel body bogies.
    gearLeg(model, root, new Vector3(7.17 * side, -2.8, -1.12), wheelCenterY(-1.12, 0.68), 0.68, [-0.48, 0.48], 'z', -side * Math.PI / 2, m, [-0.78, 0.78])
    gearLeg(model, root, new Vector3(2.63 * side, -3.12, 2.15), wheelCenterY(2.15, 0.68), 0.68, [-0.48, 0.48], 'x', Math.PI / 2, m, [-1.56, 0, 1.56])
  }
  gearLeg(model, root, new Vector3(0, -2.34, noseGearZ), wheelCenterY(noseGearZ, 0.52), 0.52, [-0.35, 0.35], 'x', Math.PI / 2, m)

  const hstab: WingParams = { span: 14.4, rootChord: 10.8, tipChord: 2.65, sweep: 35, dihedral: 6, thicknessRoot: 0.11, thicknessTip: 0.085 }
  const fin: WingParams = { span: 14.4, rootChord: 15.3, tipChord: 4.25, sweep: 40, dihedral: 0, thicknessRoot: 0.10, thicknessTip: 0.08, vertical: true }
  tailSurface(model, root, hstab, new Vector3(0.8, 0.75, 24.4), 'elevator', m.paint, m.wingDark)
  tailSurface(model, root, fin, new Vector3(0, 3.7, 19.2), 'rudder', m.tail, m.tail)

  navLights(model, model.wingTipRight.clone().setX(tip.x + 0.09), new Vector3(0, 1.96, tailZ + 0.06), new Vector3(0, 4.36, -4), new Vector3(0, -4.7, 1), {
    landing: [new Vector3(4.15, -2.18, -14.8), new Vector3(-4.15, -2.18, -14.8), new Vector3(0, -3.1, noseGearZ - 0.4)],
    logo: { at: new Vector3(0, 10.5, 30.7), reach: 8.6 },
  })
  model.eye.set(-0.55, 1.75, noseZ + 6.25)
  return model
}

export function build737() {
  return buildAirliner(B737)
}

export function buildA320() {
  return buildAirliner(A320)
}
