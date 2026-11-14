import { BoxGeometry, Group, SphereGeometry, Vector3 } from 'three'
import { airlinerStations, tubeGeometry, wingPanelGeometry, wingPoint, type WingParams } from '../geometry'
import { createMaterials, LIVERIES, paintFuselage, paintTail } from '../materials'
import { buildWings, gearLeg, mesh, navLights, newModel, tailSurface, turbofan, type AircraftModel } from './parts'

export function buildBizjet(): AircraftModel {
  const livery = LIVERIES.bizjet
  const noseZ = -9.7
  const tailZ = 11.3
  const R = 1.12
  const L = tailZ - noseZ
  const v = (z: number) => (z - noseZ) / L
  const fusTex = paintFuselage({
    livery,
    windowFrom: v(noseZ + 4.4),
    windowTo: v(noseZ + 11.2),
    windowCount: 7,
    windowU: 0.215,
    windowSize: [0.03, 0.032],
    cockpitV: [v(noseZ + 0.95), v(noseZ + 2.1)],
    cockpitU: [0.08, 0.21],
    doors: [v(noseZ + 3.3)],
    titleV: v(noseZ + 13.6),
  })
  const m = createMaterials(livery, fusTex, paintTail(livery))
  const model = newModel('bizjet', 'bizjet', m)
  const root = model.root
  const fus = mesh(
    tubeGeometry(airlinerStations({ noseZ, tailZ, radius: R, noseLen: 3.5, tailLen: 7.2, noseDroop: 0.15, noseBluntness: 0.72, upsweep: 0.35, tailEndRadius: 0.1 }), 56),
    m.fuselage,
    root,
    'fuselage',
  )
  model.exteriorOnly.push(fus)
  const wing: WingParams = { span: 9.6, rootChord: 3.9, tipChord: 1.15, sweep: 30, dihedral: 3, thicknessRoot: 0.14, thicknessTip: 0.1 }
  const wingAt = new Vector3(0.6, -0.72, -2.6)
  const fairing = new SphereGeometry(1, 28, 14)
  fairing.scale(R * 0.9, R * 0.42, wing.rootChord * 0.75)
  fairing.translate(0, -R * 0.62, wingAt.z + wing.rootChord * 0.5)
  model.exteriorOnly.push(mesh(fairing, m.belly, root))
  buildWings(model, root, { params: wing, at: wingAt, flaps: [[0.05, 0.62]], aileron: [0.64, 0.94], spoilers: [0.2, 0.6], mat: m.wing, surfaceMat: m.wingDark })
  const winglet: WingParams = { span: 1.25, rootChord: 1.15, tipChord: 0.45, sweep: 45, dihedral: 0, thicknessRoot: 0.09, thicknessTip: 0.08, vertical: true }
  for (const side of [1, -1] as const) {
    const g = new Group()
    g.position.copy(wingPoint(wing, 1, 0, side).add(new Vector3(wingAt.x * side, wingAt.y, wingAt.z)))
    g.rotation.z = -side * 0.12
    root.add(g)
    mesh(wingPanelGeometry(winglet, 0, 1, 0, 1, side, 4, 10), m.paint, g)
  }
  model.span = 2 * (wingAt.x + wing.span)
  // Rear engines on stub pylons.
  for (const side of [1, -1] as const) {
    turbofan(model, root, new Vector3(1.85 * side, 0.55, 4.4), 3.2, 0.63, m)
    const pylon = new BoxGeometry(0.75, 0.22, 1.6)
    pylon.translate(1.05 * side, 0.55, 6.1)
    mesh(pylon, m.paint, root)
  }
  // T-tail: fin with the stabilizer on top.
  const fin: WingParams = { span: 3.7, rootChord: 3.9, tipChord: 2.3, sweep: 46, dihedral: 0, thicknessRoot: 0.11, thicknessTip: 0.1, vertical: true }
  const finAt = new Vector3(0, 0.75, 6.9)
  tailSurface(model, root, fin, finAt, 'rudder', m.tail, m.tail, 0.72)
  const finTop = wingPoint(fin, 1, 0, 1).add(finAt)
  const hstab: WingParams = { span: 3.55, rootChord: 2.05, tipChord: 0.95, sweep: 32, dihedral: -2, thicknessRoot: 0.1, thicknessTip: 0.09 }
  tailSurface(model, root, hstab, finTop.clone().add(new Vector3(0, -0.05, 0.1)), 'elevator', m.paint, m.wingDark)
  // Gear
  for (const side of [1, -1] as const) {
    gearLeg(model, root, new Vector3(1.6 * side, -0.68, 0.7), -1.55 + 0.34, 0.34, [0], 'z', -side * Math.PI / 2 * 0.98, m)
  }
  gearLeg(model, root, new Vector3(0, -R * 0.7, -7.4), -1.47 + 0.23, 0.23, [-0.12, 0.12], 'x', Math.PI / 2 * 0.97, m)
  const tipR = model.wingTipRight.clone()
  tipR.x = wingAt.x + wing.span + 0.05
  navLights(model, tipR, finTop.clone().add(new Vector3(0, 0.1, 2.3)), new Vector3(0, R + 0.05, 1), new Vector3(0, -R - 0.03, 0.5), {
    landing: [new Vector3(R + 0.12, wingAt.y + 0.08, wingAt.z + 0.3), new Vector3(-R - 0.12, wingAt.y + 0.08, wingAt.z + 0.3)],
    logo: { at: new Vector3(0, finAt.y + fin.span * 0.5, finAt.z + fin.rootChord * 0.75), reach: fin.span * 0.6 },
  })
  model.eye.set(-0.42, 0.42, noseZ + 2.45)
  model.length = L
  return model
}

// ---------------------------------------------------------------------------
// Longitude-style super-midsize business jet: long cabin, high-aspect swept
// wing with tall canted winglets, big aft-mounted turbofans on airfoil pylons,
// swept T-tail and twin-wheel main gear. Overall ~22.3 m long, ~21 m span.
// ---------------------------------------------------------------------------

export function buildLongitude(): AircraftModel {
  const livery = LIVERIES.longitude
  const noseZ = -10.4
  const tailZ = 10.7
  const R = 1.1
  const L = tailZ - noseZ
  const v = (z: number) => (z - noseZ) / L
  const fusTex = paintFuselage({
    livery,
    windowFrom: v(noseZ + 4.7),
    windowTo: v(noseZ + 12.9),
    windowCount: 8,
    windowU: 0.212,
    windowSize: [0.03, 0.03],
    cockpitV: [v(noseZ + 1.0), v(noseZ + 2.25)],
    cockpitU: [0.08, 0.21],
    doors: [v(noseZ + 3.5)],
    titleV: v(noseZ + 14.6),
  })
  const m = createMaterials(livery, fusTex, paintTail(livery))
  const model = newModel('longitude', 'bizjet', m)
  const root = model.root
  const fus = mesh(
    tubeGeometry(airlinerStations({ noseZ, tailZ, radius: R, noseLen: 3.9, tailLen: 7.4, noseDroop: 0.2, noseBluntness: 0.68, upsweep: 0.38, tailEndRadius: 0.12 }), 64),
    m.fuselage,
    root,
    'fuselage',
  )
  model.exteriorOnly.push(fus)

  // Wing: slender and moderately swept, mounted low under the cabin floor.
  const wing: WingParams = { span: 9.5, rootChord: 4.05, tipChord: 1.15, sweep: 31, dihedral: 3.5, thicknessRoot: 0.13, thicknessTip: 0.1 }
  const wingAt = new Vector3(0.6, -0.74, -2.9)
  const fairing = new SphereGeometry(1, 32, 16)
  fairing.scale(R * 0.92, R * 0.4, wing.rootChord * 0.82)
  fairing.translate(0, -R * 0.64, wingAt.z + wing.rootChord * 0.52)
  model.exteriorOnly.push(mesh(fairing, m.belly, root))
  buildWings(model, root, {
    params: wing,
    at: wingAt,
    flaps: [
      [0.05, 0.36],
      [0.38, 0.66],
    ],
    aileron: [0.68, 0.95],
    spoilers: [0.22, 0.64],
    mat: m.wing,
    surfaceMat: m.wingDark,
  })
  // Tall, raked winglets blended outward.
  const winglet: WingParams = { span: 1.45, rootChord: 1.15, tipChord: 0.38, sweep: 50, dihedral: 0, thicknessRoot: 0.09, thicknessTip: 0.08, vertical: true }
  const wingletCant = 0.3
  for (const side of [1, -1] as const) {
    const g = new Group()
    g.position.copy(wingPoint(wing, 1, 0, side).add(new Vector3(wingAt.x * side, wingAt.y, wingAt.z)))
    g.rotation.z = -side * wingletCant
    root.add(g)
    mesh(wingPanelGeometry(winglet, 0, 1, 0, 1, side, 5, 12), m.paint, g)
  }
  model.span = 2 * (wingAt.x + wing.span + Math.sin(wingletCant) * winglet.span)

  // Aft-mounted turbofans on short airfoil-section pylons.
  const engX = 2.02
  const engY = 0.6
  const engLen = 3.5
  const engR = 0.72
  const pylon: WingParams = { span: 0.85, rootChord: 2.3, tipChord: 1.9, sweep: 12, dihedral: 4, thicknessRoot: 0.11, thicknessTip: 0.11 }
  for (const side of [1, -1] as const) {
    turbofan(model, root, new Vector3(engX * side, engY, 3.6), engLen, engR, m)
    const g = new Group()
    g.position.set(0.62 * side, engY - 0.08, 4.25)
    root.add(g)
    mesh(wingPanelGeometry(pylon, 0, 1, 0, 1, side, 2, 12), m.paint, g)
  }

  // Swept T-tail with a dorsal fillet ahead of the fin.
  const fin: WingParams = { span: 3.6, rootChord: 4.2, tipChord: 2.4, sweep: 40, dihedral: 0, thicknessRoot: 0.11, thicknessTip: 0.1, vertical: true }
  const finAt = new Vector3(0, 0.72, 5.6)
  tailSurface(model, root, fin, finAt, 'rudder', m.tail, m.tail, 0.72)
  const dorsal: WingParams = { span: 0.7, rootChord: 3.2, tipChord: 0.5, sweep: 74, dihedral: 0, thicknessRoot: 0.06, thicknessTip: 0.1, vertical: true }
  const dg = new Group()
  dg.position.set(0, finAt.y + 0.12, finAt.z - 2.3)
  root.add(dg)
  mesh(wingPanelGeometry(dorsal, 0, 1, 0, 1, 1, 3, 10), m.paint, dg)
  const finTop = wingPoint(fin, 1, 0, 1).add(finAt)
  const hstab: WingParams = { span: 3.7, rootChord: 2.1, tipChord: 0.95, sweep: 30, dihedral: -1.5, thicknessRoot: 0.1, thicknessTip: 0.09 }
  tailSurface(model, root, hstab, finTop.clone().add(new Vector3(0, -0.04, 0.08)), 'elevator', m.paint, m.wingDark)
  // Bullet fairing at the fin/stabilizer junction.
  const bullet = new SphereGeometry(1, 20, 12)
  bullet.scale(0.2, 0.17, 1.75)
  bullet.translate(0, finTop.y - 0.02, finTop.z + 1.1)
  mesh(bullet, m.paint, root)

  // Gear: twin-wheel mains retracting inboard, twin nose wheels retracting forward.
  const bottom = 1.65
  for (const side of [1, -1] as const) {
    gearLeg(model, root, new Vector3(1.7 * side, -0.7, 0.9), -bottom + 0.36, 0.36, [-0.17, 0.17], 'z', -side * (Math.PI / 2) * 0.98, m)
  }
  gearLeg(model, root, new Vector3(0, -R * 0.7, -8.3), -bottom + 0.08 + 0.24, 0.24, [-0.13, 0.13], 'x', (Math.PI / 2) * 0.97, m)

  const tipR = model.wingTipRight.clone()
  tipR.x = wingAt.x + wing.span + 0.05
  navLights(model, tipR, new Vector3(0, finTop.y + 0.05, finTop.z + 2.9), new Vector3(0, R + 0.05, 0.5), new Vector3(0, -R - 0.03, 0.8), {
    landing: [new Vector3(R + 0.12, wingAt.y + 0.08, wingAt.z + 0.3), new Vector3(-R - 0.12, wingAt.y + 0.08, wingAt.z + 0.3)],
    logo: { at: new Vector3(0, finAt.y + fin.span * 0.5, finAt.z + fin.rootChord * 0.75), reach: fin.span * 0.6 },
  })
  model.eye.set(-0.42, 0.42, noseZ + 2.65)
  model.length = finTop.z + wingPoint(hstab, 1, 1, 1).z + 0.08 - noseZ
  return model
}
