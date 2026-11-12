// Render resolution and volumetric-cloud budget.
//
// Measured on an M4 Pro in WKWebView (scripts/bench.mjs): at a 1.8x scene DPR
// every pass except the clouds costs ~7.5 ms together, while the volumetric
// cloud march alone cost 30-65 ms when it refreshed every cloud pixel each
// frame. The old adaptive scheme paid for that by shrinking the whole
// framebuffer to 1x on Retina displays, which blurred terrain, aircraft and
// HUD-adjacent edges. Now the scene renders at a fixed, display-matched
// resolution and only the cloud work adapts: clouds are soft and temporally
// reconstructed, so their sample density is the least visible thing to trade.
import type { Quality } from '../state/store'

/** Highest scene pixel ratio per quality; Retina displays render at up to native 2x. */
export const SCENE_DPR: Record<Quality, number> = { low: 1, medium: 1.5, high: 2, ultra: 2 }

/**
 * Framebuffer budget (device pixels). Several HDR, depth and antialiasing buffers
 * are allocated per pixel, and every full-screen pass scales with this count.
 * `high` keeps a 1600x960 window at ~1.84x and a full-screen 14" MacBook Pro at ~1.64x.
 */
export const MAX_RENDER_PIXELS: Record<Quality, number> = { low: 2.1e6, medium: 3.6e6, high: 5.2e6, ultra: 8.3e6 }

/** The menu's background preview: rendered at 30 FPS, so a lower budget is plenty. */
export const PREVIEW_PIXELS = 2.1e6

export function sceneDpr(quality: Quality, renderScale: number, devicePixelRatio: number, cssPixels: number, preview: boolean) {
  const pixels = preview ? PREVIEW_PIXELS : MAX_RENDER_PIXELS[quality]
  const display = Math.max(1, devicePixelRatio || 1)
  const dpr = Math.min(SCENE_DPR[quality], display, preview ? 1 : Infinity) * renderScale
  return Math.max(0.25, Math.min(dpr, Math.sqrt(pixels / Math.max(1, cssPixels))))
}

/**
 * Cloud detail per quality. Clouds are marched with the library's temporal
 * upscaling: each frame marches 1/16 of the pixels of a `resolution`-scaled
 * buffer and reconstructs the rest from reprojected history, which costs a
 * fraction of marching a smaller buffer completely every frame.
 */
const CLOUD_BASE: Record<Quality, { resolution: number; step: number; shadow: number }> = {
  low: { resolution: 0.4, step: 100, shadow: 384 },
  medium: { resolution: 0.5, step: 60, shadow: 512 },
  high: { resolution: 0.6, step: 50, shadow: 768 },
  ultra: { resolution: 0.75, step: 35, shadow: 1024 },
}

/**
 * Adaptive cloud levels, best first. Each level scales the per-quality base. The
 * scene resolution never changes; dense overcast at low sun can need the last levels.
 */
export const CLOUD_LEVELS = [
  { resolution: 1, step: 1, perspective: 1.01, shadow: 1 },
  { resolution: 0.85, step: 1.1, perspective: 1.015, shadow: 1 },
  { resolution: 0.72, step: 1.25, perspective: 1.02, shadow: 0.85 },
  { resolution: 0.62, step: 1.4, perspective: 1.025, shadow: 0.75 },
  { resolution: 0.52, step: 1.6, perspective: 1.03, shadow: 0.5 },
  // Long, grazing rays through an overcast set a floor on the march that fewer
  // pixels cannot lower; the last level shortens them instead.
  { resolution: 0.45, step: 1.8, perspective: 1.04, shadow: 0.42 },
] as const

export interface CloudBudget {
  /** Cloud buffer size relative to the scene framebuffer. */
  resolutionScale: number
  minStepSize: number
  perspectiveStepScale: number
  shadowMapSize: number
}

export function cloudBudget(quality: Quality, level: number, preview = false): CloudBudget {
  const base = CLOUD_BASE[quality]
  const l = CLOUD_LEVELS[Math.max(0, Math.min(CLOUD_LEVELS.length - 1, Math.round(level)))]
  // The 30 FPS menu preview renders a smaller framebuffer; give its clouds the middle level.
  const s = preview ? CLOUD_LEVELS[2] : l
  return {
    resolutionScale: Math.round(base.resolution * s.resolution * 100) / 100,
    minStepSize: Math.round(base.step * s.step),
    perspectiveStepScale: s.perspective,
    // Multiples of 64 keep cascade texel grids stable between levels.
    shadowMapSize: Math.max(192, Math.round(base.shadow * s.shadow / 64) * 64),
  }
}

/** Large or high-DPI framebuffers start a step down and earn their way back up. */
export function initialCloudLevel(framebufferPixels: number) {
  return framebufferPixels > 6e6 ? 2 : framebufferPixels > 3.5e6 ? 1 : 0
}
