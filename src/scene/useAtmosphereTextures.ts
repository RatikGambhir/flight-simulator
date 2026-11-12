import { useThree } from '@react-three/fiber'
import { PrecomputedTexturesGenerator, type PrecomputedTextures } from '@takram/three-atmosphere'
import { useEffect, useState } from 'react'

/** Own each asynchronous precomputation for exactly one effect lifetime. */
export function useAtmosphereTextures() {
  const renderer = useThree((state) => state.gl)
  const [textures, setTextures] = useState<PrecomputedTextures | null>(null)

  useEffect(() => {
    // The library's Atmosphere memoizes its generator, then disposes it in an
    // effect. StrictMode and Fast Refresh rerun that effect on the SAME generator.
    // Its queued disposal can then delete the active sky/cloud lighting textures
    // after precomputation finishes. A fresh generator per setup avoids that race.
    let generator: PrecomputedTexturesGenerator | null = null
    let active = true
    setTextures(null)
    // React's development-only setup/cleanup runs before this frame, so only
    // the mounted scene starts the expensive GPU work.
    const start = requestAnimationFrame(() => {
      generator = new PrecomputedTexturesGenerator(renderer)
      generator.update().then((result) => {
        if (active) setTextures(result)
      }).catch((error: unknown) => {
        if (active) console.error('Atmosphere precomputation failed', error)
      })
    })
    return () => {
      active = false
      cancelAnimationFrame(start)
      generator?.dispose()
    }
  }, [renderer])

  return textures
}
