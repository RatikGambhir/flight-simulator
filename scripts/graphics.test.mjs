import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CloudsEffect } from '@takram/three-clouds'
import { BoxGeometry, Color, Group, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, PerspectiveCamera, Texture, Vector3 } from 'three'
import { EffectPass } from 'postprocessing'
import { readFileSync } from 'node:fs'
import { CloudHistory, setCloudNightLighting, stabilizeClouds, stabilizeNightClouds } from '../src/scene/cloudRendering.ts'
import { hingeFrame, setHingeAngle, wingPanelGeometry, wingPoint, wingUpperPoint } from '../src/aircraft/geometry.ts'
import { FlightPrefetch } from '../src/world/flightPrefetch.ts'
import { buildLakeGeometry, distanceToLake, lakeGeoid } from '../src/scene/lakeGeometry.ts'
import { ecefToGeodetic } from '../src/world/frame.ts'
import { MAX_LAMPS, NightEffect } from '../src/scene/NightEffect.ts'
import { CockpitLighting } from '../src/aircraft/cockpitLighting.ts'
import { CUMULUS, cloudProfileForWeather } from '../src/weather/cloudProfiles.ts'
import { parseConditions } from '../src/weather/liveWeather.ts'

test('live weather chooses cloud profiles for dry, layered and convective conditions', () => {
  const profile = (type, cover = 100) => cloudProfileForWeather(parseConditions({
    weatherCondition: { type }, cloudCover: cover,
  }, 0, 0, 0))
  assert.equal(profile('PARTLY_CLOUDY', 45), CUMULUS)
  assert.equal(profile('CLEAR_THEN_RAIN', 10), CUMULUS)
  assert.ok(profile('MOSTLY_CLOUDY', 75).sheet > CUMULUS.sheet)
  assert.ok(profile('CLOUDY').top < profile('MOSTLY_CLOUDY', 75).top)
  assert.deepEqual(profile('LIGHT_RAIN'), profile('CLOUDY'))
  assert.ok(profile('FOG').base < 0)
  assert.ok(profile('RAIN').sheet > profile('RAIN_SHOWERS').sheet)
  assert.ok(profile('HEAVY_SNOW').top > profile('CLOUDY').top)
  assert.ok(profile('THUNDERSHOWER').top > profile('HEAVY_RAIN_SHOWERS').top)
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
  } finally { effect.dispose() }
})

test('four cloud phases cover each pixel once, including the edges of an odd size', () => {
  const { effect, camera } = setup()
  try {
    const pass = effect.cloudsPass
    effect.temporalUpscale = true
    pass.setSize(101, 57)
    const size = pass.currentMaterial.uniforms.resolution.value
    assert.deepEqual(size.toArray(), [102, 58])
    assert.deepEqual([pass.currentRenderTarget.width, pass.currentRenderTarget.height], [51, 29])
    const phases = []
    for (let frame = 0; frame < 4; frame++) {
      pass.currentMaterial.uniforms.frame.value = frame
      pass.resolveMaterial.uniforms.frame.value = frame
      pass.currentMaterial.copyCameraSettings(camera)
      pass.resolveMaterial.onBeforeRender()
      const jitter = pass.currentMaterial.uniforms.temporalJitter.value.clone().multiply(size)
      assert.ok(jitter.equals(pass.resolveMaterial.uniforms.jitterOffset.value))
      phases.push(jitter.toArray().join(','))
    }
    assert.equal(new Set(phases).size, 4)
    effect.temporalUpscale = false
    assert.deepEqual([pass.currentRenderTarget.width, pass.currentRenderTarget.height], [101, 57])
  } finally { effect.dispose() }
})

test('cloud shadows reuse the fitted cascades for one frame and redraw after a camera cut', () => {
  const camera = new PerspectiveCamera()
  const effect = new CloudsEffect(camera)
  try {
    let fits = 0
    let draws = 0
    effect.shadowMaps.update = () => { fits++ }
    effect.shadowPass.update = () => { draws++ }
    stabilizeClouds(effect)
    effect.temporalUpscale = true
    const reset = effect.shadowPass.resolveMaterial.uniforms.resetHistory
    const draw = () => {
      effect.shadowMaps.update()
      effect.shadowPass.update(null, 0, 1 / 30)
    }
    draw()
    reset.value = false
    draw()
    assert.deepEqual([fits, draws], [1, 1])
    draw()
    assert.deepEqual([fits, draws], [2, 2])
    reset.value = true
    draw()
    assert.deepEqual([fits, draws], [3, 3])
    reset.value = false
    effect.shadow.mapSize.set(384, 384)
    draw()
    assert.deepEqual([fits, draws], [4, 4], 'a resized map cannot reuse the old shadow texture')
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
    assert.equal(material.depthTest, false)
    assert.equal(material.depthWrite, false)
    const shader = { uniforms: {}, fragmentShader: 'void main() {\n#include <logdepthbuf_fragment>\n#include <opaque_fragment>\n}', vertexShader: '' }
    material.onBeforeCompile(shader)
    assert.match(shader.fragmentShader, /#include <packing>/)
    assert.match(shader.fragmentShader, /overlayFragDepth > sceneDepth/)
    assert.ok(shader.uniforms.overlayDepth, 'samples a copy of the scene depth')
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
