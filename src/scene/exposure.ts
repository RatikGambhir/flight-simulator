// Exposure through the day.
//
// The scene is rendered in physical radiance, and physically a sunset is dark: with the
// sun on the horizon the ground receives well under 1% of its noon light, and by the end
// of civil twilight a hundredth of that again. Eyes and cameras open up as the light
// goes; at the fixed daytime exposure everything under a cloud deck at sunset rendered
// as a near-black maroon sheet. So the exposure rises as the sun nears the horizon and
// peaks just after it sets. It only makes up part of the lost light (dusk should still
// read as dusk), and it falls back to the daytime value as the night lighting (airglow,
// moonlight, city and aircraft lights) fades in, which is balanced against that value.

/** `toneMappingExposure` in daylight and at night. */
export const BASE_EXPOSURE = 10

/** Sun elevation (degrees) against exposure gain; linear in between. */
const TWILIGHT_GAIN: readonly (readonly [number, number])[] = [
  [-10.5, 1],
  [-6, 1.3],
  [-3, 2.2],
  [-1, 3.2],
  [1, 3],
  [4, 1.8],
  [8, 1.2],
  [12, 1],
]

/**
 * Exposure gain for a sun elevation given as its sine (the sun direction's dot product
 * with up). `open` is how much direct sun reaches the camera through the clouds above
 * it (0-1): under a deck the eye opens up fully; above it, or under a clear sky, the
 * bright sky around the sun is in view and it opens up half as far.
 */
export function twilightExposure(sinElevation: number, open = 0) {
  return 1 + (elevationGain(sinElevation) - 1) * (1 - 0.5 * Math.min(1, Math.max(0, open)))
}

function elevationGain(sinElevation: number) {
  const degrees = Math.asin(Math.min(1, Math.max(-1, sinElevation))) * 180 / Math.PI
  const first = TWILIGHT_GAIN[0]
  if (!(degrees > first[0])) return first[1]
  for (let i = 1; i < TWILIGHT_GAIN.length; i++) {
    const [to, gain] = TWILIGHT_GAIN[i]
    if (degrees <= to) {
      const [from, before] = TWILIGHT_GAIN[i - 1]
      return before + (gain - before) * (degrees - from) / (to - from)
    }
  }
  return TWILIGHT_GAIN[TWILIGHT_GAIN.length - 1][1]
}
