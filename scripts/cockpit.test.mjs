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
  const roundedRects = []
  const methods = {
    createLinearGradient: () => ({ addColorStop() {} }),
    roundRect: (x, y, width, height) => roundedRects.push({ x, y, width, height }),
  }
  const ctx = new Proxy(methods, { get(target, key) { return target[key] ?? (() => {}) } })
  return { width: 0, height: 0, roundedRects, getContext() { return ctx } }
} }
const { build737Cockpit } = await import('../src/aircraft/cockpit737.ts')
const { S, Flags } = await import('../src/sim/protocol.ts')
const eye = new Vector3(-0.52, 0.78, -16)

test('A380 builds its widebody exterior, four engines, five gear legs and Airbus-style cockpit', async () => {
  const { buildAircraft, disposeAircraftMeshes } = await import('../src/aircraft/models.ts')
  const { buildCockpit } = await import('../src/aircraft/cockpit.ts')
  const model = buildAircraft('a380', 3)
  assert.equal(model.id, 'a380')
  assert.ok(Math.abs(model.span - 79.8) < 0.001)
  assert.ok(Math.abs(model.length - 72.7) < 0.001)
  assert.equal(model.spinners.length, 4)
  assert.deepEqual(model.gear.map(({ pivot }) => pivot.children.filter((child) => child.isGroup).length), [4, 6, 4, 6, 2])
  assert.ok(model.root.getObjectByName('fuselage').layers.isEnabled(3))
  const cabinLights = model.materials.fuselage.emissiveMap.image.roundedRects
  assert.equal(new Set(cabinLights.map(({ x }) => x)).size, 4, 'two lit window rows per side')
  assert.deepEqual(new Set(model.surfaces.map(({ kind }) => kind)), new Set(['flap', 'spoiler', 'aileron', 'elevator', 'rudder']))

  const cockpit = buildCockpit(model)
  let texturesDisposed = 0
  for (const texture of [model.materials.fuselage.map, model.materials.fuselage.emissiveMap]) {
    texture.addEventListener('dispose', () => texturesDisposed++)
  }
  try {
    assert.ok(cockpit.stick)
    assert.equal(cockpit.throttles.length, 4)
    cockpit.update(new Float64Array(S.LEN), { pitch: 0.5, roll: 0, throttle: 1 })
    assert.ok(cockpit.stick.rotation.x < 0)
    assert.ok(cockpit.throttles.every((lever) => lever.rotation.x > 0))
    const engineDisplay = cockpit.root.children.find((object) => object.material?.map === cockpit.instruments[2].texture)
    assert.ok(engineDisplay)
    for (const throttle of [0, 1]) {
      cockpit.update(new Float64Array(S.LEN), { pitch: 0, roll: 0, throttle })
      cockpit.root.updateMatrixWorld(true)
      for (const x of [-0.07, 0, 0.07]) {
        const direction = engineDisplay.localToWorld(new Vector3(x, -0.07, 0)).sub(model.eye).normalize()
        const ray = new Raycaster(model.eye, direction, 0, 2)
        assert.equal(ray.intersectObject(cockpit.root, true)[0]?.object, engineDisplay,
          'the throttle quadrant must leave the engine display visible from the pilot seat')
      }
    }
  } finally {
    cockpit.dispose()
    disposeAircraftMeshes(cockpit.root, false)
    disposeAircraftMeshes(model.root)
  }
  assert.equal(texturesDisposed, 2, 'switching aircraft releases both livery textures')
})

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

test('Airbus flight decks stay batched, keep every display in view and wire the working controls', async () => {
  const { buildAircraft, disposeAircraftMeshes } = await import('../src/aircraft/models.ts')
  const { buildCockpit } = await import('../src/aircraft/cockpit.ts')
  for (const [id, engines] of [['a320', 2], ['a380', 4]]) {
    const model = buildAircraft(id, 3)
    const cockpit = buildCockpit(model)
    try {
      const meshes = []
      cockpit.root.traverse((o) => { if (o instanceof Mesh) meshes.push(o) })
      assert.ok(meshes.length < 150, `${id}: ${meshes.length} draw calls for the cockpit`)
      assert.ok(meshes.some((m) => m.name === 'airbus-static-panel'))
      assert.equal(cockpit.throttles.length, engines)
      assert.equal(cockpit.yoke, null)
      for (const m of meshes) {
        const position = m.geometry.getAttribute('position')
        for (let i = 0; i < position.count * 3; i++) assert.ok(Number.isFinite(position.array[i]))
      }
      // Every working control is wired, and nothing baked into the panel is clickable.
      const active = meshes.filter((m) => m.userData.cockpitCommand)
      assert.deepEqual(new Set(active.map((m) => m.userData.cockpitCommand.type)),
        new Set(['toggle_gear', 'autopilot', 'toggle_autopilot', 'set_throttle', 'toggle_spoilers', 'flaps_down']))
      assert.ok(meshes.filter((m) => m.name === 'airbus-static-panel').every((m) => !m.userData.cockpitCommand))
      // From the captain's eye: all live displays and the autopilot controls are in plain view,
      // with the thrust levers at either end of their travel.
      const displays = meshes.filter((m) => m.name === 'live-display')
      assert.equal(new Set(displays.map((m) => m.material.map)).size, cockpit.instruments.length)
      for (const throttle of [0, 1]) {
        cockpit.update(new Float64Array(S.LEN), { pitch: 0, roll: 0, throttle })
        cockpit.root.updateMatrixWorld(true)
        const targets = [...displays.filter((m) => m.position.x <= 0.2), ...active.filter((m) => ['autopilot', 'toggle_autopilot', 'toggle_gear'].includes(m.userData.cockpitCommand.type))]
        for (const m of targets) {
          const target = m.getWorldPosition(new Vector3())
          const hit = new Raycaster(model.eye, target.sub(model.eye).normalize(), 0, 3).intersectObject(cockpit.root, true)[0]
          assert.ok(hit?.object === m || (m.userData.cockpitCommand && hit?.object.userData.cockpitCommand === m.userData.cockpitCommand),
            `${id}: ${m.userData.cockpitLabel ?? 'display'} at x=${m.position.x.toFixed(2)} is hidden behind ${hit?.object.name || 'another part'}`)
        }
      }
      const s = new Float64Array(S.LEN)
      s[S.GEAR] = 1
      cockpit.update(s, { pitch: 0.5, roll: -0.5, throttle: 0.98 })
      assert.ok(cockpit.stick.rotation.x < 0 && cockpit.stick.rotation.z > 0)
      const grips = meshes.filter((m) => m.userData.cockpitCommand?.type === 'set_throttle')
      assert.ok(grips.length >= engines)
      for (const grip of grips) assert.equal(grip.userData.cockpitCommand.value, 1)
    } finally {
      cockpit.dispose()
      disposeAircraftMeshes(cockpit.root, false)
      disposeAircraftMeshes(model.root)
    }
  }
})

test('instruments are redrawn in turn, each on time, and unchanged ones are skipped', async () => {
  const { InstrumentCanvas, InstrumentSchedule } = await import('../src/aircraft/instruments.ts')
  const drawn = [0, 0, 0, 0, 0, 0]
  const instruments = drawn.map((_, i) => new InstrumentCanvas(8, 8, () => { drawn[i]++ }))
  try {
    const schedule = new InstrumentSchedule(instruments, 50)
    const s = new Float64Array(S.LEN)
    schedule.update(s, 1000)
    assert.deepEqual(drawn, [1, 1, 1, 1, 1, 1], 'nothing starts blank')
    // 60 frames a second for one second: never more than a third of the deck in a frame.
    let busiest = 0
    for (let frame = 1; frame <= 60; frame++) {
      const before = drawn.reduce((a, b) => a + b)
      schedule.update(s, 1000 + frame * 1000 / 60)
      busiest = Math.max(busiest, drawn.reduce((a, b) => a + b) - before)
    }
    assert.ok(busiest <= 3, `${busiest} instruments redrawn in one frame`)
    for (const count of drawn) assert.ok(count >= 20 && count <= 22, `each refreshed 20 times a second (${count - 1})`)
    // A long pause does not turn into a burst of catching up.
    const before = drawn.reduce((a, b) => a + b)
    schedule.update(s, 60000)
    assert.ok(drawn.reduce((a, b) => a + b) - before <= 6)
    // An instrument with a signature only redraws when what it shows changes.
    let redraws = 0
    const windowed = new InstrumentCanvas(8, 8, () => { redraws++ }, (state) => Math.round(state[S.AP_ALT_FT] / 100))
    assert.equal(windowed.update(s), true)
    assert.equal(windowed.update(s), false)
    s[S.AP_ALT_FT] = 12000
    assert.equal(windowed.update(s), true)
    assert.equal(redraws, 2)
    windowed.dispose()
  } finally { instruments.forEach((i) => i.dispose()) }
})
