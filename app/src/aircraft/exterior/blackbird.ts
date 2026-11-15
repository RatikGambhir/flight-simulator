import {
  AdditiveBlending, BufferGeometry, CircleGeometry, DoubleSide, Float32BufferAttribute, Group,
  Mesh, MeshBasicMaterial, Object3D, Quaternion, ShaderMaterial, Vector3,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { hingeFrame, revolveZ, toHingeLocal, tubeGeometry, wingPanelGeometry, wingPoint, type Station, type WingParams } from '../geometry'
import { aircraftLivery, createMaterials, paintBlackbird, paintBlackbirdAirfoil } from '../materials'
import type { LiveryId } from '../liveries'
import { gearLeg, mesh, navLights, newModel, type AircraftModel } from './parts'

const NOSE = -19.6
const TAIL = 13.13
const NACELLE_X = 4.38
const NACELLE_Y = 0.08
const INLET = -4.22
const EXHAUST = 11.15

type Profile = [z: number, halfWidth: number, halfHeight: number, center: number]
const stations = (profile: Profile[]): Station[] => profile.map(([z, hw, hh, yc]) => ({ z, hw, hh, yc }))

function shell(profile: Profile[]) {
  const geometry = tubeGeometry(stations(profile), 40, 2.1)
  const uv = geometry.getAttribute('uv')
  for (let i = 0; i < uv.count; i++) uv.setY(i, (geometry.attributes.position.getZ(i) - NOSE) / (TAIL - NOSE))
  return geometry
}

function surface(points: Vector3[]) {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(points.flatMap((p) => p.toArray()), 3))
  geometry.setIndex([0, 1, 2, 0, 2, 3])
  geometry.computeVertexNormals()
  return geometry
}

function addCanopies(model: AircraftModel) {
  const frames: BufferGeometry[] = []
  const windows: BufferGeometry[] = []
  for (const rings of [
    [[-15.02, 0.50, 0.61, 0.12, 0.72], [-14.01, 0.66, 0.69, 0.31, 1.38], [-11.90, 0.69, 0.72, 0.33, 1.42], [-11.40, 0.65, 0.75, 0.35, 1.18]],
    [[-11.40, 0.66, 0.75, 0.35, 1.18], [-11.00, 0.70, 0.79, 0.34, 1.41], [-9.47, 0.73, 0.80, 0.35, 1.40], [-8.25, 0.70, 0.83, 0.35, 0.86]],
  ]) {
    const rows = rings.map(([z, sillX, sillY, roofX, roofY]) => [
      new Vector3(-sillX, sillY, z), new Vector3(-roofX, roofY, z),
      new Vector3(0, roofY + 0.035, z), new Vector3(roofX, roofY, z), new Vector3(sillX, sillY, z),
    ])
    for (let i = 0; i < rows.length - 1; i++) {
      for (let j = 0; j < 4; j++) {
        const pane = [rows[i][j], rows[i + 1][j], rows[i + 1][j + 1], rows[i][j + 1]]
        frames.push(surface(pane))
        const side = j === 0 || j === 3
        const windshield = i === 0 && rows[0][2].y < 1
        if (!(side && i < 2) && !windshield) continue
        const center = new Vector3()
        for (const p of pane) center.addScaledVector(p, 0.25)
        const offset = pane[1].clone().sub(pane[0]).cross(pane[3].clone().sub(pane[0])).normalize().multiplyScalar(0.004)
        windows.push(surface(pane.map((p) => p.clone().lerp(center, 0.09).add(offset))))
      }
    }
  }
  model.exteriorOnly.push(
    mesh(mergeGeometries(frames), model.materials.paint, model.root, 'tandem-canopy-frames'),
    mesh(mergeGeometries(windows), model.materials.glass, model.root, 'tandem-canopy-glass'),
  )
  for (const geometry of [...frames, ...windows]) geometry.dispose()
}

function addWings(model: AircraftModel) {
  const { tail, accent } = model.materials
  for (const side of [-1, 1] as const) {
    for (const [x, z, span, rootChord, tipChord, lead, hinge] of [
      [1.05, -9.20, 3.37, 19.65, 14.88, 4.86, 0.89],
      [4.40, -4.32, 4.07, 14.62, 5.04, 7.78, 0.82],
    ]) {
      const wing: WingParams = {
        span, rootChord, tipChord, sweep: Math.atan2(lead, span) * 180 / Math.PI,
        dihedral: 0, camber: 0, thicknessRoot: x < 2 ? 0.048 : 0.047, thicknessTip: 0.032,
      }
      const group = new Group()
      group.position.set(x * side, -0.08, z)
      model.root.add(group)
      mesh(wingPanelGeometry(wing, 0, 1, 0, hinge, side, 12, 22), tail, group, 'delta-wing')
      const h = hingeFrame(wing, 0, 1, hinge, side)
      const pivot = new Object3D()
      pivot.position.copy(h.origin)
      pivot.quaternion.copy(h.quat)
      group.add(pivot)
      // Narrow physical clearance at both ends of the moving section.
      const elevon = wingPanelGeometry(wing, 0.014, 0.985, hinge + 0.001, 1, side, 7, 8)
      const rootEdge = wingPanelGeometry(wing, 0, 0.014, hinge, 1, side, 1, 6)
      const tipEdge = wingPanelGeometry(wing, 0.985, 1, hinge, 1, side, 1, 6)
      mesh(mergeGeometries([rootEdge, tipEdge]), tail, group)
      rootEdge.dispose()
      tipEdge.dispose()
      mesh(toHingeLocal(elevon, h.origin, h.quat), tail, pivot, 'elevon')
      model.surfaces.push({ pivot, restQuaternion: h.quat, kind: 'elevon', max: 0.29, sign: side })
      if (x > 4 && side === 1) model.wingTipRight.copy(wingPoint(wing, 1, 0.69)).add(group.position)
    }

    // The entire fin moves. It leans inward and pivots on its own span axis.
    const fin: WingParams = {
      span: 2.13, rootChord: 5.18, tipChord: 1.31, sweep: 54, dihedral: 0,
      thicknessRoot: 0.070, thicknessTip: 0.059, vertical: true, camber: 0,
    }
    const mount = new Group()
    mount.position.set(NACELLE_X * side, 1.04, 4.87)
    mount.rotation.z = side * Math.PI / 12
    model.root.add(mount)
    const root = wingPanelGeometry(fin, 0, 0.13, 0, 1, 1, 2, 20)
    mesh(root, accent, mount)
    const hinge = new Object3D()
    const axis = new Vector3(0, 1, 0)
    const rest = new Quaternion().setFromUnitVectors(new Vector3(1, 0, 0), axis)
    hinge.position.set(0, 0.12 * fin.span, 2.64)
    hinge.quaternion.copy(rest)
    mount.add(hinge)
    const blade = wingPanelGeometry(fin, 0.13, 1, 0, 1, 1, 9, 20)
    mesh(toHingeLocal(blade, hinge.position, rest), tail, hinge, 'inward-canted-fin')
    model.surfaces.push({ pivot: hinge, restQuaternion: rest, kind: 'rudder', max: 0.23, sign: 1 })
  }
}

function addEngines(model: AircraftModel) {
  const m = model.materials
  // Profiles are listed from nose to tail in model-space z coordinates.
  const cowl = revolveZ([[1.06, INLET], [1.18, -3.93], [1.31, -2.50], [1.35, -0.18], [1.30, 3.55], [1.18, 6.96], [1.05, 8.83], [0.99, 9.79]])
  const inlet = revolveZ([[1.06, INLET], [0.98, INLET + 0.035], [0.94, -3.78], [0.94, -2.38], [0.08, -2.34]])
  const spike = revolveZ([[0.005, -6.30], [0.16, -5.98], [0.43, -5.15], [0.73, -4.02], [0.79, -3.40], [0.75, -2.49], [0.02, -2.31]])
  const petal = revolveZ([[1.01, 9.76], [0.98, 10.08], [0.94, 10.52], [0.85, EXHAUST], [0.79, EXHAUST], [0.83, 10.35], [0.84, 9.87]], 24)
  const throat = new CircleGeometry(0.85, 32).translate(0, 0, 9.95)
  const chamber = throat.clone().translate(0, 0, -0.02)
  const flame = revolveZ([[0.78, 0], [0.72, 0.7], [0.59, 1.8], [0.46, 3.1], [0.30, 4.7], [0.006, 6.7]], 32)
  const glow = new MeshBasicMaterial({ color: '#ff934d', transparent: true, opacity: 0.06, blending: AdditiveBlending, depthWrite: false })
  const fire = new ShaderMaterial({
    uniforms: { power: { value: 0 }, time: { value: 0 } },
    transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide, forceSinglePass: true,
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 viewNormal;
      varying vec3 viewDirection;
      varying float distanceAlong;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        viewNormal = normalMatrix * normal;
        viewDirection = -viewPosition.xyz;
        distanceAlong = position.z;
        gl_Position = projectionMatrix * viewPosition;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      varying vec3 viewNormal;
      varying vec3 viewDirection;
      varying float distanceAlong;
      uniform float power;
      uniform float time;
      void main() {
        #include <logdepthbuf_fragment>
        float core = abs(dot(normalize(viewNormal), normalize(viewDirection)));
        float z = distanceAlong;
        float diamonds = pow(0.5 + 0.5 * cos(z * 6.7 + sin(time * 32.0) * 0.23), 5.0);
        float fade = 1.0 - smoothstep(0.15, 6.7, z);
        vec3 color = mix(vec3(1.0, 0.19, 0.035), vec3(0.58, 0.72, 1.0), diamonds * 0.85);
        gl_FragColor = vec4(color, power * fade * smoothstep(0.03, 0.82, core) * (0.27 + diamonds * 0.62));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  })

  const spikes: Mesh[] = []
  const plumes: Mesh[] = []
  for (const side of [-1, 1]) {
    const engine = new Group()
    engine.position.set(NACELLE_X * side, NACELLE_Y, 0)
    model.root.add(engine)
    mesh(cowl, m.paint, engine, 'j58-nacelle')
    mesh(inlet, m.darkMetal, engine, 'inlet-duct')
    spikes.push(mesh(spike, m.belly, engine, 'inlet-spike'))
    mesh(petal, m.darkMetal, engine, 'ejector-nozzle')
    mesh(chamber, m.fan, engine)
    engine.add(new Mesh(throat, glow))
    const plume = new Mesh(flame, fire)
    plume.name = 'afterburner-plume'
    plume.position.z = EXHAUST
    plume.visible = false
    engine.add(plume)
    plumes.push(plume)
  }
  model.exhaust = (engine, afterburner, time, mach) => {
    // The inlet centerbody translates aft as the aircraft accelerates past Mach 1.6.
    const travel = Math.max(0, Math.min(1, (mach - 1.6) / 1.6)) * 0.66
    for (const spike of spikes) spike.position.z = travel
    glow.opacity = 0.04 + 0.21 * engine * engine + 0.60 * afterburner
    fire.uniforms.power.value = 0.4 + afterburner * 0.6
    fire.uniforms.time.value = time
    for (const plume of plumes) {
      plume.visible = afterburner > 0.001
      plume.scale.z = 0.48 + afterburner * 0.52 + 0.026 * Math.sin(time * 47)
    }
  }
}

/** Procedural SR-71A, using the NASA three-view and production airframe dimensions. */
export function buildBlackbird(theme?: LiveryId): AircraftModel {
  const livery = aircraftLivery('sr71', theme)
  const materials = createMaterials(livery, paintBlackbird(livery), paintBlackbirdAirfoil(livery))
  materials.fuselage.emissive.set(0x000000)
  for (const material of [materials.fuselage, materials.paint, materials.belly, materials.tail, materials.accent]) {
    material.roughness = 0.68
    material.metalness = 0.12
    material.clearcoat = 0.04
    material.clearcoatRoughness = 0.58
  }
  materials.accent.color.set(livery.tail)
  materials.glass.color.set('#242e34')
  materials.glass.roughness = 0.16
  materials.glass.clearcoat = 0.58
  const model = newModel('sr71', 'blackbird', materials)
  const root = model.root
  const join: Profile = [-14.95, 0.63, 0.49, -0.07]
  mesh(shell([
    [NOSE, 0.005, 0.005, -0.11], [-19.27, 0.17, 0.12, -0.11], [-18.6, 0.30, 0.23, -0.10],
    [-17.65, 0.43, 0.33, -0.10], [-16.45, 0.54, 0.43, -0.08], join,
  ]), materials.fuselage, root, 'nose')
  model.exteriorOnly.push(mesh(shell([
    join, [-13.50, 0.71, 0.66, -0.01], [-11.62, 0.79, 0.75, 0.01], [-9.55, 0.88, 0.81, 0.01],
    [-7.80, 1.01, 0.89, 0.015], [-5.54, 1.16, 1.03, 0.02], [-3.10, 1.29, 1.11, 0.02],
    [0.10, 1.32, 1.17, 0.02], [3.32, 1.23, 1.05, 0.06], [5.85, 1.10, 0.82, 0.10],
    [8.65, 0.92, 0.54, 0.10], [10.5, 0.66, 0.32, 0.11], [12.28, 0.32, 0.13, 0.10], [TAIL, 0.008, 0.01, 0.09],
  ]), materials.fuselage, root, 'fuselage'))
  // The shallow chines form one continuous edge from the probe to the delta root.
  mesh(shell([
    [NOSE + 0.04, 0.005, 0.012, -0.105], [-18.91, 0.30, 0.07, -0.10], [-17.98, 0.62, 0.12, -0.09],
    [-16.32, 1.01, 0.22, -0.08], [-14.81, 1.24, 0.29, -0.07], [-12.21, 1.53, 0.37, -0.055],
    [-9.55, 1.88, 0.45, -0.04], [-7.52, 2.41, 0.49, -0.025], [-5.14, 3.46, 0.50, -0.01],
    [-3.4, 3.48, 0.43, -0.01], [0, 2.58, 0.31, -0.025], [5.32, 1.68, 0.21, -0.055],
    [9.67, 1.40, 0.13, -0.053], [11.11, 0.83, 0.08, -0.01], [13.05, 0.009, 0.009, 0.09],
  ]), materials.fuselage, root, 'fuselage-chines')
  addCanopies(model)
  addWings(model)
  addEngines(model)

  for (const side of [-1, 1]) {
    gearLeg(model, root, new Vector3(side * 2.34, -0.43, 1.9), -2.65 + 0.44, 0.44, [-0.30, 0, 0.30], 'z', -side * 1.51, materials)
  }
  gearLeg(model, root, new Vector3(0, -0.66, -9.50), -2.65 + 0.34, 0.34, [-0.13, 0.13], 'x', -1.50, materials)
  navLights(model, model.wingTipRight, new Vector3(0, 0.10, TAIL - 0.1), new Vector3(0, 0.83, -8.14), new Vector3(0, -1.12, -3.03), {
    landing: [new Vector3(-0.22, -0.67, -9.55), new Vector3(0.22, -0.67, -9.55)],
  })

  model.eye.set(0, 1.13, -12.42)
  model.cockpitLookPitch = -0.22
  model.span = 16.94
  model.length = TAIL - NOSE
  return model
}
