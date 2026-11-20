import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { Body, Equator, Horizon, Observer } from 'astronomy-engine'
import { MathUtils, Matrix4, Quaternion, Texture, Vector3 } from 'three'
import { SkyMaterial, StarsMaterial } from '@takram/three-atmosphere'
import { enuBasis, geodeticToEcef } from '../src/world/frame.ts'

// Resolve Vite's extensionless TypeScript imports under Node.
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.includes('/src/')) {
    const url = new URL(`${specifier}.ts`, context.parentURL)
    if (existsSync(url)) return next(url.href, context)
  }
  return next(specifier, context)
} })

const { CelestialState, EARTH_POLAR_RATIO, LunarView, SceneClock, sceneDate, starIntensity, starRotation } = await import('../src/scene/celestial.ts')
const { prepareSky, prepareStars } = await import('../src/scene/celestialRendering.ts')

test('manual hour retains the local calendar date, including both sides of the dateline', () => {
  const now = new Date('2026-11-11T23:30:00Z')
  assert.equal(sceneDate(true, 0, 0, now).toISOString(), now.toISOString())
  assert.equal(sceneDate(false, 22, -90, now).toISOString(), '2026-11-12T04:00:00.000Z')
  assert.equal(sceneDate(false, 12, 180, now).toISOString(), '2026-11-12T00:00:00.000Z')
  assert.equal(sceneDate(false, 12, -180, now).toISOString(), '2026-11-12T00:00:00.000Z')
  assert.equal(sceneDate(false, 12, 150, now, '2027-02-10').toISOString(), '2027-02-10T02:00:00.000Z')
})

test('advancing sky time follows speed, pause and UTC date changes across the dateline', () => {
  const clock = new SceneClock()
  const settings = { realTime: false, timeOfDay: 12, skyDate: '2026-11-17', advanceSkyTime: true }
  const now = new Date('2026-11-11T23:30:00Z')
  assert.equal(clock.tick(settings, 179, 10, 1, now), true)
  const start = clock.date(settings, 179).getTime()
  assert.equal(clock.tick(settings, -179, 20, 4, now), false)
  clock.tick(settings, -179, 35, 0, now)
  clock.tick(settings, -179, 40, 2, now)
  assert.equal(clock.date(settings, -179).getTime() - start, 50_000)
  const tomorrow = { ...settings, skyDate: '2026-11-18' }
  assert.equal(clock.tick(tomorrow, -179, 41, 2, now), true)
  assert.equal(clock.date(tomorrow, -179).toISOString(), '2026-11-18T23:56:00.000Z')
  const live = { ...tomorrow, realTime: true }
  clock.tick(live, -179, 42, 4, now)
  assert.equal(clock.date(live, -179, now).getTime(), now.getTime())
})

test('observer-relative Moon matches JPL Horizons at ground, cruise, near-space and orbital altitudes', () => {
  const state = new CelestialState()
  const view = new LunarView()
  const date = new Date('2026-11-11T23:00:00Z')
  // Horizons Moon (301), geodetic observers on Earth (coord@399), quantities 4, 10, 13.
  const samples = [
    [41.98, -87.9, 0, 223.263838, 5.541395, 6.63128, 1776.545],
    [-33.86, 151.2, 500, 104.811724, 29.291090, 7.05500, 1787.491],
    [48.86, 2.35, 11_000, 290.429236, -53.503430, 6.65513, 1751.394],
    [35.68, 139.69, 108_000, 116.925580, -10.830249, 7.14840, 1768.482],
    [68, 20, 400_000, 330.701226, -48.139796, 6.78285, 1751.800],
  ]
  for (const [lat, lon, height, az, el, phase, diameter] of samples) {
    const observer = geodeticToEcef(lat, lon, height)
    state.update(date, observer)
    state.observeMoon(observer, view)
    assert.ok(view.direction.distanceTo(state.moonDirection) < 1e-12)
    const obs = new Observer(lat, lon, height)
    const eq = Equator(Body.Moon, date, obs, true, false)
    const horizon = Horizon(date, obs, eq.ra, eq.dec)
    const { e, n, u } = enuBasis(lat, lon)
    const altitude = Math.asin(state.moonDirection.dot(u)) * 180 / Math.PI
    const azimuth = (Math.atan2(state.moonDirection.dot(e), state.moonDirection.dot(n)) * 180 / Math.PI + 360) % 360
    assert.ok(Math.abs(altitude - horizon.altitude) < 0.001)
    assert.ok(Math.abs(azimuth - horizon.azimuth) < 0.001)
    assert.ok(Math.abs(azimuth - az) < 0.012, `${lat}, ${lon}: azimuth ${azimuth} vs ${az}`)
    assert.ok(Math.abs(altitude - el) < 0.012, `${lat}, ${lon}: elevation ${altitude} vs ${el}`)
    assert.ok(Math.abs(state.illuminatedFraction * 100 - phase) < 0.03)
    assert.ok(Math.abs(MathUtils.radToDeg(view.angularRadius) * 7200 - diameter) < 0.5)
  }
})

test('new, first quarter, full and last quarter match NASA phase, diameter and lunar orientation', () => {
  const state = new CelestialState()
  // NASA SVS 2026 hourly geocentric ephemeris, https://svs.gsfc.nasa.gov/5587/
  const samples = [
    ['2026-11-09T07:00:00Z', 0.19, 1801.9, 4.013, 6.483, -175.950, -1.540, 16.890],
    ['2026-11-17T12:00:00Z', 50.22, 1803.0, -5.758, 0.020, 83.993, -1.553, -17.966],
    ['2026-11-24T15:00:00Z', 99.81, 1986.7, -2.461, -6.466, -2.540, -1.521, -12.108],
    ['2026-12-01T06:00:00Z', 50.19, 1897.6, 6.758, 1.727, -82.976, -1.469, 20.435],
  ]
  const lon = (v) => MathUtils.radToDeg(Math.atan2(v.y, v.x))
  const lat = (v) => MathUtils.radToDeg(Math.asin(v.z))
  for (const [date, phase, diameter, earthLon, earthLat, sunLon, sunLat, poleAngle] of samples) {
    state.update(new Date(date), new Vector3())
    assert.ok(Math.abs(state.illuminatedFraction * 100 - phase) < 0.03)
    assert.ok(Math.abs(MathUtils.radToDeg(state.moonAngularRadius) * 7200 - diameter) < 0.5)
    const earth = state.moonDirection.clone().negate().applyMatrix4(state.moonFixedFromECEF)
    const sun = state.moonSunDirection.clone().applyMatrix4(state.moonFixedFromECEF)
    assert.ok(Math.abs(lon(earth) - earthLon) < 0.03)
    assert.ok(Math.abs(lat(earth) - earthLat) < 0.03)
    assert.ok(Math.abs(lon(sun) - sunLon) < 0.03)
    assert.ok(Math.abs(lat(sun) - sunLat) < 0.03)
    const east = new Vector3(0, 0, 1).applyMatrix4(state.inertialToECEF).cross(state.moonDirection).normalize()
    const north = state.moonDirection.clone().cross(east)
    const pole = new Vector3(0, 0, 1).applyMatrix4(state.moonFixedFromECEF.clone().transpose())
    assert.ok(Math.abs(MathUtils.radToDeg(Math.atan2(pole.dot(east), pole.dot(north))) - poleAngle) < 0.03)
  }
})

test('refraction lifts and flattens the low Moon, and the curved horizon opens at altitude', () => {
  const view = new LunarView()
  const clearance = (ray) => {
    const scaled = ray.clone()
    scaled.z /= EARTH_POLAR_RATIO
    scaled.normalize()
    return scaled.x * view.horizon.x + scaled.y * view.horizon.y + scaled.z * view.horizon.z - view.horizon.w
  }
  const moonAt = (observer, elevation) => {
    const angle = MathUtils.degToRad(elevation)
    return observer.clone().addScaledVector(new Vector3(Math.sin(angle), Math.cos(angle), 0), 380_000_000)
  }
  const sea = geodeticToEcef(0, 0, 0)
  view.update(moonAt(sea, -0.5), sea)
  assert.ok(clearance(view.direction) < 0 && clearance(view.apparentDirection) > 0)
  assert.ok(view.apparentDirection.clone().applyMatrix3(view.rayFromApparent).normalize().distanceTo(view.direction) < 1e-12)
  const apparentUpper = view.apparentDirection.clone().applyAxisAngle(new Vector3(0, 0, 1), -view.angularRadius)
  assert.ok(apparentUpper.applyMatrix3(view.rayFromApparent).normalize().angleTo(view.direction) > view.angularRadius)
  view.update(moonAt(sea, -5), sea)
  assert.ok(clearance(view.apparentDirection) < 0)
  const space = geodeticToEcef(0, 0, 108_000)
  view.update(moonAt(space, -5), space)
  assert.ok(clearance(view.apparentDirection) > 0 && view.apparentDirection.equals(view.direction))
  view.update(moonAt(space, -15), space)
  assert.ok(clearance(view.apparentDirection) < 0)
})

test('Chicago moonrise and moonset bracket the US Naval Observatory times', () => {
  const state = new CelestialState(), view = new LunarView()
  const observer = geodeticToEcef(41.98, -87.9, 0)
  // https://aa.usno.navy.mil/api/rstt/oneday?date=2026-11-17&coords=41.98,-87.9&tz=0
  for (const [time, rising] of [['04:48', false], ['18:51', true]]) {
    const event = Date.parse(`2026-11-17T${time}:00Z`)
    for (const [minutes, visible] of [[-2, !rising], [2, rising]]) {
      state.update(new Date(event + minutes * 60_000), observer)
      state.observeMoon(observer, view)
      const right = view.up.clone().cross(view.direction).normalize()
      const upper = view.direction.clone().applyAxisAngle(right, -view.angularRadius)
      upper.applyMatrix3(view.rayFromApparent.clone().invert())
      upper.z /= EARTH_POLAR_RATIO
      upper.normalize()
      const margin = upper.x * view.horizon.x + upper.y * view.horizon.y + upper.z * view.horizon.z - view.horizon.w
      assert.equal(margin > 0, visible)
    }
  }
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
    prepareSky(sky, texture); prepareStars(stars)
    const sources = [sky.fragmentShader, stars.fragmentShader, stars.vertexShader]
    prepareSky(sky, texture); prepareStars(stars)
    assert.deepEqual([sky.fragmentShader, stars.fragmentShader, stars.vertexShader], sources)
    assert.ok(sky.uniforms.moonFixedFromECEF.value instanceof Matrix4)
    assert.equal(sky.uniforms.lunarMap.value, texture)
    assert.match(sources[0], /textureLod\(lunarMap, lunarUv,/)
    assert.match(sources[0], /1\.0 - smoothstep\(max\(0\.0, radius - max\(fragmentAngle, 1e-5\)\), radius, angle\)/)
    assert.match(sources[1], /starMoonSinRadius\) discard/)
    assert.match(sources[1], /gl_PointCoord/)
    assert.match(sources[2], /gl_Position.z = gl_Position.w/)
    assert.equal(stars.depthWrite, false)
  } finally { sky.dispose(); stars.dispose(); texture.dispose() }
})

test('Sun keeps its physical angular size from low orbit and varies with Earth-Sun distance', () => {
  const state = new CelestialState()
  const observer = geodeticToEcef(28.6, -80.6, 420_000)
  state.update(new Date('2026-01-03T12:00:00Z'), observer)
  const january = state.sunAngularRadius
  state.update(new Date('2026-07-04T12:00:00Z'), observer)
  const july = state.sunAngularRadius
  assert.ok(january > july)
  assert.ok(january > 0.00470 && january < 0.00474)
  assert.ok(july > 0.00456 && july < 0.00459)
})
