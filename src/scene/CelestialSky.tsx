import { useFrame, useLoader } from '@react-three/fiber'
import { Sky, Stars, type AtmosphereApi, type SkyImpl, type StarsImpl } from '@takram/three-atmosphere/r3f'
import { useCallback, useEffect, useRef } from 'react'
import { type Mesh, Matrix4, RepeatWrapping, SRGBColorSpace, TextureLoader, Vector3 } from 'three'
import { frame } from '../world/frame'
import { type CelestialState, starIntensity, starRotation } from './celestial'
import { prepareMoon, prepareStars } from './celestialRendering'

const up = new Vector3()

export function CelestialSky({ atmosphere, celestial }: {
  atmosphere: React.RefObject<AtmosphereApi | null>
  celestial: CelestialState
}) {
  const sky = useRef<SkyImpl>(null)
  const stars = useRef<StarsImpl>(null)
  const texture = useLoader(TextureLoader, `${import.meta.env.BASE_URL}atmosphere/moon-color.jpg`)
  useEffect(() => {
    texture.colorSpace = SRGBColorSpace
    texture.wrapS = RepeatWrapping
    texture.needsUpdate = true
  }, [texture])
  const bindSky = useCallback((mesh: Mesh | null) => {
    sky.current = mesh as SkyImpl | null
    if (sky.current) prepareMoon(sky.current.material, texture)
  }, [texture])
  const bindStars = useCallback((points: StarsImpl | null) => {
    stars.current = points
    if (points) prepareStars(points.material)
  }, [])

  // Run after the library's frame callbacks (0), before the composer renders (1).
  // Its default star rotation assumes an ECEF scene; ours is a local tangent frame.
  useFrame(({ camera }) => {
    const atm = atmosphere.current
    if (!atm) return
    if (sky.current) {
      const material = sky.current.material
      material.moonAngularRadius = celestial.moonAngularRadius
      ;(material.uniforms.moonFixedFromECEF.value as Matrix4).copy(celestial.moonFixedFromECEF)
      ;(material.uniforms.moonSunDirection.value as Vector3).copy(celestial.moonSunDirection)
    }
    if (stars.current) {
      const points = stars.current
      starRotation(atm.inertialToECEFMatrix, frame.worldFromEcefRot, points.quaternion)
      frame.upAt(camera.position, up).transformDirection(frame.ecefFromWorld)
      const moonlight = Math.max(0, celestial.moonDirection.dot(up)) * celestial.illuminatedFraction
      points.material.intensity = starIntensity(celestial.sunDirection.dot(up), moonlight)
      points.visible = points.material.intensity > 0.001
      ;(points.material.uniforms.starMoonDirection.value as Vector3).copy(celestial.moonDirection)
      points.material.uniforms.starMoonCosRadius.value = Math.cos(celestial.moonAngularRadius)
    }
  }, 0.5)

  return <>
    <Sky ref={bindSky} />
    <Stars ref={bindStars} data={`${import.meta.env.BASE_URL}atmosphere/stars.bin`} background pointSize={2.2} intensity={0} />
  </>
}
