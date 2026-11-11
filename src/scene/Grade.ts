// Display-referred "look" applied after tone mapping. AgX keeps highlights and
// hues natural but renders flat; this restores the contrast and colour of a
// camera's punchy profile. Everything is clamped: a plain contrast stretch
// pushes the darkest pixels negative, and the sRGB encode that follows turns
// negatives into NaN (white specks on dark ground).

import { BlendFunction, Effect } from 'postprocessing'
import { Uniform } from 'three'

const frag = /* glsl */ `
uniform float contrast;
uniform float saturation;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = clamp(inputColor.rgb, 0.0, 1.0);
  // Filmic S-curve blended in by "contrast": steeper mid-tones, toe and shoulder stay inside 0..1.
  vec3 s = c * c * (3.0 - 2.0 * c);
  c = mix(c, s, contrast);
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, 1.0 + saturation);
  outputColor = vec4(clamp(c, 0.0, 1.0), inputColor.a);
}`

export class GradeEffect extends Effect {
  constructor(contrast = 0.35, saturation = 0.14) {
    super('GradeEffect', frag, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map([
        ['contrast', new Uniform(contrast)],
        ['saturation', new Uniform(saturation)],
      ]),
    })
  }
}
