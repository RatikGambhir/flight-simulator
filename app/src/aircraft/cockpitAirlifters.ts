import {
  BoxGeometry, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  PlaneGeometry, Quaternion, Vector3, type BufferGeometry, type Material, type Object3D,
} from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { S, type SimCommand } from '../sim/protocol'
import type { Cockpit } from './cockpit'
import { drawEICAS, drawND, drawPFD, InstrumentCanvas } from './instruments'
import { drawAirliftHud, drawAirliftNav, drawAirliftStatus } from './instruments/airlift'
import type { AircraftModel } from './models'

type Point = [x: number, y: number, z: number]
const SIDES = [-1, 1] as const
const UP = new Vector3(0, 1, 0)

/** Cockpits based on the C-5M AMP flight deck and the C-17 four-MFD flight deck. */
export function buildAirlifterCockpit(model: AircraftModel): Cockpit {
  const galaxy = model.id === 'c5m'
  const root = new Group()
  root.name = 'cockpit'
  root.position.set(0, model.eye.y, model.eye.z)
  const structure = new Group()
  root.add(structure)

  const material = (color: string, roughness = 0.82) => new MeshStandardMaterial({
    color, roughness, metalness: 0.06, emissive: color, emissiveIntensity: 0.18,
  })
  const lining = material(galaxy ? '#707a7e' : '#7c8074')
  const panel = material(galaxy ? '#36414a' : '#3f433c')
  const frame = material(galaxy ? '#49545c' : '#555951')
  const rubber = material('#161a1b', 0.96)
  const aluminum = material('#889492', 0.42)
  const ivory = material('#ccc7ae')
  const guarded = material('#a13a2e')
  const fabric = material(galaxy ? '#465871' : '#656755', 0.98)
  const glass = new MeshStandardMaterial({ color: '#91cea6', transparent: true, opacity: 0.09, depthWrite: false, side: DoubleSide, roughness: 0.35 })

  function mesh(geometry: BufferGeometry, mat: Material, at: Point, parent: Object3D = structure) {
    const object = new Mesh(geometry, mat)
    object.position.set(...at)
    parent.add(object)
    return object
  }
  function box(size: Point, mat: Material, at: Point, parent: Object3D = structure, radius = 0) {
    return mesh(radius ? new RoundedBoxGeometry(...size, 2, radius) : new BoxGeometry(...size), mat, at, parent)
  }
  function post(a: Point, b: Point, width: number, mat: Material, parent: Object3D = structure) {
    const from = new Vector3(...a)
    const to = new Vector3(...b)
    const direction = to.clone().sub(from)
    const mid = from.add(to).multiplyScalar(0.5)
    const bar = box([width, direction.length() + width * 0.3, width], mat, [mid.x, mid.y, mid.z], parent, width * 0.14)
    bar.quaternion.copy(new Quaternion().setFromUnitVectors(UP, direction.normalize()))
  }

  const half = galaxy ? 1.48 : 1.28
  const panelZ = galaxy ? -1.04 : -1.12
  const glareY = galaxy ? -0.31 : -0.33
  const eyeX = Math.abs(model.eye.x)
  const instruments: InstrumentCanvas[] = []

  // Model the front, angled quarter windows and sliding side windows separately.
  const centerBottom: Point = [0, glareY, -1.52]
  const centerTop: Point = [0, 0.55, -1.20]
  post(centerBottom, centerTop, galaxy ? 0.078 : 0.066, frame)
  box([half * 2, 0.07, 3.25], panel, [0, -1.20, -0.05])
  box([half * 2, 0.10, 1.9], lining, [0, 0.61, -0.28])
  box([half * 2, 1.79, 0.10], lining, [0, -0.30, 1.49])
  box([half * 1.87, 0.12, 0.47], rubber, [0, glareY - 0.028, panelZ - 0.19], structure, 0.041)
  box([half * 1.88, 0.66, 0.093], panel, [0, glareY - 0.36, panelZ], structure, 0.022)
  box([half * 1.88, 0.29, 0.24], lining, [0, -1.065, panelZ - 0.10], structure, 0.025)

  for (const side of SIDES) {
    const frontBottom: Point = [side * (galaxy ? 0.91 : 0.87), glareY + 0.01, -1.43]
    const frontTop: Point = [frontBottom[0] * 0.95, 0.52, galaxy ? -1.12 : -1.03]
    const sideBottom: Point = [side * (half - 0.04), glareY + 0.015, galaxy ? -0.61 : -0.69]
    const sideTop: Point = [side * (half - 0.09), 0.49, -0.48]
    const rearBottom: Point = [side * half, glareY + 0.035, 0.58]
    const rearTop: Point = [side * (half - 0.03), 0.52, 0.52]
    for (const [bottom, top] of [[frontBottom, frontTop], [sideBottom, sideTop], [rearBottom, rearTop]]) {
      post(bottom, top, 0.076, frame)
    }
    for (const [a, b] of [[centerTop, frontTop], [frontTop, sideTop], [sideTop, rearTop]]) post(a, b, 0.105, lining)
    for (const [a, b] of [[centerBottom, frontBottom], [frontBottom, sideBottom], [sideBottom, rearBottom]]) post(a, b, 0.077, rubber)
    post([side * 0.28, glareY + 0.04, -1.46], [side * 0.64, glareY + 0.09, -1.42], 0.015, rubber)
    box([0.10, 0.92, 2.86], lining, [side * half, -0.75, 0.01])
    box([0.22, 0.14, 1.61], panel, [side * (half - 0.10), -0.71, -0.30], structure, 0.026)
    box([0.12, 0.92, 0.90], lining, [side * half, 0.15, 1.03], structure, 0.04)

    const seat = new Group()
    seat.position.set(side * eyeX, -1.10, 0.24)
    structure.add(seat)
    box([0.43, 0.12, 0.48], fabric, [0, 0.22, 0], seat, 0.053)
    box([0.43, 0.61, 0.17], fabric, [0, 0.54, 0.24], seat, 0.058).rotation.x = -0.12
    box([0.32, 0.18, 0.16], fabric, [0, 0.89, 0.27], seat, 0.052)
    for (const arm of SIDES) box([0.063, 0.069, 0.34], rubber, [arm * 0.25, 0.43, 0.05], seat, 0.024)
    for (const foot of SIDES) {
      const at: Point = [side * eyeX + foot * 0.12, -1.055, panelZ + 0.22]
      box([0.125, 0.145, 0.045], aluminum, at, structure, 0.016).rotation.x = -0.28
      for (const dy of [-0.035, 0, 0.035]) box([0.09, 0.008, 0.015], rubber, [at[0], at[1] + dy, at[2] + 0.024])
    }
  }

  const displayFaces: Mesh[] = []
  const displayMaterials = new Map<InstrumentCanvas, MeshBasicMaterial>()
  function display(instrument: InstrumentCanvas, x: number, y: number, width: number, height: number, z = panelZ + 0.050, parent: Object3D = structure) {
    box([width + 0.038, height + 0.057, 0.038], rubber, [x, y, z], parent, 0.017)
    let mat = displayMaterials.get(instrument)
    if (!mat) {
      mat = new MeshBasicMaterial({ map: instrument.texture, toneMapped: false })
      displayMaterials.set(instrument, mat)
    }
    const face = mesh(new PlaneGeometry(width, height), mat, [x, y + 0.007, z + 0.021], parent)
    face.name = 'airlifter-display'
    displayFaces.push(face)
    for (const dx of [-0.36, -0.12, 0.12, 0.36]) {
      box([0.015, 0.009, 0.007], panel, [x + width * dx, y - height / 2 - 0.008, z + 0.023], parent)
    }
    for (const side of SIDES) {
      for (const dy of [-0.3, 0, 0.3]) {
        box([0.008, 0.017, 0.008], frame, [x + side * (width / 2 + 0.010), y + height * dy, z + 0.024], parent)
      }
    }
  }

  const pfd = new InstrumentCanvas(512, 512, drawPFD)
  const nav = new InstrumentCanvas(512, 512, galaxy ? drawND : drawAirliftNav)
  instruments.push(pfd, nav)
  if (galaxy) {
    const systems = new InstrumentCanvas(480, 480, drawAirliftStatus)
    const engines = new InstrumentCanvas(512, 480, (g, s, w, h) => drawEICAS(g, s, w, h, 4))
    instruments.push(systems, engines)
    for (const side of SIDES) {
      display(nav, side * 1.02, -0.575, 0.254, 0.222)
      display(pfd, side * 0.68, -0.575, 0.254, 0.222)
      display(systems, side * 0.34, -0.575, 0.252, 0.222)
    }
    display(engines, 0, -0.61, 0.248, 0.218)
    const engineer = new Group()
    engineer.position.set(1.08, -0.40, 0.74)
    engineer.rotation.y = -Math.PI / 2
    structure.add(engineer)
    box([0.92, 0.70, 0.09], panel, [0, 0, -0.044], engineer, 0.025)
    display(systems, -0.18, 0.13, 0.27, 0.25, 0.023, engineer)
    display(engines, 0.16, 0.13, 0.27, 0.25, 0.023, engineer)
    for (let index = 0; index < 8; index++) {
      box([0.034, 0.035, 0.025], ivory, [(index - 3.5) * 0.093, -0.18, 0.021], engineer, 0.004)
    }
  } else {
    const distance = 0.86
    const width = 0.37
    const height = 0.29
    const hud = new InstrumentCanvas(740, 580, (g, s, w, h) => drawAirliftHud(g, s, w, h, distance * w / width))
    instruments.push(hud)
    const hudMaterial = new MeshBasicMaterial({ map: hud.texture, transparent: true, depthWrite: false, toneMapped: false })
    for (const side of SIDES) {
      display(pfd, side * 0.82, -0.59, 0.32, 0.262)
      display(nav, side * 0.41, -0.59, 0.32, 0.262)
      const x = side * eyeX
      const z = -distance
      box([width + 0.052, 0.09, 0.135], rubber, [x, -0.225, z], structure, 0.024)
      for (const edge of SIDES) {
        const px = x + edge * (width / 2 + 0.012)
        post([px, -0.207, z], [px, height / 2, z], 0.021, frame)
      }
      const pane = mesh(new PlaneGeometry(width, height), glass, [x, 0, z - 0.005], root)
      pane.raycast = () => {}
      const combiner = mesh(new PlaneGeometry(width, height), hudMaterial, [x, 0, z], root)
      combiner.name = 'c17-head-up-display'
      combiner.renderOrder = 10
      // Decorative transparent optics should never consume clicks on the panel.
      combiner.raycast = () => {}
    }
  }

  const placards = new InstrumentCanvas(1024, 160, (g, _s, w, h) => {
    g.fillStyle = galaxy ? '#313b44' : '#393e35'
    g.fillRect(0, 0, w, h)
    g.font = 'bold 29px monospace'
    g.textAlign = 'center'
    g.fillStyle = '#c6cdc2'
    for (const [i, title] of ['L FLIGHT', galaxy ? 'C-5M' : 'C-17A', 'R FLIGHT'].entries()) {
      g.fillText(title, (i + 0.5) * w / 3, h * 0.40)
      g.strokeStyle = '#858e85'
      g.strokeRect(i * w / 3 + 14, 16, w / 3 - 28, h - 31)
    }
  })
  placards.update(new Float64Array(S.LEN))
  mesh(new PlaneGeometry(1.69, 0.092), new MeshStandardMaterial({
    map: placards.texture, emissiveMap: placards.texture, emissive: '#ffffff', emissiveIntensity: 0.28,
  }), [0, glareY - 0.09, panelZ + 0.051])

  // Overhead switch banks, pedestal ribs and the four-engine throttle quadrant.
  const overhead = new Group()
  overhead.position.set(0, 0.53, -0.46)
  overhead.rotation.x = Math.PI / 2.3
  structure.add(overhead)
  box([galaxy ? 1.37 : 1.07, 0.77, 0.06], panel, [0, 0, 0], overhead, 0.025)
  for (let row = 0; row < 4; row++) {
    for (const x of [-0.34, -0.12, 0.12, 0.34]) {
      const y = (row - 1.5) * 0.166
      box([0.19, 0.13, 0.013], rubber, [x, y, 0.035], overhead, 0.008)
      box([0.042, 0.027, 0.02], row === 0 ? guarded : frame, [x, y + 0.038, 0.047], overhead, 0.004)
      for (const dx of [-0.051, 0, 0.051]) box([0.012, 0.035, 0.026], ivory, [x + dx, y - 0.018, 0.050], overhead, 0.003)
    }
  }
  box([0.49, 0.36, 1.42], panel, [0, -0.94, -0.08], structure, 0.036)
  box([0.38, 0.14, 0.42], rubber, [0, -0.75, -0.32], structure, 0.048)
  for (let i = 0; i < 4; i++) {
    box([0.031, 0.01, 0.31], aluminum, [(i - 1.5) * 0.069, -0.677, -0.32], structure, 0.004)
  }
  for (const z of [-0.70, 0.06, 0.24, 0.42]) {
    box([0.39, 0.017, 0.14], rubber, [0, -0.746, z], structure, 0.014)
    for (const x of [-0.144, -0.072, 0, 0.072, 0.144]) {
      mesh(new CylinderGeometry(0.016, 0.017, 0.022, 10), frame, [x, -0.725, z])
    }
  }

  function clickable(object: Mesh, label: string, command: SimCommand, shift?: SimCommand) {
    object.userData = { cockpitLabel: label, cockpitCommand: command, cockpitShiftCommand: shift }
    return object
  }
  const apButton = clickable(box([0.083, 0.04, 0.036], frame, [0, glareY - 0.12, panelZ + 0.080], root, 0.007),
    'Toggle autopilot', { type: 'toggle_autopilot' })
  const apLabel = new InstrumentCanvas(128, 64, (g, state, w, h) => {
    g.fillStyle = (state[S.AP_MODES] | 0) ? '#244631' : '#272d2a'
    g.fillRect(0, 0, w, h)
    g.fillStyle = '#d5e2d8'
    g.font = 'bold 31px monospace'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText('A/P', w / 2, h / 2)
  })
  instruments.push(apLabel)
  mesh(new PlaneGeometry(0.058, 0.027), new MeshBasicMaterial({ map: apLabel.texture, toneMapped: false }),
    [0, 0, 0.019], apButton).raycast = () => {}
  const gearHandle = clickable(mesh(new CylinderGeometry(0.037, 0.037, 0.033, 18), ivory,
    [0.17, -0.68, panelZ + 0.13], root), 'Raise or lower landing gear', { type: 'toggle_gear' })
  gearHandle.rotation.x = Math.PI / 2
  const flapHandle = clickable(box([0.044, 0.042, 0.066], ivory, [0.196, -0.633, -0.23], root, 0.012),
    'Flaps down one notch · Shift-click for flaps up', { type: 'flaps_down' }, { type: 'flaps_up' })
  const spoilerHandle = clickable(box([0.042, 0.053, 0.07], frame, [-0.197, -0.633, -0.24], root, 0.009),
    'Extend or retract speedbrakes', { type: 'toggle_spoilers' })

  const throttles: Group[] = []
  const throttleGrips: Mesh[] = []
  for (let i = 0; i < 4; i++) {
    const lever = new Group()
    lever.position.set((i - 1.5) * 0.069, -0.677, -0.32)
    root.add(lever)
    post([0, 0, 0], [0, 0.17, -0.026], 0.026, aluminum, lever)
    throttleGrips.push(clickable(box([0.059, 0.050, 0.087], galaxy ? ivory : rubber, [0, 0.176, -0.026], lever, 0.016),
      'Throttle +10% · Shift-click to decrease', { type: 'set_throttle', value: 0.1 }, { type: 'set_throttle', value: 0 }))
    box([0.040, 0.021, 0.04], frame, [0, 0.13, -0.067], lever, 0.007)
    throttles.push(lever)
  }

  const controls: { column: Group; grip: Group }[] = []
  for (const side of SIDES) {
    const column = new Group()
    column.position.set(side * eyeX, -1.13, galaxy ? -0.59 : -0.42)
    root.add(column)
    const grip = new Group()
    grip.position.set(0, galaxy ? 0.57 : 0.40, 0)
    column.add(grip)
    box([0.20, 0.105, 0.20], rubber, [side * eyeX, -1.12, column.position.z], structure, 0.038)
    if (galaxy) {
      post([0, 0, 0], [0, 0.53, 0.04], 0.066, panel, column)
      box([0.34, 0.073, 0.068], rubber, [0, 0, 0.045], grip, 0.027)
      box([0.135, 0.102, 0.059], panel, [0, 0.013, 0.072], grip, 0.014)
      for (const edge of SIDES) {
        post([edge * 0.121, -0.004, 0.043], [edge * 0.17, 0.097, 0.045], 0.048, rubber, grip)
      }
      box([0.014, 0.019, 0.018], guarded, [-0.17, 0.097, 0.07], grip, 0.004)
    } else {
      post([0, 0, 0], [0, 0.40, 0], 0.047, panel, column)
      box([0.067, 0.151, 0.073], rubber, [0.012, 0.024, 0], grip, 0.023).rotation.z = -0.16
      box([0.083, 0.062, 0.084], rubber, [0.020, 0.096, -0.011], grip, 0.021)
      box([0.023, 0.014, 0.021], guarded, [0.038, 0.132, -0.016], grip, 0.004)
    }
    controls.push({ column, grip })
  }

  // Bake the fixed structure by material so the fasteners and switch banks
  // render in a handful of draw calls. Moving controls keep their own meshes.
  const batches = new Map<Material, BufferGeometry[]>()
  root.updateMatrixWorld(true)
  for (const face of displayFaces) root.attach(face)
  structure.traverse((object) => {
    if (!(object instanceof Mesh)) return
    const geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry
    // Matrices are relative to the cockpit's model-space origin.
    geometry.applyMatrix4(object.matrixWorld).translate(-root.position.x, -root.position.y, -root.position.z)
    if (geometry !== object.geometry) object.geometry.dispose()
    const list = batches.get(object.material) ?? []
    list.push(geometry)
    batches.set(object.material, list)
  })
  structure.clear()
  for (const [mat, geometries] of batches) {
    const baked = mergeGeometries(geometries)
    for (const geometry of geometries) geometry.dispose()
    if (baked) structure.add(new Mesh(baked, mat))
  }
  root.traverse((object) => object.layers.enableAll())

  let nextDraw = 0
  const initial = new Float64Array(S.LEN)
  for (const instrument of instruments) instrument.update(initial)
  return {
    root, instruments,
    yoke: galaxy ? controls[0].column : null,
    stick: galaxy ? null : controls[0].column,
    throttles,
    update(state, input) {
      const now = performance.now()
      if (now >= nextDraw) {
        nextDraw = now + 50
        for (const instrument of instruments) instrument.update(state)
      }
      for (const { column, grip } of controls) {
        column.rotation.x = -input.pitch * (galaxy ? 0.14 : 0.27)
        if (galaxy) grip.rotation.z = -input.roll * 0.82
        else column.rotation.z = -input.roll * 0.29
      }
      for (let i = 0; i < throttles.length; i++) {
        throttles[i].rotation.x = 0.42 - input.throttle * 1.05
        throttleGrips[i].userData.cockpitCommand.value = Math.min(1, input.throttle + 0.1)
        throttleGrips[i].userData.cockpitShiftCommand.value = Math.max(0, input.throttle - 0.1)
      }
      gearHandle.position.y = -0.54 - state[S.GEAR] * 0.14
      flapHandle.position.z = -0.31 + state[S.FLAPS] * 0.17
      spoilerHandle.position.z = -0.30 + state[S.SPOILERS] * 0.15
    },
    dispose() {
      for (const instrument of instruments) instrument.dispose()
      placards.dispose()
    },
  }
}
