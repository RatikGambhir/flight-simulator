import { Color, Mesh, MeshBasicMaterial, MeshStandardMaterial, type Object3D } from 'three'

/** Dim panel backlights and displays at night without losing their daytime settings. */
export class CockpitLighting {
  private readonly backlights = new Map<MeshStandardMaterial, number>()
  private readonly displays = new Map<MeshBasicMaterial, Color>()
  private previous = -1

  constructor(root: Object3D) {
    root.traverse(object => {
      if (!(object instanceof Mesh)) return
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material instanceof MeshStandardMaterial) {
          this.backlights.set(material, material.emissiveIntensity)
        } else if (material instanceof MeshBasicMaterial && material.map) {
          this.displays.set(material, material.color.clone())
        }
      }
    })
  }

  update(night: number) {
    const darkness = Math.max(0, Math.min(1, night))
    if (darkness === this.previous) return
    this.previous = darkness
    for (const [material, intensity] of this.backlights) {
      material.emissiveIntensity = intensity * (1 - darkness * 0.85)
    }
    for (const [material, color] of this.displays) {
      material.color.copy(color).multiplyScalar(1 - darkness * 0.9)
    }
  }
}
