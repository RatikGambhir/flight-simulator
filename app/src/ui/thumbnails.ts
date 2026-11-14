// Render the procedural models in one temporary context and cache the images.

import {
  ACESFilmicToneMapping, DirectionalLight, HemisphereLight, PerspectiveCamera,
  PMREMGenerator, Scene, SRGBColorSpace, WebGLRenderer, type WebGLRenderTarget,
} from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { buildAircraft, disposeAircraftMeshes } from '../aircraft/models'
import type { LiveryId } from '../aircraft/liveries'

const WIDTH = 560
const HEIGHT = 320
const cache = new Map<string, string>()

class AircraftThumbnailRenderer {
  private readonly canvas = document.createElement('canvas')
  private readonly renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true })
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(30, WIDTH / HEIGHT, 0.1, 1000)
  private environment: WebGLRenderTarget | null = null

  constructor() {
    this.renderer.setSize(WIDTH, HEIGHT, false)
    this.renderer.outputColorSpace = SRGBColorSpace
    this.renderer.toneMapping = ACESFilmicToneMapping
    const room = new RoomEnvironment()
    const pmrem = new PMREMGenerator(this.renderer)
    try {
      this.environment = pmrem.fromScene(room, 0.04)
      this.scene.environment = this.environment.texture
    } catch (error) {
      this.dispose()
      throw error
    } finally {
      room.dispose()
      pmrem.dispose()
    }
    this.scene.add(new HemisphereLight('#cfe3ff', '#40372c', 1.2))
    const sun = new DirectionalLight('#ffffff', 2.4)
    sun.position.set(-30, 50, -20)
    this.scene.add(sun)
  }

  render(id: string, livery: LiveryId) {
    const { root, span, length } = buildAircraft(id, 0, livery)
    const size = Math.max(span, length)
    this.camera.position.set(-size * 1.15, size * 0.42, -size * 1.25)
    this.camera.lookAt(-size * 0.06, -size * 0.06, size * 0.1)
    this.scene.add(root)
    try {
      this.renderer.render(this.scene, this.camera)
      return this.canvas.toDataURL('image/png')
    } finally {
      root.removeFromParent()
      disposeAircraftMeshes(root)
    }
  }

  dispose() {
    this.environment?.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
  }
}

/** Render at most one new thumbnail per frame so the picker stays responsive. */
export function loadAircraftThumbnails(
  aircraft: { id: string; livery: LiveryId; key: string }[],
  onThumbnail: (key: string, src: string) => void,
) {
  const pending = aircraft.filter(({ key }) => {
    const src = cache.get(key)
    if (src) onThumbnail(key, src)
    return !src
  })
  let batch: AircraftThumbnailRenderer | null = null
  let frame = 0
  let next = 0
  const stop = () => {
    cancelAnimationFrame(frame)
    batch?.dispose()
    batch = null
  }
  const renderNext = () => {
    try {
      batch ??= new AircraftThumbnailRenderer()
      const { id, livery, key } = pending[next++]
      const src = batch.render(id, livery)
      cache.set(key, src)
      onThumbnail(key, src)
      if (next < pending.length) frame = requestAnimationFrame(renderNext)
      else stop()
    } catch (error) {
      stop()
      console.warn('Aircraft previews unavailable', error)
    }
  }
  if (pending.length) frame = requestAnimationFrame(renderNext)
  return stop
}
