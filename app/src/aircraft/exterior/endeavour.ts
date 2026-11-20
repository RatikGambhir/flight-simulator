import { BoxGeometry, CanvasTexture, CylinderGeometry, DoubleSide, Group, LatheGeometry, Mesh, MeshStandardMaterial, Object3D, PlaneGeometry, RepeatWrapping, SRGBColorSpace, Vector2, Vector3 } from 'three'
import { tubeGeometry, type WingParams } from '../geometry'
import { createMaterials, type Livery } from '../materials'
import { S } from '../../sim/protocol'
import { buildWings, gearLeg, mesh, newModel, tailSurface } from './parts'

function marking(text: string, width = 512) {
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = 128
  const g = canvas.getContext('2d')!
  g.fillStyle = '#eeeae0'; g.fillRect(0, 0, width, 128)
  g.fillStyle = '#171b21'; g.font = 'bold 58px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'
  g.fillText(text, width / 2, 64)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

function cylinder(parent: Group, radius: number, length: number, x: number, y: number, z: number, material: MeshStandardMaterial, tip = radius) {
  const geo = new CylinderGeometry(tip, radius, length, 32)
  geo.rotateX(-Math.PI / 2)
  return mesh(geo, material, parent).position.set(x, y, z)
}

export function buildEndeavour() {
  const livery: Livery = { base: '#eeeae0', belly: '#202126', stripe: '#202126', accent: '#292c32', tail: '#eeeae0', tailLogo: '#202126', title: 'Endeavour' }
  const whiteMap = marking('')
  const m = createMaterials(livery, whiteMap, whiteMap)
  for (const skin of [m.fuselage, m.wing, m.tail, m.paint]) { skin.clearcoat = 0; skin.roughness = 0.88; skin.metalness = 0 }
  m.fuselage.emissive.set('#000000')
  m.wing.color.set('#eeeae0'); m.wingDark.color.set('#24252a')
  const model = newModel('endeavour', 'airliner', m)
  model.span = 23.79; model.length = 56.1 // Full stack for launch camera framing; orbiter itself is 37.24 m.
  model.eye.set(-0.6, 2.2, -12.2)
  model.cockpitLookPitch = -0.1
  const { root } = model
  const body = mesh(tubeGeometry([
    { z: -18.62, hw: 0.08, hh: 0.1, yc: -0.1 },
    { z: -17, hw: 0.8, hh: 0.6, yc: -0.1 },
    { z: -14, hw: 1.8, hh: 1.6, yc: 0.2 },
    { z: -11, hw: 2.45, hh: 2.5, yc: 0.4 },
    { z: -7, hw: 2.65, hh: 2.7, yc: 0.4 },
    { z: 10, hw: 2.65, hh: 2.7, yc: 0.4 },
    { z: 16.8, hw: 2.4, hh: 2.2, yc: 0.1 },
    { z: 18.62, hw: 1.9, hh: 1.5, yc: 0 },
  ], 40), m.fuselage, root, 'Endeavour orbiter · 37.24 m')
  model.exteriorOnly.push(body)
  mesh(new BoxGeometry(4.5, 0.12, 27.5).translate(0, -1.95, 2.4), m.belly, root, 'black thermal tiles')
  const wing: WingParams = { span: 9.6, rootChord: 20.2, tipChord: 2.6, sweep: 46, dihedral: 0, thicknessRoot: 0.045, thicknessTip: 0.035, camber: 0 }
  buildWings(model, root, { params: wing, at: new Vector3(2.295, -1.3, -4.5), mat: m.wing, surfaceMat: m.wingDark, aileron: [0.12, 0.95] })
  tailSurface(model, root, { span: 6.6, rootChord: 8.2, tipChord: 2.5, sweep: 42, dihedral: 0, thicknessRoot: 0.07, thicknessTip: 0.035, camber: 0, vertical: true }, new Vector3(0, 1.6, 9.1), 'rudder', m.tail, m.wingDark)
  const window = new MeshStandardMaterial({ color: '#0c1724', metalness: 0.25, roughness: 0.12 })
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const glass = mesh(new BoxGeometry(0.64, 0.55, 0.08), window, root, 'flight-deck window')
      glass.position.set(side * (0.45 + i * 0.59), 2.13, -12.85 + i * 0.46)
      glass.rotation.set(-0.4, side * -0.4, 0)
      model.exteriorOnly.push(glass)
    }
    const label = mesh(new PlaneGeometry(7.1, 1.75), new MeshStandardMaterial({ map: marking(side < 0 ? 'Endeavour' : 'United States'), roughness: 1, side: DoubleSide }), root, 'orbiter name')
    label.position.set(side * 2.66, 0.8, 4); label.rotation.y = side * Math.PI / 2
    // OMS pods on either side of the tail.
    cylinder(root, 1.05, 6.2, side * 2.4, 1.5, 14.5, m.paint, 0.65)
    cylinder(root, 0.5, 1.3, side * 2.4, 1.5, 18.0, m.darkMetal, 0.28)
  }
  const payload = mesh(new BoxGeometry(4.9, 0.16, 17.4).translate(0, 3.08, 1.7), m.paint, root, 'payload bay doors')
  const seam = mesh(new BoxGeometry(0.035, 0.02, 17.4).translate(0, 3.175, 1.7), m.wingDark, root)
  model.exteriorOnly.push(payload, seam)
  // Exhaust anchors: local +z is the exhaust direction at the nozzle exit plane.
  // The plumes themselves are drawn by the launch effects after atmospheric lighting.
  function anchor(parent: Group, name: string, x: number, y: number, z: number) {
    const a = new Object3D(); a.name = name; a.position.set(x, y, z); parent.add(a)
    return a
  }
  // Three RS-25 bells: one above, two below, 2.3 m exit diameter.
  const ssmeBell = bell([[0.34, 0], [0.42, 0.25], [0.62, 0.8], [0.85, 1.6], [1.02, 2.4], [1.12, 3.05]])
  for (const [i, [x, y]] of [[0, 1.25], [-1.35, -0.9], [1.35, -0.9]].entries()) {
    const b = mesh(ssmeBell, nozzleMetal, root, 'RS-25 nozzle'); b.position.set(x, y, 17.35)
    mesh(new CylinderGeometry(0.62, 0.5, 0.9, 20).rotateX(-Math.PI / 2), m.darkMetal, root, 'RS-25 powerhead').position.set(x, y, 17.0)
    anchor(root, `plume-ssme-${i}`, x, y, 20.4)
  }
  for (const side of [-1, 1]) anchor(root, `plume-oms-${side < 0 ? 0 : 1}`, side * 2.4, 1.5, 18.65)

  gearLeg(model, root, new Vector3(0, -1.3, -12.5), -3.4, 0.6, [-0.32, 0.32], 'x', -1.5, m)
  for (const side of [-1, 1]) gearLeg(model, root, new Vector3(side * 2.8, -1.3, 9.5), -3.35, 0.65, [-0.4, 0.4], 'z', -side * 1.5, m)

  // External tank: 46.9 m long, 8.4 m diameter, LO2 ogive above the intertank.
  const tank = new Group(); tank.name = 'external tank'; root.add(tank)
  const foam = new MeshStandardMaterial({ map: foamTexture(), roughness: 0.93, metalness: 0 })
  const tankShape = lathe([[0.0, 19.75], [1.6, 19.55], [2.9, 19.05], [3.75, 18.35], [4.12, 17.5], [4.2, 16.6], [4.2, -12.4],
    [4.16, -14], [4.02, -15.6], [3.78, -17.2], [3.42, -18.8], [2.96, -20.4], [2.42, -21.9], [1.82, -23.3], [1.2, -24.6],
    [0.66, -25.8], [0.3, -26.8], [0.16, -27.35], [0.07, -28.5], [0, -28.6]], foam)
  tankShape.position.y = -6.2; tank.add(tankShape)
  // LO2 feedline and the electrical cable tray run down the side facing the right booster.
  const feed = new MeshStandardMaterial({ color: '#a8592a', roughness: 0.9 })
  mesh(new CylinderGeometry(0.22, 0.22, 34, 10).rotateX(-Math.PI / 2), feed, tank, 'LO2 feedline').position.set(3.2, -4.0, 1.5)
  mesh(new BoxGeometry(0.35, 0.3, 40), feed, tank, 'cable tray').position.set(-3.0, -3.3, -1.5)
  // Bipod and aft attach struts to the orbiter.
  for (const side of [-1, 1]) mesh(new CylinderGeometry(0.12, 0.12, 2.6, 8), m.darkMetal, tank).position.set(side * 0.9, -1.9, -9.5)
  for (const side of [-1, 1]) mesh(new CylinderGeometry(0.16, 0.16, 2.2, 8), m.darkMetal, tank).position.set(side * 1.6, -2.0, 15.6)

  // Solid rocket boosters: 45.5 m, 3.71 m diameter, flared aft skirt and a gimballed nozzle.
  const srbPaint = new MeshStandardMaterial({ map: boosterTexture(), roughness: 0.62, metalness: 0.05 })
  const srbBell = bell([[1.05, 0], [1.2, 0.5], [1.5, 1.2], [1.78, 1.85], [1.92, 2.3]])
  const boosters = [-1, 1].map((side) => {
    const g = new Group(); g.name = side < 0 ? 'left solid booster' : 'right solid booster'; root.add(g)
    const body = lathe([[2.62, 20.0], [2.55, 19.6], [2.2, 18.6], [1.9, 17.3], [1.86, 16.9], [1.86, -20.5], [1.78, -21.3],
      [1.62, -22.4], [1.38, -23.6], [1.08, -24.8], [0.72, -25.9], [0.38, -26.75], [0.14, -27.2], [0, -27.35]], srbPaint)
    body.position.set(side * 6.3, -6.2, 0); g.add(body)
    const nozzle = mesh(srbBell, nozzleMetal, g, 'SRB nozzle'); nozzle.position.set(side * 6.3, -6.2, 19.5)
    // Forward and aft attach rings to the external tank.
    mesh(new BoxGeometry(2.2, 0.35, 0.35), m.darkMetal, g).position.set(side * 3.9, -6.2, -17.2)
    mesh(new BoxGeometry(2.2, 0.3, 0.3), m.darkMetal, g).position.set(side * 3.9, -6.2, 15.4)
    // Separation motor clusters at the nose frustum and aft skirt.
    for (const z of [-21.6, 17.9]) mesh(new BoxGeometry(0.5, 0.5, 1.2), m.darkMetal, g).position.set(side * (6.3 + 1.75), -6.2, z)
    anchor(g, `plume-srb-${side < 0 ? 0 : 1}`, side * 6.3, -6.2, 21.8)
    return g
  })
  model.flightState = (s) => {
    const phase = s[S.SHUTTLE_PHASE]
    const time = s[S.MISSION_TIME]
    const boostAge = s[S.BOOSTER_SEP_TIME] < 0 ? -1 : Math.max(0, time - s[S.BOOSTER_SEP_TIME])
    boosters.forEach((g, i) => {
      g.visible = phase > 0 && phase < 6 && (boostAge < 0 || boostAge < 18)
      const age = Math.max(0, boostAge)
      // Separation motors push the boosters outward before they tumble away.
      g.position.set((i === 0 ? -1 : 1) * (age * 3 + age * age * 0.25), -age * 1.3 - age * age * 0.15, age * 7 + age * age * 1.2)
      g.rotation.z = (i === 0 ? -1 : 1) * age * 0.035
      g.rotation.x = age * 0.02
    })
    const tankAge = s[S.TANK_SEP_TIME] < 0 ? -1 : Math.max(0, time - s[S.TANK_SEP_TIME])
    tank.visible = phase > 0 && phase < 6 && (tankAge < 0 || tankAge < 25)
    const age = Math.max(0, tankAge)
    tank.position.set(0, -age * 1.2, age * 0.35)
    tank.rotation.x = age * 0.012
  }
  model.flightState(new Float64Array(S.LEN))
  return model
}

/** Revolve a (radius, model z) profile into a closed shell along model z. */
function lathe(profile: [number, number][], material: MeshStandardMaterial) {
  const geo = new LatheGeometry(profile.map(([r, z]) => new Vector2(r, -z)), 48)
  geo.rotateX(-Math.PI / 2)
  // Map v along the true length (v = 1 at the nose, the top canvas row) so bands land at their stations.
  const pos = geo.attributes.position, uv = geo.attributes.uv
  const zs = profile.map(([, z]) => z), z0 = Math.min(...zs), z1 = Math.max(...zs)
  for (let i = 0; i < pos.count; i++) uv.setY(i, 1 - (pos.getZ(i) - z0) / (z1 - z0))
  const shell = new Mesh(geo, material)
  shell.castShadow = shell.receiveShadow = true
  return shell
}

/** Nozzle bell from (radius, depth behind the throat) pairs; opens towards +z. */
function bell(profile: [number, number][]) {
  const geo = new LatheGeometry(profile.map(([r, d]) => new Vector2(r, -d)), 32)
  return geo.rotateX(-Math.PI / 2)
}

const nozzleMetal = new MeshStandardMaterial({ color: '#4a4d52', roughness: 0.38, metalness: 0.85, side: DoubleSide })

/** Spray-on foam insulation: rust orange, streaked, with the ribbed intertank band. */
function foamTexture() {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 1024
  const g = canvas.getContext('2d')!
  g.fillStyle = '#b0602f'; g.fillRect(0, 0, 512, 1024)
  let seed = 7
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  // Mottled foam: many soft blotches of slightly varied hue.
  for (let i = 0; i < 2600; i++) {
    const x = rand() * 512, y = rand() * 1024, r = 3 + rand() * 14
    g.fillStyle = rand() < 0.5 ? `rgba(120,58,24,${0.05 + rand() * 0.08})` : `rgba(206,126,70,${0.04 + rand() * 0.07})`
    g.beginPath(); g.ellipse(x, y, r, r * (1.5 + rand() * 2), 0, 0, Math.PI * 2); g.fill()
  }
  // Long vertical streaks from the spray passes and ascent heating.
  for (let i = 0; i < 260; i++) {
    const x = rand() * 512
    g.fillStyle = `rgba(${rand() < 0.5 ? '90,44,18' : '214,140,86'},${0.04 + rand() * 0.06})`
    g.fillRect(x, rand() * 1024, 1 + rand() * 3, 80 + rand() * 500)
  }
  // v = 0 at the nose tip (model z = -28.6); 48.35 m total length.
  const row = (z: number) => (z + 28.6) / 48.35 * 1024
  // Intertank: ribbed, slightly browner band between the LO2 and LH2 tanks.
  const top = row(-12.0), bottom = row(-5.1)
  g.fillStyle = 'rgba(96,52,26,0.35)'; g.fillRect(0, top, 512, bottom - top)
  for (let x = 0; x < 512; x += 6) {
    g.fillStyle = 'rgba(60,30,14,0.45)'; g.fillRect(x, top, 2, bottom - top)
    g.fillStyle = 'rgba(214,140,90,0.25)'; g.fillRect(x + 2, top, 1, bottom - top)
  }
  for (const z of [-12.0, -5.1, 3.5, 11.0, 16.6]) {
    g.fillStyle = 'rgba(70,34,14,0.5)'; g.fillRect(0, row(z) - 2, 512, 4)
  }
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace; texture.anisotropy = 8; texture.wrapS = RepeatWrapping
  return texture
}

/** Booster casing: off-white segments, darker field joints and a sooty aft skirt. */
function boosterTexture() {
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 1024
  const g = canvas.getContext('2d')!
  g.fillStyle = '#e9e7e0'; g.fillRect(0, 0, 256, 1024)
  let seed = 3
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(${rand() < 0.5 ? '150,150,145' : '255,255,250'},${0.03 + rand() * 0.05})`
    g.fillRect(rand() * 256, rand() * 1024, 2 + rand() * 6, 20 + rand() * 120)
  }
  // v = 0 at the nose (model z = -27.35); 47.35 m long.
  const row = (z: number) => (z + 27.35) / 47.35 * 1024
  for (const z of [-20.5, -12.2, -3.4, 5.4, 14.2]) {
    g.fillStyle = 'rgba(90,92,96,0.75)'; g.fillRect(0, row(z) - 3, 256, 6)
    g.fillStyle = 'rgba(40,42,46,0.4)'; g.fillRect(0, row(z) + 3, 256, 2)
  }
  const skirt = g.createLinearGradient(0, row(16.9), 0, 1024)
  skirt.addColorStop(0, 'rgba(60,58,56,0)'); skirt.addColorStop(1, 'rgba(60,58,56,0.55)')
  g.fillStyle = skirt; g.fillRect(0, row(16.9), 256, 1024 - row(16.9))
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace; texture.anisotropy = 8; texture.wrapS = RepeatWrapping
  return texture
}
