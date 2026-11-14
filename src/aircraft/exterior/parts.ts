// Shared construction for procedural aircraft exteriors.

import { BoxGeometry, CylinderGeometry, Group, Mesh, Object3D, PointLight, SphereGeometry, Vector3, type BufferGeometry, type Material, type Quaternion } from 'three'
import { hingeFrame, revolveZ, toHingeLocal, wingPanelGeometry, wingPoint, wingUpperPoint, type WingParams } from '../geometry'
import type { AircraftMaterials } from '../materials'

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

export function mesh(geo: BufferGeometry, mat: Material, parent: Object3D, name?: string) {
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
export function buildWings(model: AircraftModel, parent: Object3D, b: WingBuild) {
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

export function tailSurface(model: AircraftModel, parent: Object3D, params: WingParams, at: Vector3, kind: 'elevator' | 'rudder', mat: Material, surfMat: Material, hc = 0.7) {
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
export function turbofan(model: AircraftModel, parent: Object3D, front: Vector3, length: number, radius: number, m: AircraftMaterials, flattenBottom = 0) {
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

export function wheel(radius: number, width: number, m: AircraftMaterials) {
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
export function gearLeg(
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

export function navLights(model: AircraftModel, tipR: Vector3, tail: Vector3, top: Vector3, bottom: Vector3, extra: { landing?: Vector3[]; logo?: { at: Vector3; reach: number } } = {}) {
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

export function newModel(id: string, cockpit: AircraftModel['cockpit'], m: AircraftMaterials): AircraftModel {
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
