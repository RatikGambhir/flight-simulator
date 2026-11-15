import { BoxGeometry, CylinderGeometry, Group, Mesh, ShaderMaterial, Vector3 } from 'three'
import { tubeGeometry, wingPanelGeometry, type WingParams } from '../geometry'
import { aircraftLivery, createMaterials, paintDarkFuselage, paintX15Tail } from '../materials'
import { buildWings, gearLeg, mesh, newModel, type AircraftModel } from './parts'

const NOSE = -7.9
const TAIL = 7.34
const SPAN = 6.71

function addRocket(model: AircraftModel) {
  const { root, materials: m } = model
  const nozzle = new CylinderGeometry(0.55, 0.4, 0.72, 32, 1, true)
  nozzle.rotateX(Math.PI / 2).translate(0, -0.08, TAIL - 0.36)
  mesh(nozzle, m.darkMetal, root, 'XLR99 nozzle')
  const chamber = new CylinderGeometry(0.39, 0.39, 0.08, 24)
  chamber.rotateX(Math.PI / 2).translate(0, -0.08, TAIL - 0.67)
  mesh(chamber, m.belly, root)

  const plumeGeometry = new CylinderGeometry(0.75, 0.36, 6, 24, 1, true)
  plumeGeometry.rotateX(Math.PI / 2).translate(0, 0, 3)
  const material = new ShaderMaterial({
    uniforms: { power: { value: 0 }, time: { value: 0 } },
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>
      varying vec2 vUv;
      uniform float power;
      uniform float time;
      void main() {
        #include <logdepthbuf_fragment>
        float ripple = sin(vUv.y * 78.0 - time * 32.0 + 0.5 * sin(vUv.x * 25.13));
        float core = pow(1.0 - vUv.y, 3.0);
        vec3 color = mix(vec3(1.0, 0.13, 0.018), vec3(3.6, 2.0, 0.9), core + ripple * 0.07);
        float alpha = (1.0 - smoothstep(0.1, 1.0, vUv.y)) * power * (0.85 + 0.1 * ripple);
        gl_FragColor = vec4(color, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  })
  const plume = new Mesh(plumeGeometry, material)
  plume.name = 'XLR99 exhaust'
  plume.position.set(0, -0.08, TAIL - 0.22)
  plume.visible = false
  root.add(plume)
  model.exhaust = (power, _afterburner, time) => {
    plume.visible = power > 0.02
    material.uniforms.power.value = power
    material.uniforms.time.value = time
    plume.scale.setScalar(0.6 + 0.4 * power)
    plume.scale.z = 0.4 + power
  }
}

export function buildX15() {
  const livery = aircraftLivery('x15')
  const m = createMaterials(livery, paintDarkFuselage(livery), paintX15Tail(livery))
  m.fuselage.clearcoat = m.wing.clearcoat = m.tail.clearcoat = 0.12
  m.fuselage.roughness = m.wing.roughness = m.tail.roughness = 0.64
  m.wing.color.set(livery.base)
  m.wingDark.color.set('#35353a')
  m.glass.color.set('#1b242e')
  const model = newModel('x15', 'rocket', m)
  const { root } = model

  model.exteriorOnly.push(mesh(tubeGeometry([
    { z: NOSE, hw: 0.03, hh: 0.03, yc: -0.12 },
    { z: -7.58, hw: 0.20, hh: 0.18, yc: -0.09 },
    { z: -6.92, hw: 0.40, hh: 0.32, yc: -0.03 },
    { z: -5.90, hw: 0.57, hh: 0.48, yc: 0.02 },
    { z: -4.55, hw: 0.68, hh: 0.59, yc: 0.03 },
    { z: -2.92, hw: 0.76, hh: 0.66, yc: 0.03 },
    { z: 0, hw: 0.78, hh: 0.70, yc: 0.02 },
    { z: 3.65, hw: 0.76, hh: 0.68, yc: 0 },
    { z: 6.25, hw: 0.68, hh: 0.58, yc: -0.02 },
    { z: TAIL, hw: 0.56, hh: 0.51, yc: -0.08 },
  ], 36, 2.28), m.fuselage, root, 'fuselage'))

  const canopy = tubeGeometry([
    { z: -6.53, hw: 0.05, hh: 0.015, yc: 0.41 },
    { z: -5.73, hw: 0.35, hh: 0.27, yc: 0.52 },
    { z: -5.26, hw: 0.43, hh: 0.36, yc: 0.57 },
    { z: -4.53, hw: 0.44, hh: 0.37, yc: 0.56 },
    { z: -3.70, hw: 0.41, hh: 0.21, yc: 0.57 },
    { z: -2.90, hw: 0.23, hh: 0.04, yc: 0.62 },
  ], 28, 2.65)
  // The small left and right windshields sit in an otherwise opaque canopy.
  model.exteriorOnly.push(mesh(canopy, m.paint, root, 'canopy'))
  for (const side of [1, -1]) {
    const glass = new BoxGeometry(0.25, 0.027, 0.63)
    glass.rotateZ(-side * 0.82).rotateX(-0.32)
    glass.translate(side * 0.28, 0.73, -5.65)
    model.exteriorOnly.push(mesh(glass, m.glass, root, 'windshield'))
    const strake = tubeGeometry([
      { z: -2.5, hw: 0.01, hh: 0.02, yc: -0.34 },
      { z: -0.7, hw: 0.17, hh: 0.17, yc: -0.34 },
      { z: 5.8, hw: 0.19, hh: 0.18, yc: -0.34 },
      { z: 6.85, hw: 0.02, hh: 0.07, yc: -0.32 },
    ], 14)
    strake.translate(side * 0.69, 0, 0)
    mesh(strake, m.paint, root, 'side fairing')
  }

  const wing: WingParams = {
    span: SPAN / 2 - 0.58, rootChord: 3.48, tipChord: 1.34, sweep: 28,
    dihedral: -1.5, thicknessRoot: 0.085, thicknessTip: 0.055, camber: 0,
  }
  buildWings(model, root, { params: wing, at: new Vector3(0.58, 0, -0.30), mat: m.wing, surfaceMat: m.wing })
  const stabilizer: WingParams = {
    span: 1.84, rootChord: 2.35, tipChord: 0.95, sweep: 36,
    dihedral: -7, thicknessRoot: 0.10, thicknessTip: 0.07, camber: 0,
  }
  for (const side of [1, -1] as const) {
    const tail = new Group()
    tail.position.set(0.53 * side, -0.04, 4.82)
    root.add(tail)
    const half = wingPanelGeometry(stabilizer, 0, 1, 0, 1, side, 10, 12)
    half.translate(0, 0, -0.58)
    tail.position.z += 0.58
    mesh(half, m.wingDark, tail, 'all-moving stabilizer')
    // The two pivots use opposite span axes for the controller's elevon mixing.
    if (side === -1) {
      half.rotateZ(Math.PI)
      tail.rotateZ(Math.PI)
    }
    model.surfaces.push({ pivot: tail, restQuaternion: tail.quaternion.clone(), kind: 'elevon', max: 0.32, sign: side })
  }

  const fin: WingParams = {
    span: 2.67, rootChord: 3.1, tipChord: 1.20, sweep: 25, dihedral: 0,
    thicknessRoot: 0.23, thicknessTip: 0.20, vertical: true, camber: 0,
  }
  const finGeometry = wingPanelGeometry(fin, 0, 1, 0, 1, 1, 16, 20)
  const uv = finGeometry.getAttribute('uv')
  const pos = finGeometry.getAttribute('position')
  for (let i = 0; i < uv.count; i++) {
    if (pos.getX(i) > 0) uv.setX(i, 1 - uv.getX(i))
  }
  const rudder = new Group()
  rudder.position.set(0, 0.44, 4.13)
  rudder.rotateZ(Math.PI / 2)
  finGeometry.rotateZ(-Math.PI / 2)
  mesh(finGeometry, m.tail, rudder, 'NASA · 66672 dorsal fin')
  root.add(rudder)
  model.surfaces.push({ pivot: rudder, restQuaternion: rudder.quaternion.clone(), kind: 'rudder', max: 0.26, sign: 1 })
  const ventral = wingPanelGeometry({ ...fin, span: 0.90, tipChord: 1.6, sweep: 28 }, 0, 1)
  ventral.rotateZ(Math.PI).translate(0, -0.5, 4.14)
  mesh(ventral, m.paint, root, 'ventral fin')

  gearLeg(model, root, new Vector3(0, -0.30, -4.85), -1.28, 0.25, [-0.09, 0.09], 'x', -1.45, m)
  for (const side of [1, -1]) {
    const skid = new Group()
    skid.position.set(side * 0.68, -0.33, 3.05)
    root.add(skid)
    const strut = new BoxGeometry(0.09, 1.18, 0.20).translate(0, -0.59, 0)
    const shoe = new BoxGeometry(0.16, 0.10, 0.85).translate(0, -1.15, 0.05)
    mesh(strut, m.darkMetal, skid, 'skid strut')
    mesh(shoe, m.metal, skid, 'landing skid')
    model.gear.push({ pivot: skid, axis: 'x', retracted: 1.5 })

    const brake = new Group()
    brake.position.set(side * 0.37, 1.02, 6.28)
    brake.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2)
    root.add(brake)
    const panel = new BoxGeometry(0.52, 0.04, 0.46).translate(0.10, 0, 0.19)
    mesh(panel, m.wingDark, brake, 'speed brake')
    model.surfaces.push({ pivot: brake, restQuaternion: brake.quaternion.clone(), kind: 'spoiler', max: 0.75, sign: side })
  }

  model.eye.set(0, 0.76, -5.01)
  model.cockpitLookPitch = -0.16
  model.span = SPAN
  model.length = TAIL - NOSE
  addRocket(model)
  return model
}
