import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { S } from '../src/sim/protocol.ts'
import { SHUTTLE_SITES } from '../src/sim/shuttleSites.ts'

const bytes = await readFile(new URL('../public/sim/sim.wasm', import.meta.url))
async function host() {
  const { instance } = await WebAssembly.instantiate(bytes, {})
  const w = instance.exports
  function command(cmd) {
    const data = new TextEncoder().encode(JSON.stringify(cmd))
    const ptr = w.io_reserve(data.length)
    new Uint8Array(w.memory.buffer, ptr, data.length).set(data)
    assert.equal(w.sim_command(), 0)
  }
  function snapshot() { const ptr = w.sim_snapshot(); return new Float64Array(w.memory.buffer, ptr, w.sim_snapshot_len()).slice() }
  function advance(seconds) { for (let i = 0; i < seconds * 60; i++) w.sim_advance(1 / 60) }
  command({ type: 'set_aircraft', id: 'endeavour' })
  command({ type: 'spawn_shuttle', orbit: false })
  command({ type: 'set_paused', paused: false })
  assert.equal(w.sim_snapshot_len(), S.LEN)
  return { w, command, snapshot, advance }
}

test('browser WASM launches, stages, separates, and transports every RCS translation axis', async () => {
  const { w, command, snapshot, advance } = await host()
  assert.equal(snapshot()[S.SHUTTLE_PHASE], 1)
  assert.ok(snapshot()[S.GS_KT] < 0.01)
  command({ type: 'set_time_scale', scale: 8 })
  command({ type: 'launch_shuttle' })
  advance(16)
  assert.equal(snapshot()[S.SHUTTLE_PHASE], 3)
  advance(48)
  assert.equal(snapshot()[S.SHUTTLE_PHASE], 4)
  command({ type: 'separate_shuttle' })
  command({ type: 'set_time_scale', scale: 1 })
  assert.equal(snapshot()[S.SHUTTLE_PHASE], 5)
  w.sim_input(0, 0, 0, 0, 0, 0, 1, 1)
  advance(1)
  assert.ok(snapshot()[S.NY] > 0.01, 'strafe reaches Rust through the WASM ABI')
  assert.ok(snapshot()[S.NZ] > 0.01, 'vertical RCS reaches Rust through the WASM ABI')
  w.sim_input(0, 0, 0, 0, 0, 0, 0, 0)
  advance(1)
  assert.equal(snapshot()[S.NZ], 0)
  assert.ok(snapshot().every(Number.isFinite))
  command({ type: 'set_aircraft', id: 'b737' })
  assert.equal(snapshot()[S.SHUTTLE_PHASE], 0, 'switching back clears mission state')
})

test('browser WASM and frontend launch locations agree, and ground height moves the pad', async () => {
  const { command, snapshot } = await host()
  for (const [code, site] of SHUTTLE_SITES.entries()) {
    command({ type: 'spawn_shuttle', orbit: false, site: site.id })
    command({ type: 'ground', lat: site.lat, lon: site.lon, height: 42 })
    const s = snapshot()
    assert.ok(Math.abs(s[S.LAT] - site.lat) < 1e-7, site.name)
    assert.ok(Math.abs(s[S.LON] - site.lon) < 1e-7, site.name)
    assert.ok(Math.abs(s[S.HEIGHT] - 63) < 1e-5, '21 m stack datum over terrain')
    assert.equal(s[S.SHUTTLE_SITE], code)
    assert.equal(s[S.SHUTTLE_PAD_HEIGHT], 42)
    command({ type: 'reset' })
    assert.equal(snapshot()[S.SHUTTLE_SITE], code)
  }
})


test('browser WASM returns Endeavour from orbit and autolands on its wheels', async () => {
  const { command, snapshot, advance } = await host()
  command({ type: 'spawn_shuttle', orbit: true })
  command({ type: 'land_shuttle', airport: 'KTTS' })
  assert.equal(snapshot()[S.SHUTTLE_PHASE], 6)
  assert.equal(snapshot()[S.GEAR], 1)
  command({ type: 'set_time_scale', scale: 8 })
  advance(80)
  const s = snapshot()
  assert.equal(s[S.AP_PHASE], 14, 'autopilot reaches stopped after touchdown and rollout')
  assert.equal(s[S.FLAGS] & 4, 0, 'no crash')
  assert.ok(s[S.GS_KT] < 1)
  assert.ok(s[S.FLAGS] & 1, 'on the runway')
  assert.equal(s[S.GEAR], 1)
})
