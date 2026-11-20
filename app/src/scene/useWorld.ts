import { useThree } from '@react-three/fiber'
import { useEffect, useState } from 'react'
import type { PerspectiveCamera } from 'three'
import { useApp } from '../state/store'
import { WorldSystem } from '../world/worldSystem'
import { worldStatus } from './worldStatus'

export function useWorld(enabled = true): WorldSystem | null {
  const { gl, camera, scene } = useThree()
  const provider = useApp((s) => s.settings.provider)
  const googleApiKey = useApp((s) => s.settings.googleApiKey)
  const cesiumToken = useApp((s) => s.settings.cesiumToken)
  const cesiumMode = useApp((s) => s.settings.cesiumMode)
  const openImagery = useApp((s) => s.settings.openImagery)
  const quality = useApp((s) => s.settings.quality)
  const [world, setWorld] = useState<WorldSystem | null>(null)
  useEffect(() => {
    if (!enabled) { setWorld(null); return }
    const settings = useApp.getState().settings
    const w = new WorldSystem(settings, gl, camera as PerspectiveCamera, scene)
    setWorld(w)
    worldStatus.set({ world: w, progress: 0, attributions: [], error: null, tilesReady: false })
    return () => {
      worldStatus.set({ world: null, progress: 0, attributions: [], error: null, tilesReady: false })
      w.dispose()
    }
  }, [enabled, gl, camera, scene, provider, googleApiKey, cesiumToken, cesiumMode, openImagery, quality])
  return world
}

