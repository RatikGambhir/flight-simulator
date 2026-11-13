// Shared animated water shading for ocean and inland lake surfaces.
import { Color, MeshPhysicalMaterial, Uniform } from 'three'
import { makeWaveNormals } from './waveNormals'
import { WaterCoordinates } from './WaterCoordinates'
import { frame } from '../world/frame'

export class WaterMaterial extends MeshPhysicalMaterial {
  private readonly time = new Uniform(0)
  private readonly coordinates = new WaterCoordinates()
  private readonly waterFromWorld = new Uniform(this.coordinates.matrix)

  constructor() {
    const normalMap = makeWaveNormals()
    super({
      color: new Color('#04202f'),
      roughness: 0.14,
      metalness: 0,
      normalMap,
      ior: 1.333,
      specularIntensity: 1,
      envMapIntensity: 0.85,
    })
    this.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.time
      shader.uniforms.waterFromWorld = this.waterFromWorld
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWaterWorld;\nuniform mat4 waterFromWorld;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWaterWorld = (waterFromWorld * modelMatrix * vec4(transformed, 1.0)).xyz;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWaterWorld;\nuniform float uTime;')
        .replace(
          '#include <normal_fragment_maps>',
          /* glsl */ `
          // Two scrolling wave layers sampled in world space; detail fades with distance.
          vec2 wp = vWaterWorld.xz;
          float dist = length(vViewPosition);
          vec3 n1 = texture2D(normalMap, wp / 38.0 + vec2(uTime * 0.011, uTime * 0.007)).xyz * 2.0 - 1.0;
          vec3 n2 = texture2D(normalMap, wp / 210.0 - vec2(uTime * 0.004, -uTime * 0.006)).xyz * 2.0 - 1.0;
          vec3 n3 = texture2D(normalMap, wp / 1400.0 + vec2(uTime * 0.0012, 0.0)).xyz * 2.0 - 1.0;
          float nearFade = 1.0 - smoothstep(1000.0, 9000.0, dist);
          float midFade = 1.0 - smoothstep(6000.0, 35000.0, dist);
          float farFade = 1.0 - smoothstep(25000.0, 150000.0, dist);
          vec2 waves = n1.xy * 0.55 * nearFade + n2.xy * 0.45 * midFade + n3.xy * 0.35 * farFade;
          // Keep the curved surface normal, including the local frame rotation.
          vec3 surface = inverseTransformDirection(normal, viewMatrix);
          vec3 tangent = normalize(cross(vec3(0.0, 0.0, 1.0), surface));
          vec3 bitangent = normalize(cross(surface, tangent));
          vec3 worldN = normalize(surface + tangent * waves.x + bitangent * waves.y);
          normal = normalize((viewMatrix * vec4(worldN, 0.0)).xyz);
          `,
        )
        .replace('#include <roughnessmap_fragment>', `
          #include <roughnessmap_fragment>
          // Subpixel waves become a broad highlight rather than flashing pixels.
          roughnessFactor = mix(roughnessFactor, 0.32, smoothstep(2000.0, 45000.0, length(vViewPosition)));
        `)
    }
  }

  update(time: number) {
    this.time.value = time
    // Keep wave coordinates fixed when the flight's floating origin changes.
    this.coordinates.update(frame)
  }

  override dispose() {
    this.normalMap?.dispose()
    super.dispose()
  }
}
