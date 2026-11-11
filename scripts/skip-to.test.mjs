import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { navigationTo, angleDelta } from '../src/navigation/route.ts'

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.includes('/src/')) {
    const url = new URL(`${specifier}.ts`, context.parentURL)
    if (existsSync(url)) return next(url.href, context)
  }
  return next(specifier, context)
} })
const { skipToPosition, runSkipTransition, METERS_PER_MILE } = await import('../src/navigation/skipTo.ts')

for (const [name, current, destination, miles] of [
  ['Chicago to New York', { lat: 41.9786, lon: -87.9048 }, { lat: 40.6413, lon: -73.7781 }, 100],
  ['Pacific crossing', { lat: 37.62, lon: -122.38 }, { lat: 35.55, lon: 139.78 }, 1500],
  ['southern hemisphere', { lat: -33.94, lon: 151.18 }, { lat: -37.67, lon: 144.84 }, 1],
  ['near a pole', { lat: 88, lon: 90 }, { lat: 89, lon: -90 }, 300],
  ['moving back from a nearby destination', { lat: 40.65, lon: -73.78 }, { lat: 40.6413, lon: -73.7781 }, 100],
  ['long distance', { lat: 0, lon: 0 }, { lat: 30, lon: 120 }, 10000],
]) {
  test(`skip position is exactly the requested ordinary miles away: ${name}`, () => {
    const target = skipToPosition(current, destination, miles)
    const inbound = navigationTo(target, destination)
    assert.ok(Math.abs(inbound.distanceNm * 1852 / METERS_PER_MILE - miles) < 1e-7)
    assert.ok(Math.abs(angleDelta(target.heading, inbound.bearing)) < 1e-8)
    assert.ok(Math.abs(angleDelta(navigationTo(destination, target).bearing, navigationTo(destination, current).bearing)) < 1e-7)
    assert.ok(target.lon >= -180 && target.lon <= 180)
  })
}

test('at the destination, spawn behind the current heading with a valid inbound course', () => {
  const point = { lat: 0, lon: 0 }
  const target = skipToPosition(point, point, 100, 90)
  assert.ok(target.lon < 0)
  assert.ok(Math.abs(target.heading - 90) < 1e-8)
})

test('invalid distances are rejected before generating a position', () => {
  for (const miles of [NaN, Infinity, -1, 0, 0.5, 10001]) {
    assert.throws(() => skipToPosition({ lat: 40, lon: 20 }, { lat: 30, lon: 10 }, miles), /Enter a distance/)
  }
})

test('screen is black before spawning and stays black until the new flight is ready', async () => {
  let time = 0
  const events = []
  await runSkipTransition({
    fade: (stage) => events.push([stage, time]),
    wait: async (ms) => { time += ms },
    spawn: () => events.push(['spawn', time]),
    ready: () => time >= 3700,
  })
  assert.deepEqual(events, [['out', 0], ['spawn', 500], ['in', 3700]])
  assert.equal(time, 4200)
})

test('a failed spawn times out instead of leaving the user at a black screen forever', async () => {
  let time = 0
  await assert.rejects(runSkipTransition({ fade() {}, wait: async (ms) => { time += ms }, spawn() {}, ready: () => false }), /could not finish loading/)
  assert.equal(time, 15500)
})

test('cancelling while fading prevents the relocation', async () => {
  let spawned = false
  await assert.rejects(runSkipTransition({ fade() {}, wait: async () => { throw new Error('cancelled') }, spawn: () => { spawned = true }, ready: () => true }), /cancelled/)
  assert.equal(spawned, false)
})
