import { useFrame, useLoader } from '@react-three/fiber'
import { Sky, Stars, type AtmosphereApi, type SkyImpl, type StarsImpl } from '@takram/three-atmosphere/r3f'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { type Mesh, RepeatWrapping, SRGBColorSpace, TextureLoader, Vector3 } from 'three'
import { frame } from '../world/frame'
import { type CelestialState, LunarView, starIntensity, starRotation } from './celestial'
import { prepareSky, prepareStars, setSkyMoon, setStarMoon } from './celestialRendering'

const eye = new Vector3()

export function CelestialSky({ atmosphere, celestial }: {
  atmosphere: React.RefObject<AtmosphereApi | null>
  celestial: CelestialState
}) {
  const sky = useRef<SkyImpl>(null)
  const stars = useRef<StarsImpl>(null)
  const moon = useMemo(() => new LunarView(), [])
  const texture = useLoader(TextureLoader, `${import.meta.env.BASE_URL}atmosphere/moon-color.jpg`)
  useEffect(() => {
    texture.colorSpace = SRGBColorSpace
    texture.wrapS = RepeatWrapping
    texture.needsUpdate = true
  }, [texture])
  const bindSky = useCallback((mesh: Mesh | null) => {
    sky.current = mesh as SkyImpl | null
    if (sky.current) prepareSky(sky.current.material, texture)
  }, [texture])
  const bindStars = useCallback((points: StarsImpl | null) => {
    stars.current = points
    if (points) prepareStars(points.material)
  }, [])

  // Run after the library's frame callbacks (0), before the composer renders (1).
  // Its default star rotation assumes an ECEF scene; ours is a local tangent frame.
  useFrame(({ camera }) => {
    const atm = atmosphere.current
    if (!atm || !celestial.ready) return
    celestial.observeMoon(camera.getWorldPosition(eye).applyMatrix4(frame.ecefFromWorld), moon)
    if (sky.current) setSkyMoon(sky.current.material, moon, celestial)
    if (stars.current) {
      const points = stars.current
      starRotation(atm.inertialToECEFMatrix, frame.worldFromEcefRot, points.quaternion)
      const moonlight = Math.max(0, moon.direction.dot(moon.up)) * celestial.illuminatedFraction
      points.material.intensity = starIntensity(celestial.sunDirection.dot(moon.up), moonlight)
      points.visible = points.material.intensity > 0.001
      setStarMoon(points.material, moon)
    }
  }, 0.5)

  return <>
    <Sky ref={bindSky} />
    <Stars ref={bindStars} data={`${import.meta.env.BASE_URL}atmosphere/stars.bin`} background pointSize={2.2} intensity={0} />
  </>
}
