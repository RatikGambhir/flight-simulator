import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { Mesh, Raycaster, Vector3 } from 'three'

// Node's TS stripping does not resolve the extensionless imports used by Vite.
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.includes('/src/')) {
    const url = new URL(`${specifier}.ts`, context.parentURL)
    if (existsSync(url)) return next(url.href, context)
  }
  return next(specifier, context)
} })

// Geometry/resource tests do not need a GPU or rasterized instrument text.
// The actual canvas rendering is checked in the running application.
globalThis.document = { createElement() {
  const ctx = new Proxy({}, { get(target, key) { return target[key] ?? (() => {}) } })
  return { width: 0, height: 0, getContext() { return ctx } }
} }
const { build737Cockpit } = await import('../src/aircraft/cockpit737.ts')
const { S, Flags } = await import('../src/sim/protocol.ts')
const eye = new Vector3(-0.52, 0.78, -16)

function make() {
  const cockpit = build737Cockpit({ eye })
  const meshes = []
  cockpit.root.traverse((o) => { if (o instanceof Mesh) meshes.push(o) })
  return { cockpit, meshes, dispose() {
    cockpit.dispose()
    const materials = new Set()
    for (const m of meshes) { m.geometry.dispose(); materials.add(m.material) }
    for (const m of materials) m.dispose()
  } }
}

test('737 detail stays batched, finite, and owns all canvas textures', () => {
  const fixture = make()
  const textures = new Set()
  for (const m of fixture.meshes) {
    if (m.material.map) textures.add(m.material.map)
    for (const n of m.geometry.attributes.position.array) assert.ok(Number.isFinite(n))
  }
  assert.ok(fixture.meshes.length < 130, `${fixture.meshes.length} draw calls for cockpit`)
  assert.ok(fixture.meshes.filter((m) => m.name === '737-static-panel').length < 30)
  let disposed = 0
  for (const texture of textures) texture.addEventListener('dispose', () => disposed++)
  fixture.dispose()
  assert.equal(disposed, textures.size, 'all panel and instrument textures must be disposed')
})

test('main autopilot controls are reachable from the pilot eye and decorative hardware is inactive', () => {
  const fixture = make()
  try {
    const active = fixture.meshes.filter((m) => m.userData.cockpitCommand)
    const commands = new Set(active.map((m) => m.userData.cockpitCommand.type))
    assert.deepEqual(commands, new Set(['toggle_gear', 'autopilot', 'toggle_autopilot', 'set_throttle', 'toggle_spoilers', 'flaps_down']))
    assert.ok(fixture.meshes.filter((m) => m.name === '737-static-panel').every((m) => !m.userData.cockpitCommand))
    fixture.cockpit.root.updateMatrixWorld(true)
    for (const m of active.filter((m) => ['autopilot', 'toggle_autopilot'].includes(m.userData.cockpitCommand.type))) {
      const target = m.getWorldPosition(new Vector3())
      const ray = new Raycaster(eye, target.sub(eye).normalize(), 0, 3)
      const hit = ray.intersectObject(fixture.cockpit.root, true)[0]
      assert.equal(hit?.object.userData.cockpitCommand, m.userData.cockpitCommand, 'control must not be hidden behind another surface')
    }
  } finally { fixture.dispose() }
})

test('animated controls follow the simulation, and throttle clicks stay within limits', () => {
  const fixture = make()
  try {
    const s = new Float64Array(S.LEN)
    s[S.FLAGS] = Flags.AP_ENGAGED; s[S.GEAR] = 1; s[S.FLAPS] = 0.5
    fixture.cockpit.update(s, { pitch: 0.5, roll: -0.5, throttle: 0.98 })
    assert.ok(fixture.cockpit.yoke.rotation.x < 0)
    assert.ok(fixture.cockpit.yoke.userData.wheel.rotation.z > 0)
    const grips = fixture.meshes.filter((m) => m.userData.cockpitCommand?.type === 'set_throttle')
    assert.ok(grips.length >= 2)
    for (const grip of grips) assert.equal(grip.userData.cockpitCommand.value, 1)
    fixture.cockpit.update(s, { pitch: 0, roll: 0, throttle: 0.02 })
    for (const grip of grips) assert.equal(grip.userData.cockpitShiftCommand.value, 0)
    assert.equal(Math.abs(fixture.cockpit.yoke.rotation.x), 0)
  } finally { fixture.dispose() }
})

test('Skyhawk cockpit builds with working throttle, flap and yoke controls', async () => {
  const { build172Cockpit } = await import('../src/aircraft/cockpit172.ts')
  const cockpit = build172Cockpit({ eye: new Vector3(-0.27, 0.55, -0.05) })
  const meshes = []
  cockpit.root.traverse((o) => { if (o instanceof Mesh) meshes.push(o) })
  try {
    for (const m of meshes) for (const n of m.geometry.attributes.position.array) assert.ok(Number.isFinite(n))
    assert.ok(meshes.length < 130, `${meshes.length} draw calls for cockpit`)
    const commands = new Set(meshes.filter((m) => m.userData.cockpitCommand).map((m) => m.userData.cockpitCommand.type))
    assert.deepEqual([...commands].sort(), ['flaps_down', 'set_throttle'])
    const s = new Float64Array(64)
    cockpit.update(s, { pitch: 0, roll: 0, throttle: 0 })
    const idle = cockpit.throttles[0].position.z
    s[S.FLAPS] = 1
    cockpit.update(s, { pitch: 0.5, roll: -0.5, throttle: 1 })
    assert.ok(cockpit.throttles[0].position.z < idle, 'throttle pushes in for power')
    assert.ok(cockpit.yoke.position.z > 0)
    assert.ok(cockpit.yoke.userData.wheel.rotation.z > 0)
    const grip = meshes.find((m) => m.userData.cockpitCommand?.type === 'set_throttle')
    assert.equal(grip.userData.cockpitCommand.value, 1)
  } finally {
    cockpit.dispose()
    const materials = new Set()
    for (const m of meshes) { m.geometry.dispose(); materials.add(m.material) }
    for (const m of materials) m.dispose()
  }
})
