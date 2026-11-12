// Lightweight per-frame performance probe. Brackets every R3F frame (all
// useFrame work plus the effect composer's render passes) and accumulates
// renderer.info across those passes, so draw calls include shadow maps, the
// surface mask and every post-processing pass, not only the last render().

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect } from 'react'
import { perfMonitor } from './perfMonitor'

/** Mount inside the Canvas while the overlay or a benchmark wants frame data. */
export function PerfProbe() {
  const gl = useThree((s) => s.gl)
  useEffect(() => {
    perfMonitor.reset()
    const reset = () => perfMonitor.reset()
    document.addEventListener('visibilitychange', reset)
    return () => {
      document.removeEventListener('visibilitychange', reset)
      gl.info.autoReset = true
    }
  }, [gl])
  // R3F runs callbacks in priority order: this one first and the next one after
  // the effect composer (priority 1) has submitted every pass.
  useFrame(() => perfMonitor.begin(gl), -1000)
  useFrame(() => perfMonitor.end(gl), 1000)
  return null
}
