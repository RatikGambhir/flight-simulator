// Shared animated water shading for ocean and inland lake surfaces.
import { CanvasTexture, Color, LinearMipmapLinearFilter, Matrix4, MeshPhysicalMaterial, NoColorSpace, RepeatWrapping, Uniform, Vector3 } from 'three'
import { frame } from '../world/frame'

/** Tileable procedural wave normal map (sum of directional sines). */
function makeWaveNormals(size = 512) {
  const h = new Float32Array(size * size)
  const waves: [number, number, number, number][] = []
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let i = 0; i < 28; i++) {
    const fx = Math.round((rnd() - 0.5) * 2 * (2 + i * 0.9))
    const fy = Math.round((rnd() - 0.5) * 2 * (2 + i * 0.9))
    if (fx === 0 && fy === 0) continue
    waves.push([fx, fy, 1 / Math.sqrt(fx * fx + fy * fy), rnd() * Math.PI * 2])
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0
      for (const [fx, fy, amp, ph] of waves) v += amp * Math.sin(((fx * x + fy * y) / size) * Math.PI * 2 + ph)
      h[y * size + x] = v
    }
  }
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const g = c.getContext('2d')!
  const img = g.createImageData(size, size)
  const k = 2.2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = h[y * size + ((x + 1) % size)] - h[y * size + ((x - 1 + size) % size)]
      const dy = h[((y + 1) % size) * size + x] - h[((y - 1 + size) % size) * size + x]
      const n = new Vector3(-dx * k, -dy * k, 1).normalize()
      const i = (y * size + x) * 4
      img.data[i] = (n.x * 0.5 + 0.5) * 255
      img.data[i + 1] = (n.y * 0.5 + 0.5) * 255
      img.data[i + 2] = (n.z * 0.5 + 0.5) * 255
      img.data[i + 3] = 255
    }
  }
  g.putImageData(img, 0, 0)
  const t = new CanvasTexture(c)
  t.wrapS = t.wrapT = RepeatWrapping
  t.colorSpace = NoColorSpace
  t.minFilter = LinearMipmapLinearFilter
  t.anisotropy = 8
  return t
}

export class WaterMaterial extends MeshPhysicalMaterial {
  private readonly time = new Uniform(0)
  private readonly anchorFromEcef = frame.worldFromEcef.clone()
  private readonly waterFromWorld = new Uniform(new Matrix4())

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
    this.waterFromWorld.value.multiplyMatrices(this.anchorFromEcef, frame.ecefFromWorld)
  }

  override dispose() {
    this.normalMap?.dispose()
    super.dispose()
  }
}
