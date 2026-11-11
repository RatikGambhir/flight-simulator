import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CloudsEffect } from '@takram/three-clouds'
import { Object3D, PerspectiveCamera, Vector3 } from 'three'
import { readFileSync } from 'node:fs'
import { CloudHistory, stabilizeClouds } from '../src/scene/cloudRendering.ts'
import { hingeFrame, setHingeAngle, wingPanelGeometry, wingPoint, wingUpperPoint } from '../src/aircraft/geometry.ts'
import { FlightPrefetch } from '../src/world/flightPrefetch.ts'
import { buildLakeGeometry, distanceToLake, lakeGeoid } from '../src/scene/lakeGeometry.ts'
import { ecefToGeodetic } from '../src/world/frame.ts'

const wing = { span: 17, rootChord: 6, tipChord: 1.5, sweep: 28, dihedral: 5, thicknessRoot: 0.14, thicknessTip: 0.1 }

for (const vertical of [false, true]) for (const side of [1, -1]) {
  test(`cut wing panel is closed and outward-facing (vertical=${vertical}, side=${side})`, () => {
    const g = wingPanelGeometry({ ...wing, vertical }, 0.1, 0.9, 0.15, 0.74, side, 4, 8)
    try {
      const p = g.getAttribute('position'), idx = g.index.array
      const key = i => [p.getX(i), p.getY(i), p.getZ(i)].join(',')
      const edges = new Map()
      let volume = 0
      for (let i = 0; i < idx.length; i += 3) {
        const ids = Array.from(idx.slice(i, i + 3))
        const [a, b, c] = ids.map(j => new Vector3().fromBufferAttribute(p, j))
        volume += a.dot(b.clone().cross(c)) / 6
        for (let k = 0; k < 3; k++) {
          const a = key(ids[k]), b = key(ids[(k + 1) % 3])
          const edge = [a, b].sort().join('|')
          const entry = edges.get(edge) ?? { count: 0, winding: 0 }
          entry.count++; entry.winding += a < b ? 1 : -1
          edges.set(edge, entry)
        }
      }
      for (const entry of edges.values()) assert.deepEqual(entry, { count: 2, winding: 0 })
      assert.ok(volume > 0, `inverted surface: volume=${volume}`)
      assert.ok(g.getAttribute('normal').array.every(Number.isFinite))
    } finally { g.dispose() }
  })
}

test('control deflection preserves swept and mirrored hinge axes, and returns exactly to rest', () => {
  for (const vertical of [false, true]) for (const side of [1, -1]) {
    const h = hingeFrame({ ...wing, vertical }, 0.1, 0.9, 0.74, side)
    const pivot = new Object3D()
    for (const angle of [0, 0.6, -0.4, 0.6, 0]) {
      setHingeAngle(pivot, h.quat, angle)
      const axis = new Vector3(1, 0, 0).applyQuaternion(pivot.quaternion)
      assert.ok(axis.distanceTo(h.axis) < 1e-12)
      if (angle === 0) assert.ok(pivot.quaternion.equals(h.quat))
    }
  }
})

test('spoiler attachment follows the tapered upper skin on both wings', () => {
  for (const side of [1, -1]) {
    const atRoot = wingUpperPoint(wing, 0.2, 0.6, side).y - wingPoint(wing, 0.2, 0.6, side).y
    const atTip = wingUpperPoint(wing, 0.8, 0.6, side).y - wingPoint(wing, 0.8, 0.6, side).y
    assert.ok(atRoot > atTip && atTip > 0)
    const h = hingeFrame(wing, 0.2, 0.8, 0.6, side, true)
    assert.ok(h.origin.distanceTo(wingUpperPoint(wing, 0.2, 0.6, side)) < 1e-12)
  }
})

test('streaming looks ahead along ground velocity, including after a turn or origin shift', () => {
  const view = new FlightPrefetch(), up = new Vector3(0, 1, 0)
  const position = new Vector3(100, 3000, 200)
  assert.equal(view.update(position, new Vector3(150, 80, 0), up, 1000, true), true)
  assert.deepEqual(view.target.toArray(), [1900, 2000, 200])
  const direction = view.camera.getWorldDirection(new Vector3())
  assert.ok(direction.dot(view.target.clone().sub(view.camera.position).normalize()) > 0.99999)
  const shift = new Vector3(3000, 0, 0)
  view.update(position.clone().sub(shift), new Vector3(0, 0, -150), up, 1000, true)
  assert.deepEqual(view.target.toArray(), [-2900, 2000, -1600])
  assert.equal(view.update(position, new Vector3(0, 100, 0), up, 1000, true), false)
  assert.equal(view.update(position, new Vector3(150, 0, 0), up, 1000, false), false)
})

test('prefetch distance and far plane remain bounded at extreme speed and altitude', () => {
  const view = new FlightPrefetch()
  view.update(new Vector3(0, 50000, 0), new Vector3(2000, 0, 0), new Vector3(0, 1, 0), 50000, true)
  assert.equal(view.target.x, 6000)
  assert.equal(view.camera.far, 80000)
})

const lakes = JSON.parse(readFileSync(new URL('../public/water/great-lakes.json', import.meta.url), 'utf8'))

test('Lake Michigan water uses lake elevation and local geoid, with curved outward triangles', () => {
  const lake = lakes.find(l => l.name === 'Lake Michigan')
  assert.equal(lakes.length, 5)
  assert.equal(distanceToLake(lake, 41.9503, -87.6326), 0)
  assert.ok(distanceToLake(lake, 30, -110) > 1000000)
  assert.ok(lakeGeoid(lake, -87.6326, 41.9503) < -30)
  const { geometry: g, origin } = buildLakeGeometry(lake)
  try {
    const p = g.getAttribute('position'), n = g.getAttribute('normal'), idx = g.index.array
    const a = new Vector3(), b = new Vector3(), c = new Vector3(), ab = new Vector3(), ac = new Vector3(), normal = new Vector3()
    for (let i = 0; i < p.count; i++) {
      a.fromBufferAttribute(p, i).add(origin)
      const geo = ecefToGeodetic(a.x, a.y, a.z)
      assert.ok(Math.abs(geo.height - lakeGeoid(lake, geo.lon, geo.lat) - lake.levelM - 0.75) < 0.04)
    }
    for (let i = 0; i < idx.length; i += 3) {
      a.fromBufferAttribute(p, idx[i]); b.fromBufferAttribute(p, idx[i + 1]); c.fromBufferAttribute(p, idx[i + 2])
      normal.fromBufferAttribute(n, idx[i])
      ab.subVectors(b, a); ac.subVectors(c, a)
      assert.ok(ab.clone().cross(ac).dot(normal) >= -0.01)
      assert.ok(Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)) < 2010)
    }
  } finally { g.dispose() }
})

test('lake triangulation leaves islands dry', () => {
  const lake = { name: 'test', levelM: 100, bounds: [0, 0, 0.02, 0.02],
    geoid: { west: 0, north: 1, columns: 2, rows: 2, values: [0, 0, 0, 0] },
    polygons: [[[[0, 0], [0.02, 0], [0.02, 0.02], [0, 0.02], [0, 0]],
      [[0.005, 0.005], [0.005, 0.015], [0.015, 0.015], [0.015, 0.005], [0.005, 0.005]]]] }
  const { geometry: g, origin } = buildLakeGeometry(lake, 200)
  try {
    const p = g.getAttribute('position'), idx = g.index.array
    for (let i = 0; i < idx.length; i += 3) {
      const centre = new Vector3()
      for (let j = 0; j < 3; j++) centre.add(new Vector3().fromBufferAttribute(p, idx[i + j]))
      centre.multiplyScalar(1 / 3).add(origin)
      const { lat, lon } = ecefToGeodetic(centre.x, centre.y, centre.z)
      assert.ok(!(lat > 0.005 && lat < 0.015 && lon > 0.005 && lon < 0.015))
    }
  } finally { g.dispose() }
})

function setup() {
  const camera = new PerspectiveCamera(58, 1.6, 0.3, 2e7)
  const effect = new CloudsEffect(camera)
  stabilizeClouds(effect)
  effect.temporalUpscale = false
  effect.setSize(1280, 800)
  const history = new CloudHistory()
  const update = (origin = 1, mode = 'chase', quality = 'high') => history.update(effect, camera, origin, mode, quality)
  const isReset = () => {
    const cloud = effect.cloudsPass.resolveMaterial.uniforms.resetHistory.value
    assert.equal(effect.shadowPass.resolveMaterial.uniforms.resetHistory.value, cloud)
    return cloud
  }
  return { camera, effect, history, update, isReset }
}

test('compatibility patches apply to the installed cloud shaders and are idempotent', () => {
  const { effect } = setup()
  try {
    const materials = [effect.cloudsPass.currentMaterial, effect.cloudsPass.resolveMaterial,
      effect.shadowPass.currentMaterial, effect.shadowPass.resolveMaterial]
    const sources = materials.map(material => material.fragmentShader)
    stabilizeClouds(effect)
    assert.deepEqual(materials.map(material => material.fragmentShader), sources)
    for (const source of sources) assert.match(source, /precision highp sampler2D;/)
    assert.match(sources[0], /min\(depthVelocity.x, 65000.0\)/)
    assert.match(sources[0], /if \(frontDepth > 1.0\)/)
    assert.match(sources[1], /isnan\(historyColor\)/)
    assert.match(sources[3], /isnan\(history\)/)
  } finally { effect.dispose() }
})

test('normal flight accumulates history after the first frame', () => {
  const { effect, camera, update, isReset } = setup()
  try {
    update()
    assert.equal(isReset(), true)
    camera.position.x += 8
    camera.rotateY(0.02)
    update()
    assert.equal(isReset(), false)
  } finally { effect.dispose() }
})

test('reloading the patch module preserves already-patched live effects', async () => {
  const { effect } = setup()
  try {
    const source = effect.cloudsPass.currentMaterial.fragmentShader
    const freshModule = await import('../src/scene/cloudRendering.ts?reload-test')
    freshModule.stabilizeClouds(effect)
    assert.equal(effect.cloudsPass.currentMaterial.fragmentShader, source)
  } finally { effect.dispose() }
})

for (const [name, change] of [
  ['floating-origin rebase', () => [2, 'chase']],
  ['camera mode change', () => [1, 'cockpit']],
  ['quality change', () => [1, 'chase', 'medium']],
  ['teleport', ({ camera }) => { camera.position.x += 3000 }],
  ['camera cut', ({ camera }) => { camera.rotateY(Math.PI) }],
  ['resize', ({ effect }) => effect.setSize(1920, 1080)],
  ['cloud coverage change', ({ effect }) => { effect.coverage = 0.8 }],
]) {
  test(`${name} discards both histories for one frame, then resumes accumulation`, () => {
    const state = setup()
    try {
      state.update()
      state.update()
      assert.equal(state.isReset(), false)
      const args = change(state) ?? []
      state.update(...args)
      assert.equal(state.isReset(), true)
      state.update(...args)
      assert.equal(state.isReset(), false)
    } finally { state.effect.dispose() }
  })
}

test('turning clouds back on rejects the previous effect’s history', () => {
  const { effect, camera, history, update } = setup()
  const replacement = new CloudsEffect(camera)
  try {
    update()
    update()
    stabilizeClouds(replacement)
    history.update(replacement, camera, 1, 'chase', 'high')
    assert.equal(replacement.cloudsPass.resolveMaterial.uniforms.resetHistory.value, true)
  } finally {
    effect.dispose()
    replacement.dispose()
  }
})
