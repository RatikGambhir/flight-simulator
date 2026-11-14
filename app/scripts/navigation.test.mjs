import assert from 'node:assert/strict'
import { test } from 'node:test'
import { navigationTo, angleDelta, routePoints } from '../src/navigation/route.ts'
import { frame, geodeticToEcef } from '../src/world/frame.ts'
import { PerspectiveCamera, Vector3 } from 'three'

test('bearings agree with cardinal directions and wrap smoothly through north', () => {
  const origin = { lat: 0, lon: 0 }
  for (const [lat, lon, bearing] of [[1, 0, 0], [0, 1, 90], [-1, 0, 180], [0, -1, 270]]) {
    const nav = navigationTo(origin, { lat, lon })
    assert.equal(nav.bearing, bearing)
    assert.ok(Math.abs(nav.distanceNm - 60.04) < 0.01)
  }
  assert.equal(angleDelta(1, 359), 2)
  assert.equal(angleDelta(359, 1), -2)
  assert.equal(navigationTo(origin, origin).distanceNm, 0)
})

test('Chicago to New York follows a curved route with accurate endpoints', () => {
  const from = { lat: 41.9786, lon: -87.9048 }, to = { lat: 40.6413, lon: -73.7781 }
  const nav = navigationTo(from, to)
  assert.ok(nav.distanceNm > 640 && nav.distanceNm < 650)
  assert.ok(nav.bearing > 92 && nav.bearing < 94)
  const points = routePoints(from, to)
  assert.ok(Math.abs(points[0].lat - from.lat) < 1e-10)
  assert.ok(Math.abs(points.at(-1).lon - to.lon) < 1e-10)
  const half = navigationTo(from, points[64]).distanceNm
  assert.ok(Math.abs(half - nav.distanceNm / 2) < 1e-8)
})

test('Pacific routes cross the date line without drawing a line across the map', () => {
  const points = routePoints({ lat: 35.55, lon: 139.78 }, { lat: 37.62, lon: -122.38 })
  assert.ok(points.at(-1).lon > 180)
  for (let i = 1; i < points.length; i++) assert.ok(Math.abs(points[i].lon - points[i - 1].lon) < 3)
  for (const p of routePoints({ lat: 0, lon: 0 }, { lat: 0, lon: 180 })) assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon))
})

test('airport projection survives origin rebasing and responds to camera direction', () => {
  const airport = geodeticToEcef(41.98, -87.9, 190)
  const eye = geodeticToEcef(41.97, -87.9, 500)
  const camera = new PerspectiveCamera(58, 1.6, 0.3, 2e7)
  const target = new Vector3()
  let previous
  for (const origin of [eye, geodeticToEcef(42.01, -87.87, 400)]) {
    frame.setOrigin(origin.x, origin.y, origin.z)
    frame.ecefToWorld(eye.x, eye.y, eye.z, camera.position)
    frame.ecefToWorld(airport.x, airport.y, airport.z, target)
    frame.upAt(camera.position, camera.up)
    camera.lookAt(target)
    camera.updateMatrixWorld()
    const projected = target.clone().project(camera)
    assert.ok(Math.abs(projected.x) < 1e-8 && Math.abs(projected.y) < 1e-8)
    if (previous) assert.ok(previous.distanceTo(projected) < 1e-8)
    previous = projected
    camera.rotateY(Math.PI)
    camera.updateMatrixWorld()
    assert.ok(target.clone().applyMatrix4(camera.matrixWorldInverse).z > 0, 'airport behind camera must be hidden')
  }
})
