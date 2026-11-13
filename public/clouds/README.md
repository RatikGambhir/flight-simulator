# Cloud textures

The renderer uses Takram's cloud weather, shape, detail and turbulence assets.
`stbn.bin` is the original spatiotemporal blue-noise volume (128×128×64, R8),
replacing the patterned interleaved-gradient substitute.

- Source: https://github.com/takram-design-engineering/three-geospatial/blob/9627216cc50057994c98a2118f3c4a23765d43b9/packages/core/assets/stbn.bin
- SHA-256: `51f52f21e5578384585050390821a0a486dcb81e11a716fa7b92fbb6515ba852`
- Restore with `node scripts/build_stbn.mjs`; the script verifies size and hash.
- Upstream license: MIT, copyright 2024 Shota Matsuda; included in `LICENSE.txt`.

These are data textures, not sRGB color images. Keep the noise volume's nearest
filtering and repeat wrapping. The shape volumes generate a mip chain once on
upload and use trilinear filtering. Explicit volume LOD follows the ray's sample
interval, avoiding undersampling of metre-scale detail at larger march steps.

The weather, turbulence and shape fields are cached. Cloud motion translates
all of them together with the simulated horizontal wind, using one ECEF offset
shared by clouds and their shadows. Noise offsets do not animate independently,
and calm air leaves the field fixed.

## Sampling (`src/scene/cloudRendering.ts`)

Real clouds drift slowly, so the renderer recomputes as little as it can and
never re-rolls what it has already computed:

- **One pixel in sixteen per march, a different one each time.** Sixteen marches
  cover every pixel of the cloud image. The march uses no per-frame noise (the
  blue noise is fixed to the full-resolution pixel), so a pixel marched again
  through an unmoved camera returns the same value. The resolve writes each
  sample to its own pixel and leaves the rest alone: a still view converges to
  the full cloud resolution and then does not change at all. The cloud image is
  rounded up to a multiple of four pixels so each sample lands on one pixel.
- **Every ray samples the same shells of distance from the camera.** Steps that
  start where each ray enters the cloud layer comb the clouds into ripples once
  the noise that hid them is gone. Empty gaps between layers are crossed in long
  strides whose last stride is retraced, so strides never decide where a cloud
  begins.
- **Up to three density probes per cell, one lighting sample.** The cloud is
  opaque within metres, far less than a 50-150 m cell. Each cell is lit once, at
  the opacity-weighted depth of what the probes found, so shading follows the
  cloud's surface instead of terracing along the shells. Long cells far away take
  two probes (over 150 m) or one (over 400 m), the weather map is read once per
  cell, and noise lookups that cannot contribute are skipped (no density at that
  height, turbulence above a layer's lowest third, detail in a layer that has
  none). From cruise altitude that is most of the samples along a ray.
- **The march and the cloud shadow maps take turns.** A cycle is three frames:
  the lower half of the march, its upper half, then the shadow cascades, so no
  frame carries more than half a march. On every frame the resolve reprojects the
  finished image through the camera's move and the wind's drift, which costs a
  twentieth of a march. A full refresh takes 48 frames; cuts, resizes and
  floating-origin rebases run everything at once.
- **While the image moves** history is clipped to the current samples (opacity
  separately from brightness) and eased lightly towards them. A still image is
  neither clipped nor eased.
- **The resolve unprojects each pixel through the near plane.** The far plane is
  20,000 km away; unprojecting it cancels to zero in single precision with the
  cockpit camera's 3 cm near plane, which rejected all history from the cockpit.

## Low sun

- **Undersides catch the light.** The shadow map carries sunlight through the
  whole deck between a cloud and the sun; within a few degrees of the horizon
  that is tens of kilometres of cloud, so nothing under a deck was ever lit and a
  sunset seen from the ground was one flat dark sheet. From 9 degrees of sun
  elevation down to 1, cloud with an open view downward (the bases, thin edges)
  progressively sheds that far shadow and keeps only the cloud right in front of
  it. Cloud with more cloud beneath it, and the tops seen from above, do not
  change.
- **Warm and cool sky light.** Sky light reaches a cloud as one colour from all
  directions, which at sunset is the average of a blue zenith and an orange
  horizon: mauve everywhere. The glow around the low sun is estimated from the
  atmosphere each frame and split off: it lights what faces it (undersides,
  sunward sides) while the cooler remainder keeps the top-down gradient. The
  total is unchanged, and the split fades out above 6-14 degrees.
- **Exposure** (`src/scene/exposure.ts`) opens up to about 3x around sunset,
  half as far when the sun reaches the camera (above the deck, or a clear sky),
  and returns to the daytime value by full night.

`cloudgolden`, `cloudsunset` and `clouddusk` are the parked view at about +5, +1
and -3 degrees of sun; `cloudtopssunset` looks along the deck from above.

The graphics tests measure Chicago night-cloud opacity and lighting below and
near the cloud tops with the camera held still: both must not change by more
than 1/255 (they measure 0). `node scripts/bench.mjs <label> cloudnight
cloudnoon cloudlowsun cloudsunset` covers the parked view through the day,
`clouddaymotion`, `cloudnightmotion` and `cloudtopsnight` the moving camera;
`cruise` (737 cockpit), `cruisea380` and `cruisechase` the deck from 35,000 ft.
