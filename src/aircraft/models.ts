// Procedural exterior models for each aircraft. Every model is built around
// the simulation's reference point (centre of gravity) with x right, y up and
// the nose toward -z. Moving parts are exposed for animation.

import {
  AdditiveBlending,
  BoxGeometry,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Quaternion as Quat,
  PointLight,
  SphereGeometry,
  Texture,
  Vector3,
  type BufferGeometry,
  type Material,
  type Quaternion,
} from 'three'
import {
  airlinerStations,
  hingeFrame,
  revolveZ,
  toHingeLocal,
  tubeGeometry,
  wingPanelGeometry,
  wingPoint,
  wingUpperPoint,
  type Station,
  type WingParams,
} from './geometry'
import { createMaterials, LIVERIES, paintFighter, paintFighterTail, paintFuselage, paintTail, type AircraftMaterials } from './materials'

export type SurfaceKind = 'aileron' | 'elevator' | 'rudder' | 'flap' | 'spoiler'

export interface ControlSurface {
  pivot: Object3D
  restQuaternion: Quaternion
  kind: SurfaceKind
  /** Rotation (rad) at full deflection / extension. */
  max: number
  /** Sign multiplier (e.g. left vs right aileron). */
  sign: number
}

export interface GearLeg {
  pivot: Object3D
  axis: 'x' | 'z'
  retracted: number
}

export interface Spinner {
  obj: Object3D
  /** Rotation speed (rad/s) at full power; idle is a fraction of this. */
  speed: number
  /** Blades hidden and disc shown above this engine fraction (propellers). */
  blurAbove?: number
  blades?: Object3D
  disc?: Mesh
}

export type LampKind = 'navRed' | 'navGreen' | 'navWhite' | 'strobe' | 'beacon' | 'landing'

/** A lamp on the airframe, drawn as a glow at night. */
export interface ModelLamp {
  kind: LampKind
  /** Position in model space. */
  at: Vector3
}

export interface AircraftModel {
  id: string
  root: Group
  surfaces: ControlSurface[]
  gear: GearLeg[]
  spinners: Spinner[]
  strobes: Mesh[]
  beacons: Mesh[]
  lamps: ModelLamp[]
  /** Lights washing the fin at night (off by default). */
  logoLights: PointLight[]
  /** Hidden in the cockpit view (fuselage shell etc). */
  exteriorOnly: Object3D[]
  eye: Vector3
  cockpit: 'airliner' | 'bizjet' | 'ga' | 'fighter'
  /** Default cockpit look angle (rad, negative = down); -0.2 when unset. */
  cockpitLookPitch?: number
  /** Animates the engine exhaust (nozzle glow, afterburner plume), if any. */
  exhaust?: (engine: number, afterburner: number, time: number) => void
  wingTipRight: Vector3
  span: number
  length: number
  materials: AircraftMaterials
}

function mesh(geo: BufferGeometry, mat: Material, parent: Object3D, name?: string) {
  const m = new Mesh(geo, mat)
  m.castShadow = true
  m.receiveShadow = true
  if (name) m.name = name
  parent.add(m)
  return m
}

interface WingBuild {
  params: WingParams
  /** Root leading edge position in model space. */
  at: Vector3
  /** Spanwise layout of the trailing-edge devices (fractions of span). */
  flaps?: [number, number][]
  aileron?: [number, number]
  spoilers?: [number, number]
  hingeChord?: number
  mat: Material
  surfaceMat: Material
}

/** Builds a mirrored wing pair with flaps, ailerons and spoilers. */
function buildWings(model: AircraftModel, parent: Object3D, b: WingBuild) {
  const hc = b.hingeChord ?? 0.74
  for (const side of [1, -1] as const) {
    const g = new Group()
    g.position.copy(b.at).setX(b.at.x * side)
    parent.add(g)
    // Fixed wing box (leading edge to hinge line) and fixed trailing edge pieces.
    mesh(wingPanelGeometry(b.params, 0, 1, 0, hc, side, 14, 20), b.mat, g)
    const devices: [number, number][] = [...(b.flaps ?? []), ...(b.aileron ? [b.aileron] : [])].sort((x, y) => x[0] - y[0])
    let cursor = 0
    for (const [e0, e1] of devices) {
      if (e0 > cursor + 0.005) mesh(wingPanelGeometry(b.params, cursor, e0, hc, 1, side, 2, 6), b.mat, g)
      cursor = e1
    }
    if (cursor < 0.999) mesh(wingPanelGeometry(b.params, cursor, 1, hc, 1, side, 3, 6), b.mat, g)
    // Movable surfaces.
    const addSurface = (e0: number, e1: number, c0: number, c1: number, kind: SurfaceKind, max: number, sign: number, mat: Material) => {
      const h = hingeFrame(b.params, e0, e1, c0, side)
      const pivot = new Object3D()
      pivot.position.copy(h.origin)
      pivot.quaternion.copy(h.quat)
      g.add(pivot)
      const geo = toHingeLocal(wingPanelGeometry(b.params, e0, e1, c0, c1, side, 4, 8), h.origin, h.quat)
      mesh(geo, mat, pivot)
      model.surfaces.push({ pivot, restQuaternion: h.quat.clone(), kind, max, sign })
    }
    for (const [e0, e1] of b.flaps ?? []) addSurface(e0, e1, hc, 1, 'flap', 0.65, side, b.surfaceMat)
    if (b.aileron) addSurface(b.aileron[0], b.aileron[1], hc, 1, 'aileron', 0.35, side, b.surfaceMat)
    if (b.spoilers) {
      // Thin panels on the upper surface just ahead of the flaps, hinged at their leading edge.
      const [e0, e1] = b.spoilers
      const h = hingeFrame(b.params, e0, e1, hc - 0.16, side, true)
      const pivot = new Object3D()
      pivot.position.copy(h.origin)
      pivot.quaternion.copy(h.quat)
      g.add(pivot)
      const sp: WingParams = { ...b.params, thicknessRoot: b.params.thicknessRoot * 0.25, thicknessTip: b.params.thicknessTip * 0.25 }
      const geo = wingPanelGeometry(sp, e0, e1, hc - 0.16, hc - 0.01, side, 3, 4)
      // Follow the tapered skin rather than floating every panel at root-wing
      // height. Keep a small physical gap so the stowed panel cannot z-fight.
      const positions = geo.getAttribute('position')
      const uv = geo.getAttribute('uv')
      for (let i = 0; i < positions.count; i++) {
        const e = uv.getY(i)
        const c = uv.getX(i)
        const mean = wingPoint(sp, e, c, side).y
        const upper = wingUpperPoint(b.params, e, c, side).y
        positions.setY(i, upper + 0.015 + (positions.getY(i) - mean) * 0.04)
      }
      geo.computeVertexNormals()
      toHingeLocal(geo, h.origin, h.quat)
      mesh(geo, b.surfaceMat, pivot)
      model.surfaces.push({ pivot, restQuaternion: h.quat.clone(), kind: 'spoiler', max: -0.9, sign: side })
    }
    if (side === 1) model.wingTipRight = wingPoint(b.params, 1, 0.5, 1).add(g.position)
  }
}

function tailSurface(model: AircraftModel, parent: Object3D, params: WingParams, at: Vector3, kind: 'elevator' | 'rudder', mat: Material, surfMat: Material, hc = 0.7) {
  const sides: (1 | -1)[] = params.vertical ? [1] : [1, -1]
  for (const side of sides) {
    const g = new Group()
    g.position.copy(at).setX(params.vertical ? at.x : at.x * side)
    parent.add(g)
    mesh(wingPanelGeometry(params, 0, 1, 0, hc, side, 8, 16), mat, g)
    const h = hingeFrame(params, 0.04, 0.97, hc, side)
    const pivot = new Object3D()
    pivot.position.copy(h.origin)
    pivot.quaternion.copy(h.quat)
    g.add(pivot)
    mesh(toHingeLocal(wingPanelGeometry(params, 0.04, 0.97, hc, 1, side, 6, 6), h.origin, h.quat), surfMat, pivot)
    if (params.vertical) mesh(wingPanelGeometry(params, 0.97, 1, hc, 1, side, 1, 4), mat, g)
    model.surfaces.push({ pivot, restQuaternion: h.quat.clone(), kind, max: kind === 'rudder' ? 0.4 : 0.35, sign: side })
  }
}

/** Turbofan nacelle with spinning fan, mounted with its inlet at `front`. */
function turbofan(model: AircraftModel, parent: Object3D, front: Vector3, length: number, radius: number, m: AircraftMaterials, flattenBottom = 0) {
  const g = new Group()
  g.position.copy(front)
  parent.add(g)
  const R = radius
  // Outer cowling (profile: radius, z) revolved; lathe z maps to -z so use negative z for aft.
  const outer: [number, number][] = [
    [R * 0.86, 0],
    [R * 0.95, -0.05 * length],
    [R * 1.0, -0.22 * length],
    [R * 0.98, -0.55 * length],
    [R * 0.86, -0.8 * length],
    [R * 0.7, -0.92 * length],
    [R * 0.62, -length],
  ]
  const cowl = revolveZ(outer, 48)
  cowl.scale(1, 1, -1)
  const inner: [number, number][] = [
    [R * 0.84, -0.02 * length],
    [R * 0.8, -0.18 * length],
  ]
  const lip = revolveZ([[R * 0.86, 0], [R * 0.83, -0.015 * length], ...inner], 48)
  lip.scale(1, 1, -1)
  const cowlMesh = mesh(cowl, m.paint, g)
  mesh(lip, m.chrome, g)
  if (flattenBottom > 0) {
    cowlMesh.scale.set(1, 1 - flattenBottom, 1)
    cowlMesh.position.y = R * flattenBottom * 0.5
  }
  // Inner duct.
  const duct = new CylinderGeometry(R * 0.8, R * 0.8, length * 0.5, 40, 1, true)
  duct.rotateX(Math.PI / 2)
  duct.translate(0, 0, length * 0.27)
  mesh(duct, m.darkMetal, g)
  // Fan with blades and spinner.
  const fan = new Group()
  fan.position.z = length * 0.17
  g.add(fan)
  const hub = new SphereGeometry(R * 0.28, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2)
  hub.rotateX(-Math.PI / 2)
  hub.scale(1, 1, 1.6)
  mesh(hub, m.darkMetal, fan)
  for (let i = 0; i < 22; i++) {
    const blade = new BoxGeometry(R * 0.05, R * 0.55, R * 0.16)
    blade.translate(0, R * 0.52, 0)
    blade.rotateY(0.45)
    blade.rotateZ((i / 22) * Math.PI * 2)
    mesh(blade, m.fan, fan)
  }
  model.spinners.push({ obj: fan, speed: 38 })
  // Exhaust core and plug.
  const plug = revolveZ([[R * 0.5, 0], [R * 0.45, -0.3 * length], [R * 0.05, -0.55 * length]], 32)
  plug.scale(1, 1, -1)
  plug.translate(0, 0, length * 0.85)
  mesh(plug, m.darkMetal, g)
  const nozzle = new CylinderGeometry(R * 0.6, R * 0.55, length * 0.12, 40, 1, true)
  nozzle.rotateX(Math.PI / 2)
  nozzle.translate(0, 0, length * 1.02)
  mesh(nozzle, m.metal, g)
  return g
}

function wheel(radius: number, width: number, m: AircraftMaterials) {
  const g = new Group()
  const tire = new CylinderGeometry(radius, radius, width, 28)
  tire.rotateZ(Math.PI / 2)
  mesh(tire, m.tire, g)
  const hub = new CylinderGeometry(radius * 0.55, radius * 0.55, width * 1.04, 20)
  hub.rotateZ(Math.PI / 2)
  mesh(hub, m.metal, g)
  return g
}

/** A retractable gear leg: strut from a pivot down to a wheel set. */
function gearLeg(
  model: AircraftModel,
  parent: Object3D,
  pivotPos: Vector3,
  wheelCenterY: number,
  wheelR: number,
  wheels: number[],
  axis: 'x' | 'z',
  retracted: number,
  m: AircraftMaterials,
  axles: readonly number[] = [0],
) {
  const pivot = new Object3D()
  pivot.position.copy(pivotPos)
  parent.add(pivot)
  const len = pivotPos.y - wheelCenterY
  const strut = new CylinderGeometry(wheelR * 0.18, wheelR * 0.22, len, 12)
  strut.translate(0, -len / 2, 0)
  mesh(strut, m.chrome, pivot)
  if (axles.length > 1) {
    const bogie = new BoxGeometry(wheelR * 0.42, wheelR * 0.4, axles[axles.length - 1] - axles[0] + wheelR * 0.4)
    bogie.translate(0, -len, (axles[0] + axles[axles.length - 1]) / 2)
    mesh(bogie, m.darkMetal, pivot)
  }
  for (const z of axles) {
    const axle = new CylinderGeometry(wheelR * 0.12, wheelR * 0.12, Math.max(0.1, Math.abs(wheels[wheels.length - 1] - wheels[0]) + wheelR * 0.6), 8)
    axle.rotateZ(Math.PI / 2)
    axle.translate((wheels[0] + wheels[wheels.length - 1]) / 2, -len, z)
    mesh(axle, m.darkMetal, pivot)
    for (const x of wheels) {
      const w = wheel(wheelR, wheelR * 0.62, m)
      w.position.set(x, -len, z)
      pivot.add(w)
    }
  }
  // Gear door
  const door = new BoxGeometry(0.04, len * 0.8, wheelR * 1.4)
  door.translate(wheels[0] < 0 ? -wheelR * 0.9 : wheelR * 0.9, -len * 0.45, 0)
  mesh(door, m.paint, pivot)
  model.gear.push({ pivot, axis, retracted })
}

function navLights(model: AircraftModel, tipR: Vector3, tail: Vector3, top: Vector3, bottom: Vector3, extra: { landing?: Vector3[]; logo?: { at: Vector3; reach: number } } = {}) {
  const dot = (r: number) => new SphereGeometry(r, 10, 8)
  const m = model.materials
  const tipL = tipR.clone().setX(-tipR.x)
  const red = new Mesh(dot(0.09), m.navRed)
  red.position.copy(tipL)
  const green = new Mesh(dot(0.09), m.navGreen)
  green.position.copy(tipR)
  const white = new Mesh(dot(0.08), m.navWhite)
  white.position.copy(tail)
  model.root.add(red, green, white)
  model.lamps.push({ kind: 'navRed', at: tipL.clone() }, { kind: 'navGreen', at: tipR.clone() }, { kind: 'navWhite', at: tail.clone() })
  for (const p of [tipR.clone(), tipL.clone(), tail.clone()]) {
    const s = new Mesh(dot(0.14), m.strobe)
    s.position.copy(p).add(new Vector3(0, 0, 0.12))
    s.visible = false
    model.root.add(s)
    model.strobes.push(s)
    model.lamps.push({ kind: 'strobe', at: s.position.clone() })
  }
  for (const p of [top, bottom]) {
    const b = new Mesh(dot(0.12), m.navRed)
    b.position.copy(p)
    b.visible = false
    model.root.add(b)
    model.beacons.push(b)
    model.lamps.push({ kind: 'beacon', at: p.clone() })
  }
  for (const p of extra.landing ?? []) {
    const lens = new Mesh(dot(0.1), m.navWhite)
    lens.position.copy(p)
    lens.scale.set(1, 1, 0.5)
    model.root.add(lens)
    model.lamps.push({ kind: 'landing', at: p.clone() })
  }
  if (extra.logo) {
    // One lamp either side, low and outboard, washing the fin like stabilizer-mounted logo lights.
    for (const side of [1, -1]) {
      const light = new PointLight('#fff1dc', 0, extra.logo.reach * 2.2, 2)
      light.position.copy(extra.logo.at).add(new Vector3(side * extra.logo.reach * 0.75, -extra.logo.reach * 0.45, -extra.logo.reach * 0.1))
      model.root.add(light)
      model.logoLights.push(light)
    }
  }
}

function newModel(id: string, cockpit: AircraftModel['cockpit'], m: AircraftMaterials): AircraftModel {
  return {
    id,
    root: new Group(),
    surfaces: [],
    gear: [],
    spinners: [],
    strobes: [],
    beacons: [],
    lamps: [],
    logoLights: [],
    exteriorOnly: [],
    eye: new Vector3(),
    cockpit,
    wingTipRight: new Vector3(),
    span: 0,
    length: 0,
    materials: m,
  }
}

// ---------------------------------------------------------------------------
// Narrow-body airliners (737-style and A320-style)
// ---------------------------------------------------------------------------

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

function buildA380(): AircraftModel {
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

// ---------------------------------------------------------------------------
// Business jet (T-tail, rear-mounted engines)
// ---------------------------------------------------------------------------

function buildBizjet(): AircraftModel {
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

function buildLongitude(): AircraftModel {
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

// ---------------------------------------------------------------------------
// Cessna-style high-wing single
// ---------------------------------------------------------------------------

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

function buildCessna(): AircraftModel {
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


// ---------------------------------------------------------------------------
// F-16-style single-engine fighter: blended body with a chin intake, bubble
// canopy, 40° cropped-delta wing with leading-edge extensions, all-moving
// anhedral stabilators, single fin with ventral fins and a variable nozzle
// with an afterburner plume. 15.1 m long, 9.96 m span over the tip rails.
// ---------------------------------------------------------------------------

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

function buildFighter(): AircraftModel {
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

const BUILDERS: Record<string, () => AircraftModel> = {
  b737: () => {
    const mdl = buildAirliner(B737)
    return mdl
  },
  a320: () => buildAirliner(A320),
  a380: buildA380,
  bizjet: buildBizjet,
  longitude: buildLongitude,
  c172: buildCessna,
  f16: buildFighter,
}

/** Builds (and enables lighting-mask layers on) the exterior model for an aircraft id. */
export function buildAircraft(id: string, lightingLayer: number): AircraftModel {
  const build = BUILDERS[id] ?? BUILDERS.b737
  const model = build()
  model.root.traverse((o) => {
    const mat = (o as Mesh).material as Material | undefined
    // Transparent parts stay in the post-process-lit layer (blended over the scenery).
    if (mat && mat.transparent) return
    o.layers.enable(lightingLayer)
  })
  return model
}

/** Releases mesh resources owned by a procedural aircraft or cockpit. */
export function disposeAircraftMeshes(root: Object3D, disposeTextures = true) {
  const geometries = new Set<BufferGeometry>()
  const materials = new Set<Material>()
  const textures = new Set<Texture>()
  root.traverse((object) => {
    const mesh = object as Mesh
    if (!mesh.isMesh) return
    geometries.add(mesh.geometry)
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material)
  })
  for (const material of materials) {
    if (disposeTextures) {
      for (const value of Object.values(material)) {
        if (value instanceof Texture) textures.add(value)
      }
    }
    material.dispose()
  }
  for (const geometry of geometries) geometry.dispose()
  for (const texture of textures) texture.dispose()
}

