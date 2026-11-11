// Renders aircraft thumbnails from the real procedural models (once, cached).

import { ACESFilmicToneMapping, DirectionalLight, HemisphereLight, PerspectiveCamera, PMREMGenerator, Scene, SRGBColorSpace, WebGLRenderer } from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { buildAircraft } from '../aircraft/models'

const cache = new Map<string, string>()

export function aircraftThumbnail(id: string): string {
  const hit = cache.get(id)
  if (hit) return hit
  const canvas = document.createElement('canvas')
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true })
  renderer.setSize(560, 320, false)
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping
  const scene = new Scene()
  const pmrem = new PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.add(new HemisphereLight('#cfe3ff', '#40372c', 1.2))
  const sun = new DirectionalLight('#ffffff', 2.4)
  sun.position.set(-30, 50, -20)
  scene.add(sun)
  const model = buildAircraft(id, 0)
  model.root.getObjectByName('cockpit')?.removeFromParent()
  scene.add(model.root)
  const size = Math.max(model.span, model.length)
  const cam = new PerspectiveCamera(30, 560 / 320, 0.1, 1000)
  cam.position.set(-size * 1.15, size * 0.42, -size * 1.25)
  cam.lookAt(-size * 0.06, -size * 0.06, size * 0.1)
  renderer.render(scene, cam)
  const url = canvas.toDataURL('image/png')
  pmrem.dispose()
  renderer.dispose()
  renderer.forceContextLoss()
  cache.set(id, url)
  return url
}
