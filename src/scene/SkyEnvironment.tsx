// A lightweight reflection environment for the aircraft's PBR materials:
// a sky gradient matched to the current sun elevation, prefiltered with
// PMREM and refreshed every few seconds (sky light comes from SkyLightProbe).

import { useFrame, useThree } from '@react-three/fiber'
import type { AtmosphereApi } from '@takram/three-atmosphere/r3f'
import { useEffect, useMemo, useRef } from 'react'
import { BackSide, Color, Mesh, PMREMGenerator, Scene, ShaderMaterial, SphereGeometry, Vector3, type WebGLRenderTarget } from 'three'
import { frame } from '../world/frame'

const vert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

const frag = /* glsl */ `
uniform vec3 sunDir;
uniform vec3 up;
uniform vec3 zenith;
uniform vec3 horizon;
uniform vec3 ground;
uniform vec3 sunColor;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = dot(d, up);
  vec3 sky = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.45));
  vec3 col = h >= 0.0 ? sky : mix(horizon * 0.6, ground, clamp(-h * 6.0, 0.0, 1.0));
  float s = max(dot(d, sunDir), 0.0);
  col += sunColor * (pow(s, 600.0) * 40.0 + pow(s, 12.0) * 0.6);
  gl_FragColor = vec4(col, 1.0);
}`

export function SkyEnvironment({ atmosphere }: { atmosphere: React.RefObject<AtmosphereApi | null> }) {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const pmrem = useMemo(() => new PMREMGenerator(gl), [gl])
  const envScene = useMemo(() => new Scene(), [])
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: vert,
        fragmentShader: frag,
        side: BackSide,
        uniforms: {
          sunDir: { value: new Vector3(0, 1, 0) },
          up: { value: new Vector3(0, 1, 0) },
          zenith: { value: new Color() },
          horizon: { value: new Color() },
          ground: { value: new Color() },
          sunColor: { value: new Color() },
        },
      }),
    [],
  )
  const target = useRef<WebGLRenderTarget | null>(null)
  const last = useRef({ t: 0, elev: -2 })

  useEffect(() => {
    const m = new Mesh(new SphereGeometry(10, 32, 16), material)
    envScene.add(m)
    return () => {
      envScene.remove(m)
      m.geometry.dispose()
      material.dispose()
      target.current?.dispose()
      pmrem.dispose()
      scene.environment = null
    }
  }, [envScene, material, pmrem, scene])

  useFrame(() => {
    const atm = atmosphere.current
    if (!atm) return
    const now = performance.now()
    const sun = new Vector3().copy(atm.sunDirection).applyQuaternion(frame.worldFromEcefRot).normalize()
    const up = new Vector3(0, 1, 0)
    const elev = sun.dot(up)
    if (now - last.current.t < 3000 && Math.abs(elev - last.current.elev) < 0.02) return
    last.current = { t: now, elev }
    const day = Math.max(0, Math.min(1, (elev + 0.08) / 0.4))
    const golden = Math.max(0, 1 - Math.abs(elev - 0.08) / 0.18)
    const u = material.uniforms
    u.sunDir.value.copy(sun)
    u.up.value.copy(up)
    u.zenith.value.setRGB(0.05 * day + 0.002, 0.12 * day + 0.003, 0.32 * day + 0.008)
    u.horizon.value.setRGB(0.22 * day + 0.25 * golden + 0.004, 0.3 * day + 0.12 * golden + 0.005, 0.42 * day + 0.04 * golden + 0.01)
    u.ground.value.setRGB(0.06 * day + 0.002, 0.06 * day + 0.002, 0.05 * day + 0.002)
    u.sunColor.value.setRGB(1.0, 0.85 + 0.15 * (1 - golden), 0.7 + 0.3 * (1 - golden)).multiplyScalar(elev > -0.02 ? 1 : 0)
    const rt = pmrem.fromScene(envScene, 0, 0.1, 100)
    target.current?.dispose()
    target.current = rt
    scene.environment = rt.texture
    scene.environmentIntensity = 0.35
  })
  return null
}
