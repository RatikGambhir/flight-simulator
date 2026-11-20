// CPU benchmark for the Endeavour launch effects (no GPU needed):
//   node --experimental-transform-types scripts/launch-effects.bench.mjs
// Drives the booster phase at 60 FPS with the real smoke and plume code and
// reports the per-frame cost of the simulation update and the draw preparation.
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { Color, Group, Object3D, PerspectiveCamera, Vector3 } from 'three'

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.includes('/src/')) {
    const url = new URL(`${specifier}.ts`, context.parentURL)
    if (existsSync(url)) return next(url.href, context)
  }
  return next(specifier, context)
} })

const { LaunchEffects } = await import('../src/scene/launchEffects.ts')
const { S } = await import('../src/sim/protocol.ts')
const { frame, geodeticToEcef, enuBasis } = await import('../src/world/frame.ts')

const lat = 29.5547, lon = -95.0939
const pad = geodeticToEcef(lat, lon, 10)
const east = new Vector3(), north = new Vector3(), up = new Vector3()
enuBasis(lat, lon, east, north, up)
frame.setOrigin(pad.x, pad.y, pad.z)

// A stand-in for the Endeavour model with its exhaust anchors.
const root = new Group()
const add = (parent, name, x, y, z) => { const o = new Object3D(); o.name = name; o.position.set(x, y, z); parent.add(o) }
for (const side of [-1, 1]) {
  const booster = new Group(); root.add(booster)
  add(booster, `plume-srb-${side < 0 ? 0 : 1}`, side * 6.3, -6.2, 21.8)
}
for (const [i, [x, y]] of [[0, 1.25], [-1.35, -0.9], [1.35, -0.9]].entries()) add(root, `plume-ssme-${i}`, x, y, 20.4)
for (const i of [0, 1]) add(root, `plume-oms-${i}`, i ? 2.4 : -2.4, 1.5, 18.65)
root.rotation.x = Math.PI / 2 // nose up: model -z points to world +y

const fx = new LaunchEffects(root)
const camera = new PerspectiveCamera(58, 16 / 9, 0.3, 2e7)
const s = new Float64Array(S.LEN)
const f = {
  s, generation: 1, sun: new Vector3(0.3, 0.8, 0.2).normalize(), sunColor: new Color(1.5, 1.8, 1.9), ambient: new Color(0.3, 0.4, 0.6),
  pad, padUp: up, padEast: east, padNorth: north, velocity: new Vector3(), wind: new Vector3(3, 0, 0),
}
const dt = 1 / 60
const seconds = Number(process.argv[2] ?? 125)
let update = 0, prepare = 0, peak = 0
const t0 = performance.now()
for (let i = 0; i <= seconds * 60; i++) {
  const t = i * dt
  // Smooth-step climb like the guided ascent (about 60 km at booster separation).
  const u = t / 510, height = 420_000 * u * u * (3 - 2 * u)
  s[S.SHUTTLE_PHASE] = 2; s[S.MISSION_TIME] = t; s[S.HEIGHT] = height + 10; s[S.SHUTTLE_PAD_HEIGHT] = 10
  const speed = 420_000 * 6 * u * (1 - u) / 510
  f.velocity.copy(up).multiplyScalar(speed)
  root.position.set(0, height + 20, -height * 0.4)
  root.updateMatrixWorld(true)
  camera.position.set(90, height + 50, -height * 0.4 + 90); camera.lookAt(root.position); camera.updateMatrixWorld()
  let a = performance.now()
  fx.update(f, dt)
  update += performance.now() - a
  a = performance.now()
  fx.prepare(camera)
  prepare += performance.now() - a
  peak = Math.max(peak, fx.smokeCount ?? 0)
}
const frames = seconds * 60 + 1
console.log(`frames ${frames}  wall ${(performance.now() - t0).toFixed(0)} ms`)
console.log(`update  ${(update / frames).toFixed(3)} ms/frame`)
console.log(`prepare ${(prepare / frames).toFixed(3)} ms/frame`)
console.log(`total   ${((update + prepare) / frames).toFixed(3)} ms/frame   peak puffs ${peak}`)
fx.dispose()
