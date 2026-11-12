import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FrameStats, percentile } from '../src/scene/perfStats.ts'

test('percentile interpolates between sorted samples', () => {
  assert.equal(percentile([], 0.5), 0)
  assert.equal(percentile([10], 0.99), 10)
  assert.equal(percentile([10, 20], 0.5), 15)
  assert.equal(percentile([1, 2, 3, 4, 5], 0), 1)
  assert.equal(percentile([1, 2, 3, 4, 5], 1), 5)
})

test('frame stats report mean FPS, 1% low and spikes over a steady 60 Hz run with hitches', () => {
  const stats = new FrameStats(1000)
  for (let i = 0; i < 990; i++) stats.push({ interval: 1000 / 60, cpu: 2, calls: 300, triangles: 1e5 })
  for (let i = 0; i < 10; i++) stats.push({ interval: 50, cpu: 9, calls: 300, triangles: 1e5 })
  const s = stats.summary()
  assert.equal(s.frames, 1000)
  assert.ok(Math.abs(s.p50 - 1000 / 60) < 1e-4)
  assert.equal(s.low1, 20, 'the slowest 1% are the 50 ms hitches')
  assert.equal(s.spikes, 10)
  assert.ok(s.fps > 55 && s.fps < 60)
  assert.equal(s.calls, 300)
  assert.equal(s.max, 50)
})

test('the ring buffer keeps only the newest frames and windows count back from the newest', () => {
  const stats = new FrameStats(4)
  for (const interval of [100, 100, 10, 20, 30, 40]) stats.push({ interval, cpu: 1, calls: 1, triangles: 1 })
  assert.equal(stats.count, 4)
  assert.equal(stats.summary().max, 40)
  assert.equal(stats.summary(2).p50, 35)
  stats.clear()
  assert.equal(stats.summary().frames, 0)
})
