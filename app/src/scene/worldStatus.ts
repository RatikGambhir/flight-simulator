// Low-frequency world/streaming status for UI overlays (kept out of the
// render loop's React tree so the 3D scene never re-renders for it).

import { create } from 'zustand'
import type { Attribution, WorldSystem } from '../world/worldSystem'

interface WorldStatus {
  world: WorldSystem | null
  progress: number
  attributions: Attribution[]
  error: string | null
  tilesReady: boolean
}

export const useWorldStatus = create<WorldStatus>(() => ({
  world: null,
  progress: 0,
  attributions: [],
  error: null,
  tilesReady: false,
}))

let lastTick = 0

export const worldStatus = {
  set(patch: Partial<WorldStatus>) {
    useWorldStatus.setState(patch)
  },
  tick(world: WorldSystem) {
    const now = performance.now()
    if (now - lastTick < 500) return
    lastTick = now
    const cur = useWorldStatus.getState()
    const progress = Math.round(world.loadProgress * 100) / 100
    const attributions = world.attributions()
    const sameAttr =
      attributions.length === cur.attributions.length && attributions.every((a, i) => a.text === cur.attributions[i].text && a.image === cur.attributions[i].image)
    const error = world.failed ? world.lastError : null
    const tilesReady = world.rootLoaded
    if (progress !== cur.progress || !sameAttr || error !== cur.error || tilesReady !== cur.tilesReady) {
      useWorldStatus.setState({ progress, attributions: sameAttr ? cur.attributions : attributions, error, tilesReady })
    }
  },
}
