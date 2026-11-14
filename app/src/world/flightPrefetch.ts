import { PerspectiveCamera, Vector3 } from 'three'

/** A low-resolution streaming view, never rendered, looking ahead along velocity. */
export class FlightPrefetch {
  readonly camera = new PerspectiveCamera(70, 1, 10, 30000)
  readonly target = new Vector3()
  private readonly direction = new Vector3()

  update(position: Vector3, velocity: Vector3, up: Vector3, agl: number, enabled: boolean) {
    this.direction.copy(velocity).addScaledVector(up, -velocity.dot(up))
    const speed = this.direction.length()
    if (!enabled || speed < 25) return false
    this.direction.multiplyScalar(1 / speed)
    const height = Math.max(0, agl)
    const lead = Math.min(6000, Math.max(600, speed * 12))
    this.target.copy(position).addScaledVector(this.direction, lead).addScaledVector(up, -height)
    this.camera.position.copy(this.target)
      .addScaledVector(up, Math.max(1200, height * 0.8))
      .addScaledVector(this.direction, -Math.max(500, height * 0.2))
    this.camera.up.copy(up)
    this.camera.lookAt(this.target)
    const far = Math.min(80000, Math.max(8000, height * 2.5))
    if (far !== this.camera.far) {
      this.camera.far = far
      this.camera.updateProjectionMatrix()
    }
    this.camera.updateMatrixWorld()
    return true
  }
}
