// Procedural geometry generators for aircraft parts.
// Model axes: x = right, y = up, z = aft (the nose points toward -z).

import { BufferGeometry, Float32BufferAttribute, LatheGeometry, Matrix4, Quaternion, Vector2, Vector3 } from 'three'

export interface Station {
  /** Longitudinal position (m, -z = forward). */
  z: number
  /** Half width (m). */
  hw: number
  /** Half height (m). */
  hh: number
  /** Vertical center offset (m). */
  yc: number
}

/**
 * A closed tube through superelliptic cross-sections. UVs: u wraps around
 * (0 = top, 0.25 = right side, 0.5 = bottom), v runs nose (0) to tail (1).
 */
export function tubeGeometry(stations: Station[], radial = 48, exponent = 2.0): BufferGeometry {
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  const z0 = stations[0].z
  const z1 = stations[stations.length - 1].z
  const p = 2 / exponent
  for (let i = 0; i < stations.length; i++) {
    const s = stations[i]
    for (let j = 0; j <= radial; j++) {
      const th = (j / radial) * Math.PI * 2
      const sn = Math.sin(th)
      const cs = Math.cos(th)
      const x = s.hw * Math.sign(sn) * Math.pow(Math.abs(sn), p)
      const y = s.yc + s.hh * Math.sign(cs) * Math.pow(Math.abs(cs), p)
      pos.push(x, y, s.z)
      uv.push(j / radial, (s.z - z0) / (z1 - z0))
    }
  }
  const row = radial + 1
  for (let i = 0; i < stations.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * row + j
      const b = a + row
      idx.push(a, b, a + 1, a + 1, b, b + 1)
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/** Smooth fuselage profile for a conventional airliner-like body. */
export function airlinerStations(opts: {
  noseZ: number
  tailZ: number
  radius: number
  noseLen: number
  tailLen: number
  noseDroop?: number
  upsweep?: number
  flatten?: number
  tailEndRadius?: number
  noseBluntness?: number
}): Station[] {
  const { noseZ, tailZ, radius: R, noseLen, tailLen } = opts
  const droop = opts.noseDroop ?? 0.25
  const upsweep = opts.upsweep ?? 0.55
  const flatten = opts.flatten ?? 1.0
  const tailEnd = opts.tailEndRadius ?? 0.12
  const blunt = opts.noseBluntness ?? 0.55
  const out: Station[] = []
  const n = 60
  for (let i = 0; i <= n; i++) {
    // Denser sampling near the nose and tail.
    const t = i / n
    const s = t < 0.5 ? 0.5 * Math.pow(2 * t, 1.6) : 1 - 0.5 * Math.pow(2 * (1 - t), 1.6)
    const z = noseZ + s * (tailZ - noseZ)
    const fromNose = z - noseZ
    const toTail = tailZ - z
    let hw = R
    let hh = R * flatten
    let yc = 0
    if (fromNose < noseLen) {
      const k = fromNose / noseLen
      const f = Math.pow(Math.sin((k * Math.PI) / 2), blunt)
      hw = Math.max(0.02, R * f)
      hh = Math.max(0.02, R * flatten * f)
      yc = -droop * R * (1 - k) * (1 - k)
    } else if (toTail < tailLen) {
      const k = 1 - toTail / tailLen // 0 at start of tail cone -> 1 at tip
      const f = 1 - (1 - tailEnd) * Math.pow(k, 1.35)
      hw = R * f
      hh = R * flatten * (1 - (1 - tailEnd) * Math.pow(k, 1.1))
      // Keep the top line nearly straight (upswept underside).
      yc = upsweep * R * Math.pow(k, 1.2) * (1 - 0.35 * k)
      hh = Math.min(hh, R * flatten + 0.0 - yc + R * 0.02)
    }
    out.push({ z, hw, hh, yc })
  }
  // Close the ends.
  out[0] = { ...out[0], hw: 0.01, hh: 0.01 }
  out[out.length - 1] = { ...out[out.length - 1], hw: 0.02, hh: 0.02 }
  return out
}

/** NACA 4-digit symmetric thickness distribution (half thickness / chord). */
function nacaThickness(x: number, t: number) {
  return 5 * t * (0.2969 * Math.sqrt(Math.max(x, 0)) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x)
}

export interface WingParams {
  /** Semi-span (m) measured along the spanwise axis. */
  span: number
  rootChord: number
  tipChord: number
  /** Leading-edge sweep (deg). */
  sweep: number
  /** Dihedral (deg); positive raises the tip. */
  dihedral: number
  thicknessRoot: number
  thicknessTip: number
  /** Camber as a fraction of chord. */
  camber?: number
  /** Orientation: 'horizontal' (wings, stabilizers) or 'vertical' (fins: span goes +y). */
  vertical?: boolean
}

/** Point on the wing surface frame: spanwise fraction `e`, chord fraction `c`. Returns the mean-line point. */
export function wingPoint(w: WingParams, e: number, c: number, side: 1 | -1 = 1, out = new Vector3()) {
  const ys = e * w.span
  const chord = w.rootChord + (w.tipChord - w.rootChord) * e
  const zLe = ys * Math.tan((w.sweep * Math.PI) / 180)
  const lift = ys * Math.tan((w.dihedral * Math.PI) / 180)
  const camber = (w.camber ?? 0.02) * chord * 4 * c * (1 - c)
  if (w.vertical) return out.set(lift * side, ys, zLe + c * chord)
  return out.set(ys * side, lift + camber, zLe + c * chord)
}

/**
 * Lofted wing panel between span fractions [e0,e1] and chord fractions [c0,c1].
 * Closed at all edges. `side` mirrors to the left (-x) with correct winding.
 */
export function wingPanelGeometry(w: WingParams, e0: number, e1: number, c0 = 0, c1 = 1, side: 1 | -1 = 1, spanSegs = 10, chordSegs = 18): BufferGeometry {
  const pos: number[] = []
  const uvs: number[] = []
  const idx: number[] = []
  const p = new Vector3()
  // Cosine spacing along chord for a crisp leading edge.
  const cs: number[] = []
  for (let k = 0; k <= chordSegs; k++) {
    const u = k / chordSegs
    cs.push(c0 + (c1 - c0) * (c0 === 0 ? (1 - Math.cos((u * Math.PI) / 2)) : u))
  }
  const ringLen = (chordSegs + 1) * 2
  for (let i = 0; i <= spanSegs; i++) {
    const e = e0 + ((e1 - e0) * i) / spanSegs
    const chord = w.rootChord + (w.tipChord - w.rootChord) * e
    const tk = w.thicknessRoot + (w.thicknessTip - w.thicknessRoot) * e
    // Upper surface from TE->LE then lower LE->TE, forming a ring.
    const ring: [number, number][] = []
    for (let k = chordSegs; k >= 0; k--) ring.push([cs[k], +1])
    for (let k = 0; k <= chordSegs; k++) ring.push([cs[k], -1])
    for (const [c, s] of ring) {
      wingPoint(w, e, c, side, p)
      const half = nacaThickness(c, tk) * chord * s
      if (w.vertical) p.x += half
      else p.y += half
      pos.push(p.x, p.y, p.z)
      uvs.push(c, e)
    }
  }
  for (let i = 0; i < spanSegs; i++) {
    for (let k = 0; k < ringLen - 1; k++) {
      const a = i * ringLen + k
      const b = a + ringLen
      if (side === 1 !== !!w.vertical) idx.push(a, b, a + 1, a + 1, b, b + 1)
      else idx.push(a, a + 1, b, a + 1, b + 1, b)
    }
  }
  // End caps (fan triangulation around the ring centroid).
  const cap = (ringIndex: number, flip: boolean) => {
    const start = ringIndex * ringLen
    let cx = 0
    let cy = 0
    let cz = 0
    for (let k = 0; k < ringLen; k++) {
      cx += pos[(start + k) * 3]
      cy += pos[(start + k) * 3 + 1]
      cz += pos[(start + k) * 3 + 2]
    }
    const center = pos.length / 3
    pos.push(cx / ringLen, cy / ringLen, cz / ringLen)
    uvs.push(0.5, ringIndex === 0 ? 0 : 1)
    for (let k = 0; k < ringLen - 1; k++) {
      if (flip) idx.push(center, start + k + 1, start + k)
      else idx.push(center, start + k, start + k + 1)
    }
  }
  const flipBase = side === 1 !== !!w.vertical
  cap(0, flipBase)
  cap(spanSegs, !flipBase)
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/**
 * Builds a hinge frame for a control surface: returns the hinge origin and a
 * rotation that maps local +X onto the hinge line (from e0 to e1 at chord c).
 */
export function hingeFrame(w: WingParams, e0: number, e1: number, c: number, side: 1 | -1) {
  const a = wingPoint(w, e0, c, side)
  const b = wingPoint(w, e1, c, side)
  const axis = b.clone().sub(a).normalize()
  const q = new Quaternion().setFromUnitVectors(new Vector3(1, 0, 0), axis)
  return { origin: a, quat: q, axis }
}

/** Re-expresses geometry relative to a hinge frame so it can rotate about local X. */
export function toHingeLocal(g: BufferGeometry, origin: Vector3, quat: Quaternion) {
  const m = new Matrix4().compose(origin, quat, new Vector3(1, 1, 1)).invert()
  g.applyMatrix4(m)
  return g
}

/** Revolved shape around the Z axis from (radius, z) profile points. */
export function revolveZ(profile: [number, number][], segments = 40): BufferGeometry {
  const pts = profile.map(([r, z]) => new Vector2(Math.max(r, 0.0001), z))
  const g = new LatheGeometry(pts, segments)
  // Lathe revolves around Y; rotate so the axis is Z (and the profile z maps to -z forward).
  g.rotateX(Math.PI / 2)
  return g
}

export function mirrorX(g: BufferGeometry): BufferGeometry {
  const m = g.clone()
  m.scale(-1, 1, 1)
  const index = m.getIndex()
  if (index) {
    const arr = index.array as Uint16Array | Uint32Array
    for (let i = 0; i < arr.length; i += 3) {
      const t = arr[i + 1]
      arr[i + 1] = arr[i + 2]
      arr[i + 2] = t
    }
    index.needsUpdate = true
  }
  m.computeVertexNormals()
  return m
}
