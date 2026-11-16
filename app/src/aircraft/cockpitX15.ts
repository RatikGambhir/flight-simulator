import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, Vector3, type Material } from 'three'
import { S, type SimCommand } from '../sim/protocol'
import type { Cockpit } from './cockpit'
import { InstrumentCanvas } from './instruments'
import type { AircraftModel } from './models'

const IVORY = '#e3dfcf'
const AMBER = '#efc14e'

function dial(g: CanvasRenderingContext2D, x: number, y: number, label: string, value: string, fraction: number) {
  g.save()
  g.translate(x, y)
  g.fillStyle = '#101215'
  g.strokeStyle = '#505152'
  g.lineWidth = 6
  g.beginPath()
  g.arc(0, 0, 99, 0, 2 * Math.PI)
  g.fill()
  g.stroke()
  g.strokeStyle = IVORY
  for (let tick = 0; tick <= 20; tick++) {
    const angle = (tick / 20 - 0.5) * 4.7
    const x = Math.sin(angle)
    const y = -Math.cos(angle)
    const length = tick % 5 === 0 ? 68 : 76
    g.lineWidth = tick % 5 === 0 ? 3 : 1.5
    g.beginPath()
    g.moveTo(x * 86, y * 86)
    g.lineTo(x * length, y * length)
    g.stroke()
  }
  const angle = (Math.max(0, Math.min(1, fraction)) - 0.5) * 4.7
  g.strokeStyle = AMBER
  g.lineWidth = 4
  g.beginPath()
  g.moveTo(0, 0)
  g.lineTo(Math.sin(angle) * 62, -Math.cos(angle) * 62)
  g.stroke()
  g.fillStyle = IVORY
  g.font = 'bold 23px monospace'
  g.fillText(value, 0, 35)
  g.font = '14px monospace'
  g.fillText(label, 0, 62)
  g.restore()
}

function drawPanel(g: CanvasRenderingContext2D, s: Float64Array, width: number, height: number) {
  g.fillStyle = '#262829'
  g.fillRect(0, 0, width, height)
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillStyle = AMBER
  g.font = 'bold 24px monospace'
  g.fillText('NASA   X-15-3', width / 2, 35)
  const mach = s[S.MACH]
  const altitude = s[S.ALT_MSL_FT]
  dial(g, 239, 155, 'MACH', mach.toFixed(2), mach / 7)
  dial(g, 489, 155, 'ALTITUDE FT', String(Math.round(altitude)), altitude / 360_000)
  dial(g, 739, 155, 'XLR99 POWER', `${Math.round(s[S.ENGINE] * 100)}%`, s[S.ENGINE])
  dial(g, 239, 377, 'TAS KT', String(Math.round(s[S.TAS_KT])), s[S.TAS_KT] / 4200)
  dial(g, 489, 377, 'HEADING °T', String(Math.round(s[S.HEADING]) % 360).padStart(3, '0'), s[S.HEADING] / 360)
  const climbRate = s[S.VS_FPM] / 1000
  dial(g, 739, 377, 'V/S KFT/MIN', climbRate.toFixed(1), 0.5 + climbRate / 400)
}

export function buildX15Cockpit(model: AircraftModel): Cockpit {
  const root = new Group()
  root.name = 'cockpit'
  root.position.copy(model.eye)
  const structure = new MeshStandardMaterial({ color: '#373a3c', roughness: 0.85 })
  const dark = new MeshStandardMaterial({ color: '#1c1e20', roughness: 0.9 })
  const grip = new MeshStandardMaterial({ color: '#762e23', roughness: 0.5 })
  const box = (parent: Group, mat: Material, w: number, h: number, d: number, x: number, y: number, z: number) => {
    const object = new Mesh(new BoxGeometry(w, h, d), mat)
    object.position.set(x, y, z)
    parent.add(object)
    return object
  }
  const beam = (a: Vector3, b: Vector3, size: number) => {
    const middle = new Vector3().addVectors(a, b).multiplyScalar(0.5)
    const bar = box(root, structure, size, a.distanceTo(b), size, middle.x, middle.y, middle.z)
    bar.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), b.clone().sub(a).normalize())
  }
  const sill = new Vector3(0, -0.25, -0.87)
  const windshieldTop = new Vector3(0, 0.29, -0.61)
  beam(sill, windshieldTop, 0.049)
  for (const side of [-1, 1]) {
    const foot = new Vector3(0.43 * side, -0.25, -0.72)
    const shoulder = new Vector3(0.34 * side, 0.24, -0.24)
    beam(sill, foot, 0.050)
    beam(foot, shoulder, 0.052)
    beam(windshieldTop, shoulder, 0.055)
    beam(shoulder, new Vector3(0.36 * side, 0.24, 0.40), 0.048)
    beam(foot, new Vector3(0.43 * side, -0.25, 0.40), 0.048)
    box(root, structure, 0.06, 0.55, 1.28, 0.47 * side, -0.52, -0.22)
    box(root, dark, 0.15, 0.10, 0.88, 0.38 * side, -0.49, -0.29)
  }
  box(root, dark, 0.90, 0.07, 1.5, 0, -0.82, -0.14)
  box(root, structure, 0.91, 0.69, 0.10, 0, -0.46, 0.51)
  box(root, dark, 0.88, 0.07, 0.31, 0, -0.25, -0.86)

  const panel = new InstrumentCanvas(978, 512, drawPanel)
  panel.update(new Float64Array(S.LEN))
  const face = new Mesh(new PlaneGeometry(0.87, 0.455), new MeshBasicMaterial({ map: panel.texture, toneMapped: false }))
  face.name = 'x15-flight-instruments'
  face.position.set(0, -0.507, -0.83)
  face.rotation.x = -0.15
  root.add(face)

  const stick = new Group()
  stick.position.set(0, -0.78, -0.50)
  root.add(stick)
  const column = new Mesh(new CylinderGeometry(0.018, 0.026, 0.29, 12), structure)
  column.position.y = 0.145
  stick.add(column)
  box(stick, dark, 0.072, 0.10, 0.061, 0, 0.303, 0.014).rotation.x = -0.19
  box(stick, grip, 0.018, 0.022, 0.012, 0.016, 0.336, 0.044)

  const throttle = new Group()
  throttle.position.set(-0.38, -0.45, -0.44)
  root.add(throttle)
  box(throttle, structure, 0.023, 0.119, 0.025, 0, 0.06, 0)
  const handle = box(throttle, grip, 0.091, 0.034, 0.042, 0, 0.12, 0)
  const increase = { type: 'set_throttle', value: 0.1 } satisfies SimCommand
  const decrease = { type: 'set_throttle', value: 0 } satisfies SimCommand
  handle.userData.cockpitCommand = increase
  handle.userData.cockpitShiftCommand = decrease
  handle.userData.cockpitLabel = 'Rocket throttle +10% · Shift-click to decrease'
  root.traverse((object) => object.layers.enableAll())

  let nextDraw = 0
  return {
    root, instruments: [panel], stick, yoke: null, throttles: [throttle],
    update(s, input) {
      const now = performance.now()
      if (now >= nextDraw) {
        nextDraw = now + 50
        panel.update(s)
      }
      stick.rotation.set(-input.pitch * 0.26, 0, -input.roll * 0.32)
      throttle.rotation.x = 0.44 - 0.9 * input.throttle
      increase.value = Math.min(1, input.throttle + 0.1)
      decrease.value = Math.max(0, input.throttle - 0.1)
    },
    dispose() { panel.dispose() },
  }
}
