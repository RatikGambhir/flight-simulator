import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Body, Equator, Horizon, Observer, SearchMoonPhase } from 'astronomy-engine'
import { Matrix4, Quaternion, Texture, Vector3 } from 'three'
import { SkyMaterial, StarsMaterial } from '@takram/three-atmosphere'
import { CelestialState, sceneDate, starIntensity, starRotation } from '../src/scene/celestial.ts'
import { prepareMoon, prepareStars } from '../src/scene/celestialRendering.ts'
import { enuBasis, geodeticToEcef } from '../src/world/frame.ts'

test('manual hour retains the local calendar date, including both sides of the dateline', () => {
  const now = new Date('2026-11-11T23:30:00Z')
  assert.equal(sceneDate(true, 0, 0, now).toISOString(), now.toISOString())
  assert.equal(sceneDate(false, 22, -90, now).toISOString(), '2026-11-12T04:00:00.000Z')
  assert.equal(sceneDate(false, 12, 180, now).toISOString(), '2026-11-12T00:00:00.000Z')
  assert.equal(sceneDate(false, 12, -180, now).toISOString(), '2026-11-12T00:00:00.000Z')
})

test('observer-relative Moon matches independent equatorial/horizon API in both hemispheres', () => {
  const state = new CelestialState()
  for (const [lat, lon] of [[41.98, -87.9], [-33.86, 151.2], [68, 20], [0, 179]]) {
    const date = new Date('2026-11-11T23:00:00Z')
    state.update(date, geodeticToEcef(lat, lon, 500))
    const obs = new Observer(lat, lon, 500)
    const eq = Equator(Body.Moon, date, obs, true, false)
    const horizon = Horizon(date, obs, eq.ra, eq.dec)
    const { e, n, u } = enuBasis(lat, lon)
    const altitude = Math.asin(state.moonDirection.dot(u)) * 180 / Math.PI
    const azimuth = (Math.atan2(state.moonDirection.dot(e), state.moonDirection.dot(n)) * 180 / Math.PI + 360) % 360
    assert.ok(Math.abs(altitude - horizon.altitude) < 0.001)
    assert.ok(Math.abs(azimuth - horizon.azimuth) < 0.001)
    assert.ok(state.moonAngularRadius > 0.004 && state.moonAngularRadius < 0.005)
    const subearth = state.moonDirection.clone().negate().applyMatrix4(state.moonFixedFromECEF)
    assert.ok(subearth.x > 0.97, 'near side must face the observer, including libration')
  }
})

test('new, quarter and full Moons have the correct illuminated fraction and varying size', () => {
  const state = new CelestialState(), radii = []
  for (const [phase, expected] of [[0, 0], [90, 0.5], [180, 1], [270, 0.5]]) {
    const time = SearchMoonPhase(phase, new Date('2026-11-01T00:00:00Z'), 40)
    assert.ok(time)
    state.update(time.date, new Vector3())
    assert.ok(Math.abs(state.illuminatedFraction - expected) < 0.005)
    radii.push(state.moonAngularRadius)
  }
  assert.ok(Math.max(...radii) - Math.min(...radii) > 0.0001)
})

test('star directions survive arbitrary local-frame changes and fade continuously through twilight', () => {
  const state = new CelestialState()
  state.update(new Date('2026-11-11T23:00:00Z'), geodeticToEcef(42, -88, 0))
  const catalog = new Vector3(0.2, 0.4, 0.7).normalize()
  for (const angle of [0, 1, -2]) {
    const worldFromECEF = new Quaternion().setFromAxisAngle(new Vector3(1, 2, 3).normalize(), angle)
    const local = catalog.clone().applyQuaternion(starRotation(state.inertialToECEF, worldFromECEF, new Quaternion()))
    local.applyQuaternion(worldFromECEF.clone().invert())
    assert.ok(local.distanceTo(catalog.clone().applyMatrix4(state.inertialToECEF)) < 1e-12)
  }
  assert.equal(starIntensity(0.2, 0), 0)
  assert.ok(starIntensity(-0.1, 0) < starIntensity(-0.2, 0))
  assert.ok(starIntensity(-0.4, 1) < starIntensity(-0.4, 0))
})

test('installed sky shaders support lunar texture, occultation and small round stars without double patching', () => {
  const sky = new SkyMaterial(), stars = new StarsMaterial(), texture = new Texture()
  try {
    prepareMoon(sky, texture); prepareStars(stars)
    const sources = [sky.fragmentShader, stars.fragmentShader, stars.vertexShader]
    prepareMoon(sky, texture); prepareStars(stars)
    assert.deepEqual([sky.fragmentShader, stars.fragmentShader, stars.vertexShader], sources)
    assert.ok(sky.uniforms.moonFixedFromECEF.value instanceof Matrix4)
    assert.equal(sky.uniforms.lunarMap.value, texture)
    assert.match(sources[0], /texture\(lunarMap, lunarUv\)/)
    assert.match(sources[1], /starMoonCosRadius\) discard/)
    assert.match(sources[1], /gl_PointCoord/)
    assert.match(sources[2], /gl_Position.z = gl_Position.w/)
    assert.equal(stars.depthWrite, false)
  } finally { sky.dispose(); stars.dispose(); texture.dispose() }
})
