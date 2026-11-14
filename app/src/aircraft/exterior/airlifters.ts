import { SphereGeometry, Vector3 } from 'three'
import { tubeGeometry, wingPanelGeometry, wingPoint, type Station, type WingParams } from '../geometry'
import type { LiveryId } from '../liveries'
import { aircraftLivery, createMaterials, paintFuselage, paintTail } from '../materials'
import { buildWings, gearLeg, mesh, navLights, newModel, tailSurface, turbofan } from './parts'

interface AirlifterSpec {
  id: 'c5m' | 'c17'
  stations: readonly [z: number, halfWidth: number, halfHeight: number, centerY: number][]
  span: number
  gearHeight: number
  eye: [number, number, number]
  windshield: [number, number]
  wing: WingParams
  wingAt: Vector3
  winglet?: WingParams
  fin: WingParams
  finAt: Vector3
  stabilizer: WingParams
  engineSpan: [number, number]
  engineRadius: number
  engineLength: number
  mainGear: { x: number; y: number; z: number; track: number; axles: number[] }[]
  noseGearZ: number
  noseWheels: number[]
  wheelRadius: number
  sponson: { x: number; y: number; z: number; width: number; height: number; length: number }
  noseDoorZ?: number
  rampZ: number
}

function buildAirlifter(spec: AirlifterSpec, theme?: LiveryId) {
  const { id, wing, wingAt, winglet, fin, finAt, span, sponson } = spec
  const livery = aircraftLivery(id, theme)
  const stations: Station[] = spec.stations.map(([z, hw, hh, yc]) => ({ z, hw, hh, yc }))
  const noseZ = stations[0].z
  const tailZ = stations[stations.length - 1].z
  const length = tailZ - noseZ
  const v = (z: number) => (z - noseZ) / length
  const paint = paintFuselage({
    livery,
    windowFrom: 0, windowTo: 0, windowCount: 0, windowU: 0.235, windowSize: [0, 0],
    doors: [v(spec.windshield[1] + 2.8)],
    cockpitV: [v(spec.windshield[0]), v(spec.windshield[1])], cockpitU: [0.062, 0.173],
    titleV: v(wingAt.z - length * 0.11),
    cargo: { noseDoorV: spec.noseDoorZ === undefined ? undefined : v(spec.noseDoorZ), rampV: v(spec.rampZ) },
  })
  const m = createMaterials(livery, paint, paintTail(livery))
  m.wing.color.set(livery.military ? livery.base : '#abb0b5')
  m.wingDark.color.set(livery.military ? livery.belly : '#9ca4ac')
  if (livery.military) {
    for (const mat of [m.fuselage, m.paint, m.belly, m.tail, m.wing]) {
      mat.clearcoat = 0.06
      mat.roughness = 0.58
      mat.metalness = 0.08
    }
  }

  const model = newModel(id, 'airliner', m)
  const root = model.root
  model.eye.set(...spec.eye)
  model.cockpitLookPitch = id === 'c5m' ? -0.275 : -0.23
  model.span = span
  model.length = length
  model.exteriorOnly.push(mesh(tubeGeometry(stations, 64, 2.45), m.fuselage, root, 'fuselage'))
  buildWings(model, root, {
    params: wing, at: wingAt, flaps: [[0.035, 0.36], [0.38, 0.67]],
    aileron: [0.69, 0.96], spoilers: [0.30, 0.66], hingeChord: 0.69,
    mat: m.wing, surfaceMat: m.wingDark,
  })

  const tip = wingPoint(wing, 1, 0).add(wingAt)
  const finTop = wingPoint(fin, 1, 0).add(finAt)
  tailSurface(model, root, fin, finAt, 'rudder', m.tail, m.tail)
  // The horizontal stabilizer sits across the top of the swept vertical fin.
  tailSurface(model, root, spec.stabilizer, finTop.clone().add(new Vector3(0, -0.18, 0.4)), 'elevator', m.wing, m.wingDark)

  for (const side of [1, -1] as const) {
    if (winglet) {
      const tipMesh = mesh(wingPanelGeometry(winglet, 0, 1, 0, 1, side, 5, 12), m.wing, root)
      tipMesh.position.copy(tip).setX(tip.x * side)
    }
    const pod = new SphereGeometry(1, 28, 16)
    pod.scale(sponson.width, sponson.height, sponson.length / 2)
    pod.translate(sponson.x * side, sponson.y, sponson.z)
    mesh(pod, m.belly, root, 'main gear sponson')

    for (const x of spec.engineSpan) {
      const e = (x - wingAt.x) / wing.span
      const mountAt = wingPoint(wing, e, 0.12).add(wingAt).setX(x * side)
      const front = mountAt.clone().add(new Vector3(0, -spec.engineRadius - 1.4, -spec.engineLength * 0.73))
      turbofan(model, root, front, spec.engineLength, spec.engineRadius, m)
      const pylon: WingParams = {
        span: 1.85, rootChord: spec.engineLength * 0.95, tipChord: spec.engineLength * 0.52,
        sweep: -45, dihedral: 0, thicknessRoot: 0.14, thicknessTip: 0.12, vertical: true,
      }
      const mount = mesh(wingPanelGeometry(pylon, 0, 1), m.paint, root)
      mount.position.copy(mountAt)
      mount.rotation.z = Math.PI
    }

    for (const gear of spec.mainGear) {
      gearLeg(model, root, new Vector3(gear.x * side, gear.y, gear.z),
        -spec.gearHeight + spec.wheelRadius, spec.wheelRadius, [-gear.track, gear.track], 'x', Math.PI / 2, m, gear.axles)
    }
  }

  const noseRadius = spec.wheelRadius * 0.79
  gearLeg(model, root, new Vector3(0, -2.35, spec.noseGearZ),
    -spec.gearHeight + noseRadius, noseRadius, spec.noseWheels, 'x', Math.PI / 2, m)
  const lampAt = winglet
    ? wingPoint(winglet, 1, 0.35).add(tip)
    : model.wingTipRight
  navLights(model, lampAt, finTop.clone().add(new Vector3(0, 0.12, fin.tipChord)),
    new Vector3(0, wingAt.y + 1.1, 0), new Vector3(0, -3.6, -1), {
      landing: [new Vector3(wingAt.x + 0.5, wingAt.y, wingAt.z), new Vector3(-wingAt.x - 0.5, wingAt.y, wingAt.z)],
    })
  return model
}

const C5M: AirlifterSpec = {
  id: 'c5m',
  stations: [
    [-35.4, 0.01, 0.01, 0.2], [-35.15, 0.91, 1.08, 0.32], [-34.2, 1.94, 2.05, 0.43],
    [-32.8, 2.56, 2.7, 0.64], [-31.2, 2.94, 3.17, 0.69], [-29.4, 3.24, 3.56, 0.61],
    [-27.5, 3.44, 3.84, 0.44], [-25.3, 3.58, 4.02, 0.38], [-20, 3.67, 4.02, 0.38],
    [-8, 3.67, 4.02, 0.38], [6, 3.67, 4.02, 0.38], [17, 3.65, 3.98, 0.37],
    [23, 3.53, 3.72, 0.64], [28, 3.17, 2.97, 1.29], [32, 2.53, 2.19, 1.71],
    [36, 1.62, 1.47, 2.04], [39, 0.79, 0.79, 2.19], [40.13, 0.02, 0.02, 2.30],
  ],
  span: 67.9, gearHeight: 5.2, eye: [-0.65, 3.25, -29.8], windshield: [-33.6, -30.6],
  wing: { span: 31.1, rootChord: 15.7, tipChord: 3.1, sweep: 35, dihedral: -1.5, thicknessRoot: 0.14, thicknessTip: 0.09 },
  wingAt: new Vector3(2.85, 3.03, -12.25),
  fin: { span: 11.25, rootChord: 17.0, tipChord: 5.9, sweep: 42, dihedral: 0, thicknessRoot: 0.09, thicknessTip: 0.085, vertical: true },
  finAt: new Vector3(0, 3.35, 19.1),
  stabilizer: { span: 10.48, rootChord: 8.0, tipChord: 2.5, sweep: 33, dihedral: 0.5, thicknessRoot: 0.11, thicknessTip: 0.08 },
  engineSpan: [11.5, 21.2], engineRadius: 1.51, engineLength: 5.4,
  mainGear: [
    { x: 3.75, y: -2.65, z: 0.5, track: 0.47, axles: [-0.85, 0, 0.85] },
    { x: 3.75, y: -2.65, z: 4.4, track: 0.47, axles: [-0.85, 0, 0.85] },
  ],
  noseGearZ: -21.05, noseWheels: [-0.82, -0.27, 0.27, 0.82], wheelRadius: 0.60,
  sponson: { x: 3.16, y: -2.26, z: 2.7, width: 1.48, height: 1.29, length: 23.2 },
  noseDoorZ: -28.3, rampZ: 22.5,
}

const C17: AirlifterSpec = {
  id: 'c17',
  stations: [
    [-25.8, 0.02, 0.02, -0.44], [-25.65, 0.85, 0.83, -0.38], [-24.9, 1.82, 1.56, -0.20],
    [-23.9, 2.47, 2.22, -0.02], [-22.6, 2.87, 2.73, 0.15], [-21, 3.23, 3.12, 0.15],
    [-18.8, 3.42, 3.50, 0.25], [-15, 3.45, 3.50, 0.25], [-5, 3.45, 3.50, 0.25],
    [5, 3.45, 3.50, 0.25], [11, 3.43, 3.45, 0.30], [15, 3.32, 3.07, 0.69],
    [18, 3.15, 2.54, 1.08], [21, 2.71, 1.87, 1.49], [24, 1.79, 1.15, 1.85],
    [26.1, 0.88, 0.59, 1.99], [27.2, 0.02, 0.02, 2.05],
  ],
  span: 51.8, gearHeight: 4.65, eye: [-0.63, 2.80, -20.7], windshield: [-23.7, -21.4],
  wing: { span: 23.04, rootChord: 12.7, tipChord: 2.1, sweep: 34, dihedral: 1.5, thicknessRoot: 0.135, thicknessTip: 0.09 },
  wingAt: new Vector3(2.60, 2.83, -10.5),
  winglet: { span: 2, rootChord: 2.1, tipChord: 0.57, sweep: 31, dihedral: 7.4, thicknessRoot: 0.09, thicknessTip: 0.08, vertical: true },
  fin: { span: 9.1, rootChord: 11.4, tipChord: 4.1, sweep: 34, dihedral: 0, thicknessRoot: 0.10, thicknessTip: 0.085, vertical: true },
  finAt: new Vector3(0, 3.16, 12.4),
  stabilizer: { span: 9.5, rootChord: 6.8, tipChord: 1.9, sweep: 32, dihedral: -1.5, thicknessRoot: 0.10, thicknessTip: 0.075 },
  engineSpan: [8.2, 15.6], engineRadius: 1.39, engineLength: 4.45,
  mainGear: [{ x: 3.57, y: -2.45, z: 1.35, track: 0.49, axles: [-1.35, 0, 1.35] }],
  noseGearZ: -18.25, noseWheels: [-0.32, 0.32], wheelRadius: 0.59,
  sponson: { x: 2.96, y: -2, z: 1.1, width: 1.59, height: 1.22, length: 17.3 },
  rampZ: 12.4,
}

export function buildC5M(theme?: LiveryId) {
  return buildAirlifter(C5M, theme)
}

export function buildC17(theme?: LiveryId) {
  return buildAirlifter(C17, theme)
}
