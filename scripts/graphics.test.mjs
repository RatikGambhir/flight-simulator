import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CloudsEffect } from '@takram/three-clouds'
import { BoxGeometry, Color, Group, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, PerspectiveCamera, ShaderLib, Texture, Vector3 } from 'three'
import { TerrainNormalPass } from '../src/scene/TerrainNormalPass.ts'
import { EffectPass } from 'postprocessing'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { CloudHistory, driftCloudField, setCloudNightLighting, stabilizeClouds, stabilizeNightClouds } from '../src/scene/cloudRendering.ts'
import { hingeFrame, setHingeAngle, wingPanelGeometry, wingPoint, wingUpperPoint } from '../src/aircraft/geometry.ts'
import { FlightPrefetch } from '../src/world/flightPrefetch.ts'
import { buildLakeGeometry, distanceToLake, lakeGeoid } from '../src/scene/lakeGeometry.ts'
import { ecefToGeodetic, frame, geodeticToEcef } from '../src/world/frame.ts'
import { WaterCoordinates } from '../src/scene/WaterCoordinates.ts'
import { MAX_LAMPS, NightEffect } from '../src/scene/NightEffect.ts'
import { CockpitLighting } from '../src/aircraft/cockpitLighting.ts'
import { CLOUD_LEVELS, cloudBudget, initialCloudLevel, MAX_RENDER_PIXELS, sceneDpr } from '../src/scene/renderBudget.ts'
import { BASE_EXPOSURE, twilightExposure } from '../src/scene/exposure.ts'

test('cached cloud formations drift coherently in metres independent of frame rate', () => {
  const effects = [new CloudsEffect(new PerspectiveCamera()), new CloudsEffect(new PerspectiveCamera())]
  try {
    for (let i = 0; i < effects.length; i++) {
      const effect = effects[i]
      stabilizeClouds(effect)
      const hz = i === 0 ? 30 : 120
      for (let frame = 0; frame < hz * 2; frame++) driftCloudField(effect, new Vector3(5, -2, 0), 1 / hz)
      const field = effect.cloudsPass.currentMaterial.uniforms.cloudFieldOffset
      assert.ok(field.value.distanceTo(new Vector3(-10, 4, 0)) < 1e-10)
      assert.equal(field, effect.shadowPass.currentMaterial.uniforms.cloudFieldOffset)
      assert.equal(effect.shapeVelocity.length(), 0)
      assert.equal(effect.shapeDetailVelocity.length(), 0)
      const before = field.value.clone()
      driftCloudField(effect, new Vector3(), 1 / hz)
      assert.ok(field.value.equals(before), 'calm air leaves the cached cloud field fixed')
      driftCloudField(effect, new Vector3(5, 0, 0), 30)
      assert.ok(field.value.distanceTo(before) <= 0.5, 'resuming after a pause cannot jump the cloud field')
    }
  } finally { effects.forEach(effect => effect.dispose()) }
})

test('cloud jitter uses the verified upstream blue-noise volume rather than patterned fallback noise', () => {
  const bytes = readFileSync(new URL('../public/clouds/stbn.bin', import.meta.url))
  assert.equal(bytes.length, 128 * 128 * 64)
  assert.equal(createHash('sha256').update(bytes).digest('hex'),
    '51f52f21e5578384585050390821a0a486dcb81e11a716fa7b92fbb6515ba852')
})

test('water coordinates follow distant locations without stretching and survive local rebases', () => {
  const original = frame.origin.clone()
  const water = new WaterCoordinates()
  try {
    for (const [lat, lon] of [[41.98, -87.9], [35.55, 139.79], [37.55, -123.25], [-33.95, 151.18], [78.2, 15.6]]) {
      const origin = geodeticToEcef(lat, lon, 100)
      frame.setOrigin(origin.x, origin.y, origin.z)
      water.update(frame)
      const base = new Vector3().applyMatrix4(water.matrix)
      const east = new Vector3(100, 0, 0).applyMatrix4(water.matrix).sub(base)
      const south = new Vector3(0, 0, 100).applyMatrix4(water.matrix).sub(base)
      assert.ok(Math.abs(Math.hypot(east.x, east.z) - 100) < 1e-6, `${lat},${lon}: east scale`)
      assert.ok(Math.abs(Math.hypot(south.x, south.z) - 100) < 1e-6, `${lat},${lon}: south scale`)
      assert.ok(Math.abs(east.x * south.x + east.z * south.z) < 1e-6, 'wave axes stay orthogonal')
      assert.ok(base.length() < 1e-5, 'GPU wave coordinates stay local, not Earth-sized')
      const sample = new Vector3(1500, -100, -2500)
      const ecef = frame.worldToEcef(sample)
      const before = sample.clone().applyMatrix4(water.matrix)
      const shifted = frame.worldToEcef(new Vector3(1400, 0, 1400))
      frame.setOrigin(shifted.x, shifted.y, shifted.z)
      water.update(frame)
      const after = frame.ecefToWorld(ecef.x, ecef.y, ecef.z).applyMatrix4(water.matrix)
      assert.ok(before.distanceTo(after) < 1e-7, 'ordinary origin shifts do not move the waves')
    }
  } finally { frame.setOrigin(original.x, original.y, original.z) }
})

test('scene resolution matches the display and never drops to 1x on Retina at 100% scale', () => {
  const window1600 = 1600 * 960
  // A 2x display renders near native at high and exactly native at ultra.
  const high = sceneDpr('high', 1, 2, window1600, false)
  assert.ok(high > 1.8 && high <= 2, `high on Retina: ${high}`)
  assert.equal(sceneDpr('ultra', 1, 2, window1600, false), 2)
  assert.ok(window1600 * high ** 2 <= MAX_RENDER_PIXELS.high + 1)
  // A full-screen 14" MacBook Pro still renders well above 1x.
  assert.ok(sceneDpr('high', 1, 2, 1728 * 1117, false) > 1.6)
  // Never upsample past the display, and honour the explicit render-scale setting.
  assert.equal(sceneDpr('ultra', 1, 1, window1600, false), 1)
  assert.equal(sceneDpr('high', 0.5, 2, window1600, false), 1, 'render scale applies before the pixel budget')
  assert.equal(sceneDpr('high', 0.75, 2, window1600, false), 1.5)
  // The menu preview is a 1x, 30 FPS background.
  assert.equal(sceneDpr('high', 1, 2, window1600, true), 1)
})

test('adaptive detail only trades cloud work, monotonically, within sane bounds', () => {
  for (const quality of ['low', 'medium', 'high', 'ultra']) {
    let previous = null
    for (let level = 0; level < CLOUD_LEVELS.length; level++) {
      const b = cloudBudget(quality, level)
      assert.ok(b.resolutionScale > 0.15 && b.resolutionScale <= 1, `${quality} ${level} resolution`)
      assert.ok(b.minStepSize >= 30 && b.minStepSize <= 200)
      assert.equal(b.shadowMapSize % 64, 0)
      assert.ok(b.perspectiveStepScale >= 1.01 && b.perspectiveStepScale <= 1.04)
      if (previous) {
        assert.ok(b.resolutionScale <= previous.resolutionScale)
        assert.ok(b.minStepSize >= previous.minStepSize)
        assert.ok(b.shadowMapSize <= previous.shadowMapSize)
      }
      previous = b
    }
  }
  // Out-of-range levels clamp rather than producing undefined budgets.
  assert.deepEqual(cloudBudget('high', 99), cloudBudget('high', CLOUD_LEVELS.length - 1))
  assert.deepEqual(cloudBudget('high', -3), cloudBudget('high', 0))
  assert.equal(initialCloudLevel(2e6), 0)
  assert.equal(initialCloudLevel(5e6), 1)
  assert.equal(initialCloudLevel(8e6), 2)
})

test('night cockpit lighting dims shared materials once and restores original daytime values', () => {
  const root = new Group(), geometry = new BoxGeometry(), texture = new Texture()
  const panel = new MeshStandardMaterial({ emissiveIntensity: 0.22 })
  const display = new MeshBasicMaterial({ map: texture, color: '#e0e0e0' })
  const original = display.color.clone()
  root.add(new Mesh(geometry, [panel, display]), new Mesh(geometry, [panel, display]))
  const lighting = new CockpitLighting(root)
  try {
    lighting.update(1)
    assert.ok(panel.emissiveIntensity > 0 && panel.emissiveIntensity < 0.05)
    assert.ok(display.color.r > 0 && display.color.r < original.r * 0.2)
    const dim = display.color.clone()
    lighting.update(1)
    assert.ok(display.color.equals(dim), 'repeated frames must not compound dimming')
    lighting.update(0.5)
    assert.ok(display.color.r > dim.r && display.color.r < original.r)
    lighting.update(0)
    assert.equal(panel.emissiveIntensity, 0.22)
    assert.ok(display.color.equals(original))
  } finally { geometry.dispose(); panel.dispose(); display.dispose(); texture.dispose() }
})

test('night lamps use native log depth so nearby geometry actually hides them', () => {
  const effect = new NightEffect()
  const camera = new PerspectiveCamera(58, 1.6, 0.3, 2e7)
  camera.updateMatrixWorld()
  const lamp = { position: new Vector3(0, 0, -50), color: new Color('red'), intensity: 1, size: 1 }
  const pass = new EffectPass(camera, effect)
  try {
    effect.setFrame(camera, 1, 0, new Vector3(0, 1, 0), [lamp])
    const at = effect.uniforms.get('lampAt').value[0]
    const logDepth = distance => Math.log2(1 + distance) / Math.log2(camera.far + 1)
    assert.ok(at.z > logDepth(40), 'an aircraft surface 10m in front must hide the lamp')
    assert.ok(at.z < logDepth(60), 'terrain behind the lamp must not hide it')
    assert.ok(at.z < logDepth(50), 'the emitter bias must clear its own housing')
    // Verify the compiled effect compares the same representation, rather than
    // postprocessing's readDepth(), which silently returns perspective depth.
    pass.recompile()
    const shader = pass.fullscreenMaterial.fragmentShader
    assert.match(shader, /step\(at.z,\s*\w*SceneDepth\(at.xy\)\)/)
    assert.match(shader, /depth < 1.0/)
    assert.match(shader, /texture2D\(\w*SceneAlbedo, uv\)/)
    assert.equal(effect.uniforms.get('sceneAlbedo').value, effect.albedoPass.texture)
    assert.doesNotMatch(shader, /smoothstep\(0.0, -0.03/)
    assert.ok(logDepth(100000) < 1, '100km terrain remains geometry, not sky')
  } finally { pass.dispose() }
})

test('lamp projection follows the camera, rejects offscreen lights and clears stale lamps', () => {
  const effect = new NightEffect()
  const camera = new PerspectiveCamera(70, 2, 0.3, 2000)
  camera.position.set(100, 200, 300)
  camera.rotateY(0.7)
  camera.updateMatrixWorld()
  const lamp = (x, y, z, intensity = 1) => ({
    position: new Vector3(x, y, z).applyMatrix4(camera.matrixWorld),
    color: new Color('red'), intensity, size: 1,
  })
  try {
    const visible = lamp(8, 4, -50)
    effect.setFrame(camera, 1, 0, new Vector3(0, 1, 0), [
      lamp(0, 0, 10), lamp(500, 0, -50), lamp(0, 0, -3000), lamp(0, 0, -50, 0), visible,
    ])
    assert.equal(effect.uniforms.get('lampCount').value, 1)
    const projected = visible.position.clone().project(camera)
    const at = effect.uniforms.get('lampAt').value[0]
    assert.ok(Math.abs(at.x - (projected.x + 1) / 2) < 1e-12)
    assert.ok(Math.abs(at.y - (projected.y + 1) / 2) < 1e-12)
    effect.setFrame(camera, 1, 1, new Vector3(0, 1, 0), Array(MAX_LAMPS + 5).fill(visible))
    assert.equal(effect.uniforms.get('lampCount').value, MAX_LAMPS)
    assert.equal(effect.albedoPass.enabled, true)
    effect.setFrame(camera, 0, 1, new Vector3(0, 1, 0), [])
    assert.equal(effect.uniforms.get('lampCount').value, 0)
    assert.equal(effect.uniforms.get('night').value, 0)
    assert.equal(effect.albedoPass.enabled, false)
  } finally { effect.dispose() }
})

test('terrain night fill shares the lighting mask and releases it on unmount', () => {
  const effect = new NightEffect(), texture = new Texture()
  try {
    effect.setLightingMask(texture)
    assert.equal(effect.uniforms.get('lightingMask').value, texture)
    assert.equal(effect.uniforms.get('hasLightingMask').value, true)
    effect.setLightingMask(null)
    assert.equal(effect.uniforms.get('lightingMask').value, null)
    assert.equal(effect.uniforms.get('hasLightingMask').value, false)
  } finally { effect.dispose(); texture.dispose() }
})

test('night lighting reads the current cloud resolve after the buffer swaps', () => {
  const a = new Texture(), b = new Texture()
  let current = a
  const effect = new NightEffect(undefined, undefined, () => current)
  try {
    for (const texture of [a, b, null]) {
      current = texture
      effect.update()
      assert.equal(effect.uniforms.get('cloudOverlay').value, texture)
      assert.equal(effect.uniforms.get('hasCloudOverlay').value, texture !== null)
    }
  } finally { effect.dispose(); a.dispose(); b.dispose() }
})

test('night terrain reconstruction keeps city lights fixed through a floating-origin shift', () => {
  const ecefFromWorld = new Matrix4().makeTranslation(6378137, 0, 0)
  const effect = new NightEffect(ecefFromWorld)
  const camera = new PerspectiveCamera(58, 1.6, 0.3, 2e7)
  const target = new Vector3(12, -3600, -16000)
  const up = new Vector3(0, 1, 0)
  const expectedEcef = target.clone().applyMatrix4(ecefFromWorld)
  const uniform = key => effect.uniforms.get(key).value
  try {
    for (const shift of [0, 3000]) {
      ecefFromWorld.makeTranslation(6378137, 0, shift)
      camera.position.set(20, 5, -shift)
      camera.updateMatrixWorld()
      const point = target.clone().sub(new Vector3(0, 0, shift))
      effect.setFrame(camera, 1, 0, up, [], 3600)
      const ndc = point.clone().project(camera)
      const logDepth = Math.log2(1 - point.clone().applyMatrix4(camera.matrixWorldInverse).z) / uniform('logFar')
      const reconstructed = uniform('viewForward').clone()
        .addScaledVector(uniform('viewRight'), ndc.x)
        .addScaledVector(uniform('viewUp'), ndc.y)
        .multiplyScalar(2 ** (logDepth * uniform('logFar')) - 1)
        .add(uniform('eyePosition'))
        .applyMatrix4(uniform('ecefFromWorld'))
      assert.ok(reconstructed.distanceTo(expectedEcef) < 0.001)
      assert.equal(uniform('night'), 1, 'city lights remain visible on moonless nights')
      assert.ok(uniform('horizonDip') > 0.03, 'the horizon drops below eye level at cruise altitude')
    }
  } finally { effect.dispose() }
})

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
    // Every ray samples the same shells of distance from the camera, clipped to the ray
    // (so rays that end on nearby geometry are integrated exactly), and never takes its
    // sample positions from per-frame noise or from where it entered the cloud shell.
    const primaryMarch = sources[0].split('vec4 marchClouds(')[1].split('float marchShadowLength(')[0]
    assert.match(sources[0], /float marchLatticeFloor\(const float t\)/)
    assert.match(primaryMarch, /float cellStart = marchLatticeFloor\(rayNearFar\.x\);/)
    assert.match(primaryMarch, /float cellStep = min\(maxStepSize, minStepSize \+ growth \* cellFrom\);/,
      'horizon rays must not grow unbounded')
    assert.match(primaryMarch, /stepSize = min\(cellStart, rayNearFar\.y\) - segmentStart;/)
    assert.doesNotMatch(primaryMarch, /stepSize \*= perspectiveStepScale|jitter \* 2\.0|rayDistance \+= /,
      'no step may depend on noise or on the ray\'s own entry point')
    // Strides only cross the gaps between layers, and the last one is always retraced.
    assert.equal(primaryMarch.split('strideEnd = segmentStart + maxStepSize').length, 2)
    assert.match(primaryMarch, /#endif \/\/ !defined\(DEBUG_MARCH_INTERVALS\)\s*if \(rewindTo >= 0\.0\) \{\s*fineUntil = cellStart;\s*cellStart = rewindTo;/)
    assert.match(primaryMarch, /if \(!any\(greaterThan\(weather\.density, vec4\(minDensity\)\)\)\) \{[^}]*\n\s*continue;\s*\}/)
    // Each cell is probed three times and lit once, where its visible cloud lies; the
    // cloud around the camera is thinned so the aircraft stays readable inside an overcast.
    assert.match(primaryMarch, /for \(int probeIndex = 0; probeIndex < 3; \+\+probeIndex\)/)
    assert.match(primaryMarch, /float nearClear = smoothstep\(0.0, 250.0, rayNearFar.x \+ probeDistance\);/)
    assert.match(primaryMarch, /rayDistance = seenDistance \/ seen;\s*position = rayDistance \* rayDirection \+ rayOrigin;/)
    assert.match(primaryMarch, /media\.extinction = opticalDepth \/ stepSize;/)
    // Low sun: cloud with an open view downward sheds the deck's far shadow, and the
    // warm glow around the sun is split from the rest of the sky light. Both fade out
    // with the sun well up, so daylight is untouched.
    assert.match(sources[0], /float lowSun = 1\.0 - smoothstep\(0\.0175, 0\.1564, dot\(sunDirection, surfaceNormal\)\);/)
    assert.match(sources[0], /opticalDepth \+= shadowDepth \* \(1\.0 - lowSun \* underside\);/)
    assert.match(sources[0], /underside = mix\(exp\(-groundOpticalDepth\), underside, smoothstep\(0\.3, 0\.5, mipLevel\)\);/)
    assert.equal(sources[0].split('approximateRadianceFromGround(').length, 3, 'the ground march runs once per lit cell')
    assert.match(sources[0], /vec3 warmSky = min\(vTwilightGlow, skyIrradiance\);/)
    assert.match(sources[0], /\(skyIrradiance - warmSky\) \* skyGradient \+ warmSky \* mix\(0\.25, 2\.2, facingGlow\)/)
    const vertex = effect.cloudsPass.currentMaterial.vertexShader
    assert.match(vertex, /vTwilightGlow = twilightGlow\(vCameraPosition \+ altitudeCorrection\);/)
    assert.match(vertex, /float lowSun = 1\.0 - smoothstep\(0\.1045, 0\.2419, elevation\);/)
    assert.equal(vertex.split('vec3 twilightGlow(').length, 2, 'patched once')
    // The noise a ray uses is fixed to its full-resolution pixel, not to the frame.
    assert.match(sources[0], /float stbn = stableNoise\(\);/)
    assert.match(sources[0], /vec3\(gl_FragCoord\.xy \* 4\.0 \+ temporalJitter \* resolution, 0\.5\) \* scale/)
    assert.match(sources[0], /color\.rgb = color\.rgb \* \(1\.0 - haze\.a\) \+ haze\.rgb;/,
      'haze radiance is already premultiplied by its opacity')
    assert.doesNotMatch(sources[0], /density \/ hazeExponent \/ angle/,
      'horizon haze must remain well-conditioned for grazing rays')
    assert.doesNotMatch(sources[2], /nearClear/, 'cloud shadows keep their full density')
    // Temporal upscaling: rejected and near pixels use a depth-aware, jitter-aligned
    // reconstruction of the current frame, never one low-resolution texel per 4x4 block.
    const [upscale, taa] = sources[1].split('void temporalAntialiasing(')
    assert.match(upscale, /upscaleWeights\(vUv, center, base, weights, nearest\)/)
    assert.match(upscale, /bool near = center < nearHistoryDepth;/)
    assert.match(upscale, /outputColor = spatialColor;/)
    // History is read where the camera's move and the wind's drift put the cloud last
    // frame, on every frame, whether or not a march ran. Offsetting it by the per-frame
    // jitter slid the whole cloud image a different way every frame (a shaking horizon).
    assert.match(upscale, /vec4 prevClip = historyClipFromView \* vec4\(viewPoint, 1\.0\);/)
    // The pixel's ray comes from its point on the near plane. On the far plane (20,000 km)
    // the unprojected w is the difference of two nearly equal single-precision numbers:
    // zero with the cockpit's 3 cm near plane, so every pixel's history was rejected.
    assert.match(upscale, /vec4 nearPoint = viewFromClip \* vec4\(vUv \* 2\.0 - 1\.0, -1\.0, 1\.0\);/)
    for (const near of [0.03, 0.3]) {
      const inverse = new Float32Array(new PerspectiveCamera(58, 1.6, near, 2e7).projectionMatrixInverse.elements)
      const w = (z) => Math.fround(Math.fround(inverse[11] * z) + inverse[15])
      assert.ok(Math.abs(w(-1) * near - 1) < 1e-4, 'the near plane unprojects exactly')
      assert.ok(Math.abs(w(1)) < 1e-5, 'the far plane does not survive single precision')
    }
    assert.match(upscale, /depthVelocity\.r - cloudDriftView;/)
    assert.doesNotMatch(upscale, /prevUv[^;]*jitterOffset|depthVelocity\.gb/)
    assert.doesNotMatch(upscale, /getClosestFragment\(lowResCoord\)/, 'cloud never inherits the aircraft\'s motion')
    assert.match(upscale, /step\(nearHistoryDepth, depth\)/, 'history is not clipped to cloud cut short by the aircraft')
    // A pixel takes the sample marched through it outright, and only on a frame that
    // marched; a still image is neither clipped nor eased, so it cannot change.
    assert.match(upscale, /float fresh = step\(freshRows\.x, ownRow\) \* step\(ownRow, freshRows\.y\) \*/)
    assert.match(upscale, /outputColor = mix\(historyColor, freshColor, fresh\);/)
    assert.match(upscale, /historyColor = mix\(historyColor, mix\(clippedColor, spatialColor, upscaleFreshWeight\), moving\);/)
    assert.match(upscale, /if \(moving > 0\.0 \|\| horizonFilter > 0\.0\) \{/)
    assert.match(upscale, /outputColor = spatialColor \* nearFade;/)
    assert.match(upscale, /clippedColor.a = clamp/)
    assert.doesNotMatch(upscale, /pow\(nearest, 4.0\)/)
    assert.equal(effect.cloudsPass.resolveMaterial.uniforms.upscaleFreshWeight.value, 0.08)
    assert.equal(effect.cloudsPass.resolveMaterial.uniforms.varianceGamma.value, 2)
    assert.doesNotMatch(upscale, /outputColor = currentColor;\s*#ifdef SHADOW_LENGTH\s*outputShadowLength = currentShadowLength.r;\s*#endif \/\/ SHADOW_LENGTH\s*return; \/\/ Rejection/)
    assert.doesNotMatch(taa, /spatialColor/)
    assert.ok(effect.cloudsPass.resolveMaterial.uniforms.sceneDepthBuffer)
  } finally { effect.dispose() }
})

test('the cloud shadow maps and the cloud march take turns, and nothing waits after a cut or a rebase', () => {
  const camera = new PerspectiveCamera(58, 1.6, 0.3, 2e7)
  const effect = new CloudsEffect(camera)
  try {
    // Count the library's own work underneath the pacing.
    const ran = { fit: 0, shadows: 0, march: 0, resolve: 0 }
    const frames = []
    effect.shadowMaps.update = () => { ran.fit++ }
    effect.shadowPass.update = () => { ran.shadows++ }
    const scissors = []
    effect.cloudsPass.currentPass.render = () => {
      ran.march++
      const target = effect.cloudsPass.currentRenderTarget
      scissors.push(target.scissorTest ? `${target.scissor.y}+${target.scissor.w}` : 'all')
    }
    effect.cloudsPass.update = function (_renderer, frame) {
      frames.push(frame)
      this.currentPass.render()
      ran.resolve++
    }
    stabilizeClouds(effect)
    const resolve = effect.cloudsPass.resolveMaterial.uniforms
    const target = effect.cloudsPass.currentRenderTarget
    target.setSize(64, 40)
    const fresh = []
    const frame = () => {
      effect.shadowMaps.update(camera, new Vector3(0, 1, 0))
      effect.shadowPass.update(null, 0, 0)
      effect.cloudsPass.update(null, 0, 0)
      fresh.push(resolve.freshRows.value.toArray().join('-'))
    }
    resolve.resetHistory.value = true
    frame()
    assert.deepEqual(ran, { fit: 1, shadows: 1, march: 1, resolve: 1 }, 'the first frame draws everything')
    resolve.resetHistory.value = false
    effect.shadowPass.resolveMaterial.uniforms.resetHistory.value = false
    for (let i = 0; i < 8; i++) frame()
    assert.deepEqual(ran, { fit: 3, shadows: 3, march: 7, resolve: 9 },
      'then the lower half of the march, its upper half and the shadow maps take a frame each')
    assert.deepEqual(fresh, ['0-1', '0-0.5', '0.5-1', '2-2', '0-0.5', '0.5-1', '2-2', '0-0.5', '0.5-1'],
      'the resolve only takes samples from the rows marched this frame')
    assert.deepEqual(frames, [1, 2, 2, 2, 3, 3, 3, 4, 4], 'the sample position advances once per whole march')
    // Each half of the target is reconstructed with the position it was marched at,
    // which is the library's own jitter for that march frame.
    const libraryJitter = (marchFrame) => {
      resolve.frame.value = marchFrame
      effect.cloudsPass.resolveMaterial.onBeforeRender()
      return resolve.jitterOffset.value.toArray()
    }
    assert.deepEqual(resolve.halfJitter.value.toArray(), [...libraryJitter(4), ...libraryJitter(4)])
    frame()
    assert.deepEqual(resolve.halfJitter.value.toArray(), [...libraryJitter(4), ...libraryJitter(4)])
    frame()
    assert.deepEqual(resolve.halfJitter.value.toArray(), [...libraryJitter(5), ...libraryJitter(4)],
      'a new position starts in the lower half while the upper still holds the last')
    assert.notDeepEqual(libraryJitter(5), libraryJitter(4))
    assert.equal(resolve.halfSplit.value, 0.5)
    assert.deepEqual(scissors.slice(0, 5), ['all', '0+20', '20+20', '0+20', '20+20'])
    assert.equal(target.scissorTest, false)
    // A cut (history reset) and a floating-origin rebase both run everything at once.
    resolve.resetHistory.value = true
    frame()
    resolve.resetHistory.value = false
    assert.deepEqual(ran, { fit: 5, shadows: 5, march: 9, resolve: 12 })
    assert.equal(fresh.at(-1), '0-1')
    const history = new CloudHistory()
    effect.setSize(1280, 800)
    history.update(effect, camera, 1, 'chase', 'high')
    resolve.resetHistory.value = false
    frame()
    const before = { ...ran }
    history.rebase(new Matrix4().makeTranslation(1400, 0, -900), 2)
    frame()
    assert.deepEqual(ran, { fit: before.fit + 1, shadows: before.shadows + 1, march: before.march + 1, resolve: before.resolve + 1 },
      'a march never reads shadow cascades fitted in the old world frame')
    // The resolve reprojects through last frame's camera, moved with the world on a rebase.
    camera.position.set(30, 0, 0)
    camera.updateMatrixWorld()
    frame()
    const reprojected = new Vector3(0, 0, -1000).applyMatrix4(resolve.historyClipFromView.value)
    const expected = new Vector3(30, 0, -1000).applyMatrix4(camera.projectionMatrix)
    assert.ok(reprojected.distanceTo(expected) < 1e-9)
  } finally { effect.dispose() }
})

test('exposure opens up through sunset and twilight only, continuously, and less under an open sky', () => {
  const sin = (degrees) => Math.sin(degrees * Math.PI / 180)
  assert.equal(BASE_EXPOSURE, 10)
  // Daylight and full night keep the exposure everything else is balanced against.
  for (const degrees of [90, 45, 12, -10.5, -18, -90]) assert.equal(twilightExposure(sin(degrees)), 1)
  for (const open of [0, 1]) assert.equal(twilightExposure(sin(30), open), 1)
  let previous = twilightExposure(sin(-12))
  let peak = 0
  let peakAt = 0
  for (let degrees = -12; degrees <= 14; degrees += 0.05) {
    const gain = twilightExposure(sin(degrees))
    assert.ok(Math.abs(gain - previous) < 0.03, `no jump at ${degrees.toFixed(2)} deg`)
    assert.ok(gain >= 1)
    if (gain > peak) { peak = gain; peakAt = degrees }
    // Under an open sky the bright glow is in view: half the lift, never less than none.
    const open = twilightExposure(sin(degrees), 1)
    assert.ok(Math.abs(open - (1 + (gain - 1) / 2)) < 1e-9)
    previous = gain
  }
  assert.ok(peak > 3 && peak < 4 && peakAt < 0 && peakAt > -6, 'the lift peaks in civil twilight')
  assert.ok(twilightExposure(sin(1)) > 2.5, 'a sunset under cloud is no longer near-black')
  assert.equal(twilightExposure(NaN), 1)
})

test('the march iteration limit reaches the far end of the longest ray at every quality and level', () => {
  for (const quality of ['low', 'medium', 'high', 'ultra']) {
    for (let level = 0; level < CLOUD_LEVELS.length; level++) {
      const b = cloudBudget(quality, level)
      let distance = 0
      let cells = 0
      const reach = quality === 'low' ? 1e5 : 2e5
      while (distance < reach) {
        distance += Math.min(1000, b.minStepSize + (b.perspectiveStepScale - 1) * distance)
        cells++
      }
      assert.ok(b.maxIterationCount >= cells, `${quality} L${level}: ${b.maxIterationCount} < ${cells}`)
      assert.ok(b.maxIterationCount <= cells + 64, `${quality} L${level} marches further than it shows`)
    }
  }
})

test('terrain normal pass draws displaced tiles with bump-mapped normals and always restores materials', () => {
  const geometry = new BoxGeometry()
  const height = new Texture()
  const terrainMaterial = new MeshBasicMaterial()
  Object.assign(terrainMaterial, { displacementMap: height, displacementScale: 1.5, displacementBias: -2 })
  const plain = new MeshBasicMaterial()
  const tiles = new Group()
  const tile = new Mesh(geometry, terrainMaterial)
  const other = new Mesh(geometry, plain)
  tiles.add(tile, other)
  const camera = new PerspectiveCamera()
  const pass = new TerrainNormalPass(camera)
  pass.roots = [tiles]
  const drawn = []
  let fail = false
  const renderer = {
    autoClear: true, shadowMap: { autoUpdate: true },
    getClearAlpha: () => 1, getClearColor: (c) => c.set(0x123456), setClearColor() {}, setRenderTarget() {}, clear() {},
    render(root) {
      drawn.push([root, tile.material, other.material])
      if (fail) throw new Error('lost context')
    },
  }
  try {
    pass.render(renderer)
    const [root, tileMaterial, otherMaterial] = drawn[0]
    assert.equal(root, tiles)
    assert.ok(tileMaterial.isMeshNormalMaterial)
    assert.equal(tileMaterial.displacementMap, height)
    assert.equal(tileMaterial.bumpMap, height, 'slopes come from the same elevation texture')
    assert.equal(tileMaterial.displacementScale, 1.5)
    assert.equal(tileMaterial.displacementBias, -2)
    assert.equal(tileMaterial.bumpScale, 1.5)
    assert.equal(otherMaterial, plain, 'undisplaced objects are left alone')
    assert.equal(tile.material, terrainMaterial)
    assert.equal(renderer.autoClear, true)
    assert.equal(renderer.shadowMap.autoUpdate, true)
    // The tile material is cached rather than rebuilt every frame.
    pass.render(renderer)
    assert.equal(drawn[1][1], tileMaterial)
    fail = true
    assert.throws(() => pass.render(renderer))
    assert.equal(tile.material, terrainMaterial, 'restored even when rendering throws')
    // The bump patch targets a chunk the installed normal material still includes.
    const shader = { fragmentShader: '#include <bumpmap_pars_fragment>\nvoid main() {}', vertexShader: '' }
    tileMaterial.onBeforeCompile(shader)
    assert.match(shader.fragmentShader, /gradU \* dSTdx.x/)
    assert.match(ShaderLib.normal.fragmentShader, /#include <bumpmap_pars_fragment>/)
  } finally { pass.dispose(); geometry.dispose(); terrainMaterial.dispose(); plain.dispose(); height.dispose() }
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

test('time-of-day jumps reject cloud history even when both times are daylight', () => {
  const { effect, update, isReset } = setup()
  try {
    effect.sunDirection.set(0, 1, 0)
    update()
    effect.sunDirection.set(0.001, 1, 0).normalize()
    update()
    assert.equal(isReset(), false)
    effect.sunDirection.set(1, 1, 0).normalize()
    update()
    assert.equal(isReset(), true)
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

test('cloud shadow passes bind a resized array target before the library looks up its texture', () => {
  const { effect } = setup()
  try {
    for (const pass of [effect.shadowPass.currentPass, effect.shadowPass.resolvePass]) {
      const output = {}
      const calls = []
      const renderer = {
        setRenderTarget: (target) => calls.push(target),
        // The library's own first step. Before the fix this ran with no GL texture to find.
        properties: { get: () => { calls.push('lookup'); throw new Error('stop') } },
      }
      assert.throws(() => pass.render(renderer, null, output), /stop/)
      assert.deepEqual(calls, [output, 'lookup'])
    }
  } finally { effect.dispose() }
})

test('resizing the cloud shadow maps discards the shadow history only', () => {
  const { effect, update } = setup()
  try {
    update()
    update()
    effect.shadowMaps.mapSize.set(320, 320)
    update()
    assert.equal(effect.shadowPass.resolveMaterial.uniforms.resetHistory.value, true)
    assert.equal(effect.cloudsPass.resolveMaterial.uniforms.resetHistory.value, false)
    update()
    assert.equal(effect.shadowPass.resolveMaterial.uniforms.resetHistory.value, false)
  } finally { effect.dispose() }
})

test('a floating-origin rebase carries last frame\'s reprojection into the new world frame', () => {
  const { effect, camera, history, update, isReset } = setup()
  try {
    camera.position.set(1200, 300, -2500)
    camera.updateMatrixWorld()
    update()
    update()
    const march = effect.cloudsPass.currentMaterial
    march.copyReprojectionMatrix(camera)
    // What a rendered frame leaves behind for the resolve's own reprojection.
    const cadence = march.userData.geoflightCadence
    cadence.previousView = camera.matrixWorldInverse.clone()
    cadence.force = false
    const cascade = effect.shadowPass.currentMaterial.uniforms.reprojectionMatrices.value[0]
    cascade.makeRotationX(0.3).setPosition(5, 6, 7)
    const point = new Vector3(400, 900, -6000)
    const seen = point.clone().applyMatrix4(march.previousViewMatrix)
    const shadowed = point.clone().applyMatrix4(cascade)

    // The origin moves 2.9 km and the axes turn with the local vertical.
    const worldFromOld = new Matrix4().makeRotationY(0.0004).setPosition(-2900, 1.2, 310)
    history.rebase(worldFromOld, 2)
    camera.position.applyMatrix4(worldFromOld)
    camera.updateMatrixWorld()
    point.applyMatrix4(worldFromOld)
    assert.ok(point.clone().applyMatrix4(march.previousViewMatrix).distanceTo(seen) < 1e-6)
    assert.ok(point.clone().applyMatrix4(cadence.previousView).distanceTo(seen) < 1e-6)
    assert.equal(cadence.force, true, 'the shadow cascades are refitted in the new frame at once')
    assert.ok(point.clone().applyMatrix4(cascade).distanceTo(shadowed) < 1e-6)
    update(2)
    assert.equal(isReset(), false, 'history survives the rebase')

    // A rebase the history was not told about still resets, as does a respawn far away.
    update(3)
    assert.equal(isReset(), true)
    history.rebase(new Matrix4().setPosition(9e5, 0, 0), 4)
    update(4)
    assert.equal(isReset(), true)
  } finally { effect.dispose() }
})

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

test('cloud lighting follows the moon and clears daytime history when switching to night', () => {
  const { effect, update, isReset } = setup()
  const night = new NightEffect()
  try {
    update()
    update()
    assert.equal(isReset(), false)
    const direction = new Vector3(1, 0, 1).normalize()
    setCloudNightLighting(effect, 1, direction, 0.5)
    const { uniforms, fragmentShader } = effect.cloudsPass.currentMaterial
    assert.equal(uniforms.nightLighting.value, 1)
    assert.ok(uniforms.nightMoonDirection.value.equals(direction))
    assert.ok(uniforms.moonPhase.value > 0 && uniforms.moonPhase.value < 0.5)
    assert.match(fragmentShader, /radiance \+= nightLighting \* nightRadiance;\s*\}\s*radiance \*= media\.scattering;/)
    update()
    assert.equal(isReset(), true)
    update()
    assert.equal(isReset(), false)
    stabilizeNightClouds(night)
    assert.match(night.getFragmentShader(), /sceneDepth\(\(base \+ offset \+ 0\.5\) \/ size\)/)
    assert.doesNotMatch(night.getFragmentShader(), /cloudFill/)
  } finally { night.dispose(); effect.dispose() }
})

test('city lamp grid coordinates are identical before and after a floating-origin shift', () => {
  // A world frame rotated and placed on the Earth's surface, like the real one.
  const place = (origin) => {
    const up = origin.clone().normalize()
    const east = new Vector3(-up.y, up.x, 0).normalize()
    const north = up.clone().cross(east)
    return new Matrix4().makeBasis(east, up, north.clone().negate()).setPosition(origin)
  }
  const ecefFromWorld = place(new Vector3(195000, -4745000, 4246000))
  const effect = new NightEffect(ecefFromWorld)
  const camera = new PerspectiveCamera(58, 1.6, 0.3, 2e7)
  const pointEcef = new Vector3(196200, -4744100, 4246900)
  const uniform = (key) => effect.uniforms.get(key).value
  const ground = () => {
    const world = pointEcef.clone().applyMatrix4(ecefFromWorld.clone().invert())
    return [uniform('lightOrigin').x + world.dot(uniform('lightEast')), uniform('lightOrigin').y + world.dot(uniform('lightNorth'))]
  }
  try {
    camera.updateMatrixWorld()
    effect.setFrame(camera, 1, 0, new Vector3(0, 1, 0), [])
    const before = ground()
    // Rebase 3 km away: the world axes rotate slightly and the origin moves.
    ecefFromWorld.copy(place(new Vector3(197800, -4743200, 4247300)))
    effect.setFrame(camera, 1, 0, new Vector3(0, 1, 0), [])
    const after = ground()
    assert.ok(Math.hypot(after[0] - before[0], after[1] - before[1]) < 1e-3, 'lamps must not move when the origin does')
  } finally { effect.dispose() }
})

test('landing guide overlay tests depth by hand and never enters the lighting mask', async () => {
  const { OverlayPass } = await import('../src/scene/OverlayPass.ts')
  const camera = new PerspectiveCamera(58, 1.6, 0.3, 2e7)
  const pass = new OverlayPass(camera)
  const material = new MeshBasicMaterial({ transparent: true, depthWrite: false })
  try {
    pass.prepare(material)
    const depth = new Texture()
    pass.setDepthTexture(depth)
    assert.equal(material.depthTest, false)
    assert.equal(material.depthWrite, false)
    const shader = { uniforms: {}, fragmentShader: 'void main() {\n#include <logdepthbuf_fragment>\n#include <opaque_fragment>\n}', vertexShader: '' }
    material.onBeforeCompile(shader)
    assert.match(shader.fragmentShader, /texelFetch\(overlayDepth, ivec2\(gl_FragCoord.xy\), 0\).r/)
    assert.match(shader.fragmentShader, /overlayFragDepth > sceneDepth/)
    assert.equal(shader.uniforms.overlayDepth.value, depth, 'samples the composer’s detached depth texture')
    const source = readFileSync(new URL('../src/scene/LandingGuide.tsx', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /layers\.enable/, 'mask-layer guide meshes leave the terrain behind them unlit (daylight at night)')
  } finally { material.dispose(); pass.dispose() }
})

test('cloud overlay upsampling is depth-aware in the installed aerial perspective shader', async () => {
  const { AerialPerspectiveEffect } = await import('@takram/three-atmosphere')
  const { stabilizeAerialPerspective } = await import('../src/scene/cloudRendering.ts')
  const effect = new AerialPerspectiveEffect(new PerspectiveCamera())
  try {
    stabilizeAerialPerspective(effect)
    const once = effect.getFragmentShader()
    assert.match(once, /vec4 overlay = sampleCloudOverlay\(uv\);/)
    assert.match(once, /exp\(-abs\(texelDepth - center\)/)
    assert.match(once, /degenerateNormal \|\| .*dot\(viewNormal, viewNormal\).*\n\s*\? normalize\(positionECEF \/ vEllipsoidRadiiSquared\)/)
    assert.doesNotMatch(once, /if \(!degenerateNormal\)/)
    assert.ok(once.indexOf('fwidth(viewZ)') < once.indexOf('if (depth >= 1.0)'))
    stabilizeAerialPerspective(effect)
    assert.equal(effect.getFragmentShader(), once, 'patching twice must not change the shader')
  } finally { effect.dispose() }
})
