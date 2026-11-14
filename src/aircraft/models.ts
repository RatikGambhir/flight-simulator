// Procedural exterior models for each aircraft. Every model is built around
// the simulation's reference point (centre of gravity) with x right, y up and
// the nose toward -z. Moving parts are exposed for animation.

import { Texture, type BufferGeometry, type Material, type Mesh, type Object3D } from 'three'
import { build737, buildA320, buildA380 } from './exterior/airliners'
import { buildBizjet, buildLongitude } from './exterior/businessJets'
import { buildCessna } from './exterior/cessna'
import { buildFighter } from './exterior/fighter'
import type { AircraftModel } from './exterior/parts'

export type { AircraftModel, ControlSurface, GearLeg, LampKind, ModelLamp, Spinner, SurfaceKind } from './exterior/parts'

const BUILDERS: Record<string, () => AircraftModel> = {
  b737: build737,
  a320: buildA320,
  a380: buildA380,
  bizjet: buildBizjet,
  longitude: buildLongitude,
  c172: buildCessna,
  f16: buildFighter,
}

/** Builds (and enables lighting-mask layers on) the exterior model for an aircraft id. */
export function buildAircraft(id: string, lightingLayer: number): AircraftModel {
  const build = BUILDERS[id] ?? BUILDERS.b737
  const model = build()
  model.root.traverse((o) => {
    const mat = (o as Mesh).material as Material | undefined
    // Transparent parts stay in the post-process-lit layer (blended over the scenery).
    if (mat && mat.transparent) return
    o.layers.enable(lightingLayer)
  })
  return model
}

/** Releases mesh resources owned by a procedural aircraft or cockpit. */
export function disposeAircraftMeshes(root: Object3D, disposeTextures = true) {
  const geometries = new Set<BufferGeometry>()
  const materials = new Set<Material>()
  const textures = new Set<Texture>()
  root.traverse((object) => {
    const mesh = object as Mesh
    if (!mesh.isMesh) return
    geometries.add(mesh.geometry)
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material)
  })
  for (const material of materials) {
    if (disposeTextures) {
      for (const value of Object.values(material)) {
        if (value instanceof Texture) textures.add(value)
      }
    }
    material.dispose()
  }
  for (const geometry of geometries) geometry.dispose()
  for (const texture of textures) texture.dispose()
}

