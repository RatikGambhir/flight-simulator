import { BoxGeometry, BufferGeometry, CanvasTexture, CylinderGeometry, DoubleSide, Float32BufferAttribute, Group, InstancedMesh, LineBasicMaterial, LineSegments, MathUtils, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, PlaneGeometry, SpotLight, SRGBColorSpace, Vector3 } from 'three'

/** Dimensions in metres: 109 m across the arrays, 73 m fore/aft. */
export function buildISS() {
  const root = new Group(); root.name = 'International Space Station · 109 m'
  const silver = new MeshStandardMaterial({ color: '#d2d7db', roughness: 0.53, metalness: 0.25 })
  const white = new MeshStandardMaterial({ color: '#e4e4dc', roughness: 0.85 })
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 512
  const g = canvas.getContext('2d')!
  g.fillStyle = '#342a16'; g.fillRect(0, 0, 256, 512)
  for (let row = 0; row < 32; row++) for (let col = 0; col < 12; col++) {
    g.fillStyle = (col + row) % 4 === 0 ? '#243654' : '#1b2d4c'
    g.fillRect(col * 21 + 1, row * 16 + 1, 19, 14)
  }
  const map = new CanvasTexture(canvas); map.colorSpace = SRGBColorSpace; map.anisotropy = 4
  const solar = new MeshStandardMaterial({ map, side: DoubleSide, roughness: 0.42, metalness: 0.22 })
  const arrays = new InstancedMesh(new PlaneGeometry(14.5, 32.8), solar, 8)
  const dummy = new Object3D()
  let index = 0
  for (const x of [-47.25, -23.6, 23.6, 47.25]) for (const z of [-20, 20]) {
    dummy.position.set(x, 0, z); dummy.rotation.x = -Math.PI / 2; dummy.updateMatrix(); arrays.setMatrixAt(index++, dummy.matrix)
  }
  arrays.computeBoundingSphere(); root.add(arrays)
  const truss = new Mesh(new BoxGeometry(100, 1.25, 1.25), silver); truss.position.y = -1.4; root.add(truss)
  const beams: number[] = []
  for (let x = -50; x < 50; x += 3) {
    beams.push(x, -2.4, -0.8, x + 3, -0.4, 0.8, x, -0.4, 0.8, x + 3, -2.4, -0.8)
  }
  const beamGeo = new BufferGeometry(); beamGeo.setAttribute('position', new Float32BufferAttribute(beams, 3))
  root.add(new LineSegments(beamGeo, new LineBasicMaterial({ color: '#d5d6d8' })))
  function module(name: string, radius: number, length: number, x: number, y: number, z: number, alongX = false) {
    const geo = new CylinderGeometry(radius, radius, length, 24)
    geo.rotateX(Math.PI / 2)
    if (alongX) geo.rotateY(Math.PI / 2)
    const m = new Mesh(geo, silver); m.name = name; m.position.set(x, y, z); root.add(m)
  }
  module('Destiny laboratory', 2.15, 8.5, 0, -3.5, -9)
  module('Harmony node', 2.2, 6, 0, -3.5, -17)
  module('Unity node', 2.2, 5.5, 0, -3.5, -1)
  module('Zarya', 2.05, 12.5, 0, -3.5, 8)
  module('Zvezda', 2.1, 13, 0, -3.5, 21)
  module('Kibo', 2.2, 11, -7.4, -3.5, -17, true)
  module('Columbus', 2.2, 7, 6.2, -3.5, -17, true)
  module('Tranquility', 2.2, 6.7, -5.8, -3.5, -1, true)
  module('Cupola', 1.45, 1.4, -5.8, -6.1, -1)
  const radiators = new InstancedMesh(new PlaneGeometry(3.2, 12), white, 6)
  for (let i = 0; i < 6; i++) {
    dummy.position.set((i < 3 ? -1 : 1) * (8 + (i % 3) * 4), -1.7, 10)
    dummy.rotation.set(-Math.PI / 3, 0, 0); dummy.updateMatrix(); radiators.setMatrixAt(i, dummy.matrix)
  }
  radiators.computeBoundingSphere(); root.add(radiators)
  root.traverse((o) => { if (o instanceof Mesh) { o.castShadow = true; o.receiveShadow = true } })
  return root
}

/** Members of a square lattice tower as [from, to, thickness] segments in local metres. */
function latticeMembers(width: number, depth: number, height: number, bay: number, out: [Vector3, Vector3, number][], origin: Vector3) {
  const w = width / 2, d = depth / 2
  const corners = [[-w, -d], [w, -d], [w, d], [-w, d]]
  const at = (i: number, y: number) => new Vector3(corners[i % 4][0], y, corners[i % 4][1]).add(origin)
  for (let i = 0; i < 4; i++) out.push([at(i, 0), at(i, height), 0.55])
  for (let y = 0; y < height - 0.1; y += bay) {
    const top = Math.min(height, y + bay)
    for (let i = 0; i < 4; i++) {
      out.push([at(i, top), at(i + 1, top), 0.32])
      out.push([at(i, y), at(i + 1, top), 0.2], [at(i + 1, y), at(i, top), 0.2])
    }
  }
}

const UP = new Vector3(0, 1, 0)
function instancedMembers(members: [Vector3, Vector3, number][], material: MeshStandardMaterial, name: string) {
  const beams = new InstancedMesh(new BoxGeometry(1, 1, 1), material, members.length)
  const dummy = new Object3D(), dir = new Vector3()
  members.forEach(([a, b, t], i) => {
    dir.subVectors(b, a)
    dummy.position.addVectors(a, b).multiplyScalar(0.5)
    dummy.quaternion.setFromUnitVectors(UP, dir.clone().normalize())
    dummy.scale.set(t, dir.length(), t)
    dummy.updateMatrix(); beams.setMatrixAt(i, dummy.matrix)
  })
  beams.computeBoundingSphere(); beams.name = name
  return beams
}

/**
 * Launch complex in the pad's local frame: x east, y up, -z north, origin 1 m
 * above the surveyed ground. The stack stands at the origin with its centre 20 m
 * up, the external tank towards `heading` and the orbiter on the opposite side.
 */
export function buildLaunchPad(heading = 45) {
  const root = new Group(); root.name = 'Shuttle launch complex'
  const concrete = new MeshStandardMaterial({ color: '#74736d', roughness: 0.95 })
  const scorched = new MeshStandardMaterial({ color: '#4d4a45', roughness: 1 })
  const steel = new MeshStandardMaterial({ color: '#8e979e', roughness: 0.55, metalness: 0.45 })
  const red = new MeshStandardMaterial({ color: '#b23a2a', roughness: 0.6, metalness: 0.2 })
  const white = new MeshStandardMaterial({ color: '#e7e6df', roughness: 0.7 })
  const mlpGray = new MeshStandardMaterial({ color: '#7d8084', roughness: 0.75, metalness: 0.25 })
  const dark = new MeshStandardMaterial({ color: '#111214', roughness: 1 })
  // Horizontal directions in the local frame from a compass bearing.
  const bearing = (deg: number, dist: number, y = 0) => {
    const r = deg * Math.PI / 180
    return new Vector3(Math.sin(r) * dist, y, -Math.cos(r) * dist)
  }
  const yaw = (deg: number) => -deg * Math.PI / 180

  // Octagonal hardstand with the north-south flame trench cut through it.
  const hard = new Mesh(new CylinderGeometry(78, 84, 4, 8), concrete); hard.position.y = -2.6; hard.rotation.y = Math.PI / 8; root.add(hard)
  const trench = new Mesh(new BoxGeometry(14, 0.1, 150), dark); trench.position.y = -0.56; root.add(trench)
  for (const side of [-1, 1]) {
    const wall = new Mesh(new BoxGeometry(1.2, 1.6, 150), scorched); wall.position.set(side * 7.6, -1.1, 0); root.add(wall)
  }
  // Mobile launcher platform: deck, exhaust holes, hold-down posts and tail service masts.
  const mlp = new Group(); mlp.rotation.y = yaw(heading); root.add(mlp)
  const deck = new Mesh(new BoxGeometry(41, 1.6, 49), mlpGray); deck.position.y = -1.0; mlp.add(deck)
  // Local MLP axes: -z towards the tank (heading), +x towards the right booster.
  for (const [x, z, w, l] of [[-6.3, -6.2, 5.2, 5.2], [6.3, -6.2, 5.2, 5.2], [0, 0.4, 6.5, 4.2]] as const) {
    const hole = new Mesh(new PlaneGeometry(w, l), dark); hole.rotation.x = -Math.PI / 2; hole.position.set(x, -0.19, z); mlp.add(hole)
  }
  for (const x of [-6.3, 6.3]) for (const [dx, dz] of [[-2.1, -2.1], [2.1, -2.1], [-2.1, 1.7], [2.1, 1.7]]) {
    const post = new Mesh(new BoxGeometry(0.9, 1.0, 0.9), steel); post.position.set(x + dx, 0.2, -6.2 + dz); mlp.add(post)
  }
  for (const x of [-4.1, 4.1]) {
    const mast = new Mesh(new BoxGeometry(2.6, 9, 4.6), white); mast.position.set(x, 4.3, 4.6); mlp.add(mast)
    const cap = new Mesh(new BoxGeometry(2.8, 0.4, 4.8), steel); cap.position.set(x, 8.9, 4.6); mlp.add(cap)
  }

  // Fixed service structure: a 10 m lattice tower with the hammerhead crane and lightning mast.
  const members: [Vector3, Vector3, number][] = []
  const fssAt = bearing(heading, 22.5)
  latticeMembers(10, 10, 74, 6.2, members, fssAt.clone().setY(-1))
  const rssAt = bearing(heading + 62, 34)
  latticeMembers(14, 22, 52, 6.5, members, rssAt.clone().setY(-1))
  const water = bearing(heading + 150, 115)
  latticeMembers(9, 9, 52, 7, members, water.clone().setY(-1))
  root.add(instancedMembers(members, steel, 'service structure lattice'))
  const floors = new InstancedMesh(new BoxGeometry(10.4, 0.25, 10.4), steel, 12)
  const dummy = new Object3D()
  for (let i = 0; i < 12; i++) {
    dummy.position.copy(fssAt).setY(5.2 + i * 6.2); dummy.rotation.y = yaw(heading); dummy.updateMatrix(); floors.setMatrixAt(i, dummy.matrix)
  }
  floors.computeBoundingSphere(); root.add(floors)
  const crane = new Mesh(new BoxGeometry(3, 2.4, 26), red); crane.position.copy(fssAt).setY(75.2); crane.rotation.y = yaw(heading + 90); root.add(crane)
  const mast = new Mesh(new CylinderGeometry(0.35, 0.8, 24, 10), steel); mast.position.copy(fssAt).setY(88); root.add(mast)
  const tip = new Mesh(new CylinderGeometry(0.05, 0.3, 3, 6), red); tip.position.copy(fssAt).setY(101.5); root.add(tip)
  // Catenary wires from the mast to ground anchors either side of the pad.
  const wire: number[] = []
  for (const b of [heading + 90, heading - 90]) {
    const end = bearing(b, 290, -1)
    for (let i = 0; i < 24; i++) {
      const a = i / 24, c = (i + 1) / 24
      const p = (u: number) => new Vector3().lerpVectors(fssAt.clone().setY(102), end, u).addScaledVector(UP, -38 * u * (1 - u))
      wire.push(...p(a).toArray(), ...p(c).toArray())
    }
  }
  const wireGeo = new BufferGeometry(); wireGeo.setAttribute('position', new Float32BufferAttribute(wire, 3))
  root.add(new LineSegments(wireGeo, new LineBasicMaterial({ color: '#2a2c2f' })))
  // Rotating service structure, parked open, with its payload changeout room.
  const pcr = new Mesh(new BoxGeometry(14, 24, 9), white); pcr.position.copy(rssAt).setY(36); pcr.rotation.y = yaw(heading + 62); root.add(pcr)
  // Sound-suppression water tower.
  const tank = new Mesh(new CylinderGeometry(7, 7, 14, 24), white); tank.position.copy(water).setY(58); root.add(tank)
  const roof = new Mesh(new CylinderGeometry(0.5, 7.4, 4, 24), white); roof.position.copy(water).setY(67); root.add(roof)

  // Swing arms pivot at the tower and retract after ignition. Positions are
  // (towards the tank, towards the orbiter's port side) offsets from the stack axis.
  const arms: { pivot: Group; swing: number }[] = []
  const local = (u: number, v: number, y: number) => bearing(heading, u).add(bearing(heading - 90, v)).setY(y)
  function arm(from: Vector3, to: Vector3, swing: number, end: (g: Group, length: number) => void) {
    const pivot = new Group(); pivot.position.copy(from)
    const length = Math.hypot(to.x - from.x, to.z - from.z)
    pivot.rotation.y = Math.atan2(-(to.x - from.x), -(to.z - from.z)); root.add(pivot)
    const truss = new Mesh(new BoxGeometry(2.2, 2.2, length - 1.5), steel); truss.position.z = -(length - 1.5) / 2; pivot.add(truss)
    end(pivot, length); arms.push({ pivot, swing })
  }
  // GOX vent hood ("beanie cap") over the tank nose.
  arm(local(17.3, 0, 47.2), local(6.2, 0, 47.2), 1.4, (g, length) => {
    const hood = new Mesh(new CylinderGeometry(2.4, 2.9, 2.8, 20), white); hood.position.set(0, 1.3, -length); g.add(hood)
  })
  // Orbiter access arm and white room at the crew hatch, clearing the tank.
  arm(local(15, 6.5, 31), local(-0.3, 3.9, 31), -1.2, (g, length) => {
    const room = new Mesh(new BoxGeometry(3.6, 4, 3.4), white); room.position.set(0, 0.4, -length + 1.2); g.add(room)
  })
  root.userData.arms = arms

  // Floodlight towers on the hardstand perimeter.
  const lens = new MeshBasicMaterial({ color: '#fff1d0', toneMapped: false })
  for (const b of [heading + 45, heading + 135, heading + 225, heading + 315]) {
    const base = bearing(b, 58, -1)
    const pole = new Mesh(new CylinderGeometry(0.35, 0.5, 30, 8), steel); pole.position.copy(base).setY(14); root.add(pole)
    const flood = new SpotLight('#fff0d4', 600, 220, 0.8, 0.7, 2)
    flood.position.copy(base).setY(29.5)
    flood.target.position.set(0, 22, 0)
    const fixture = new Mesh(new BoxGeometry(3, 1.2, 0.5), lens)
    fixture.position.copy(flood.position); fixture.lookAt(flood.target.position)
    root.add(flood, flood.target, fixture)
  }
  root.traverse((o) => { if (o instanceof Mesh) { o.castShadow = true; o.receiveShadow = true } })
  trench.castShadow = hard.castShadow = false
  return root
}

/** Swing the service arms clear: the vent hood lifts away before ignition, the crew arm after. */
export function animateLaunchPad(pad: Group, secondsSinceLaunch: number) {
  const arms = pad.userData.arms as { pivot: Group; swing: number }[] | undefined
  if (!arms) return
  const u = MathUtils.smoothstep(secondsSinceLaunch, 0, 4)
  for (const { pivot } of arms) pivot.userData.base ??= pivot.rotation.y
  for (const { pivot, swing } of arms) pivot.rotation.y = pivot.userData.base + swing * u
}

const fwd = new Vector3(), up = new Vector3(), right = new Vector3()
/** Station local z follows the orbital track; y points away from Earth. */
export function orientStation(root: Group, position: Vector3, normal: Vector3) {
  up.copy(position).normalize(); fwd.crossVectors(normal, up).normalize(); right.crossVectors(up, fwd).normalize()
  root.matrix.makeBasis(right, up, fwd); root.quaternion.setFromRotationMatrix(root.matrix)
}
