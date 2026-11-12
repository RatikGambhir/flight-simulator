import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'

// Node's TS stripping does not resolve the extensionless imports used by Vite.
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.includes('/src/')) {
    const url = new URL(`${specifier}.ts`, context.parentURL)
    if (existsSync(url)) return next(url.href, context)
  }
  return next(specifier, context)
} })

const { S, Flags, ApModes } = await import('../src/sim/protocol.ts')
const { AP_PHASES, AP_LATERAL, autopilotStatus, flightModes, phaseName } = await import('../src/sim/autopilotStatus.ts')

const rust = (path) => readFileSync(new URL(`../crates/sim-core/src/${path}`, import.meta.url), 'utf8')

/** `pub const NAME: type = value;` pairs inside a Rust `pub mod <name> { ... }` block. */
function rustConsts(source, mod) {
  const start = source.indexOf(`pub mod ${mod} {`)
  assert.ok(start >= 0, `mod ${mod}`)
  let depth = 0
  let end = start
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}' && --depth === 0) { end = i; break }
  }
  // Only this module's own constants, not those of nested modules.
  const body = source.slice(source.indexOf('{', start) + 1, end).replace(/pub mod \w+ \{[^}]*\}/g, '')
  const out = {}
  for (const m of body.matchAll(/pub const ([A-Z_]+): \w+ = (\d+);/g)) out[m[1]] = Number(m[2])
  return out
}

test('snapshot layout matches the Rust protocol field for field', () => {
  const src = rust('protocol.rs')
  const snap = rustConsts(src, 'snap')
  assert.ok(Object.keys(snap).length > 50)
  assert.deepEqual({ ...S }, snap)
})

test('flag and autopilot mode bits match the Rust protocol', () => {
  const src = rust('protocol.rs')
  assert.deepEqual(rustConsts(src, 'flags'), { ...Flags })
  assert.deepEqual(rustConsts(src, 'ap_modes'), { ...ApModes })
})

test('autopilot phase and lateral mode lists match the Rust enums in order', () => {
  const src = rust('autopilot/mod.rs')
  const labels = [...src.matchAll(/Phase::(\w+) => "([^"]+)",/g)].map((m) => m[2])
  assert.deepEqual(labels, [...AP_PHASES])
  const lateral = src.slice(src.indexOf('pub enum Lateral'), src.indexOf('}', src.indexOf('pub enum Lateral')))
  const codes = [...lateral.matchAll(/(\w+) = (\d+),/g)].map((m) => Number(m[2]))
  assert.deepEqual(codes, AP_LATERAL.map((_, i) => i))
})

function snapshot(fields) {
  const s = new Float64Array(S.LEN)
  for (const [k, v] of Object.entries(fields)) s[S[k]] = v
  return s
}
const ENGAGED = Flags.AP_ENGAGED
const phase = (name) => AP_PHASES.indexOf(name)

test('autopilot off shows nothing but the prompt state', () => {
  const st = autopilotStatus(snapshot({}))
  assert.equal(st.engaged, false)
  assert.equal(st.phase, 'OFF')
  assert.equal(st.tone, 'off')
  assert.deepEqual(flightModes(snapshot({})), ['', '', ''])
})

test('hold mode lists the held heading, altitude and speed', () => {
  const s = snapshot({ FLAGS: ENGAGED, AP_PHASE: phase('HDG/ALT HOLD'), AP_LATERAL: 1, AP_MODES: ApModes.HEADING | ApModes.ALTITUDE | ApModes.AUTOTHROTTLE, AP_HEADING: 90, AP_ALT_FT: 5000, AP_SPEED_KT: 250 })
  const st = autopilotStatus(s)
  assert.equal(st.managed, false)
  assert.equal(st.nav, 'HDG 090')
  assert.equal(st.targets, 'ALT 5,000 · SPD 250')
  assert.deepEqual(flightModes(s), ['SPD', 'HDG SEL', 'ALT HOLD'])
})

test('managed cruise shows the route, distance, runway and targets', () => {
  const s = snapshot({
    FLAGS: ENGAGED,
    AP_PHASE: phase('CRUISE'),
    AP_LATERAL: 3,
    AP_MODES: ApModes.HEADING | ApModes.ALTITUDE | ApModes.AUTOTHROTTLE | ApModes.MANAGED,
    AP_DIST_NM: 54.4,
    AP_ALT_FT: 9500,
    AP_SPEED_KT: 250,
    AP_VS_FPM: 0,
  })
  const st = autopilotStatus(s, { destination: 'KMKE', runway: '01L' })
  assert.equal(st.managed, true)
  assert.equal(st.phase, 'CRUISE')
  assert.equal(st.nav, 'DCT · KMKE · 54 NM · RWY 01L')
  assert.equal(st.targets, 'ALT 9,500 · SPD 250')
  assert.equal(st.tone, 'on')
  assert.deepEqual(flightModes(s), ['SPD', 'LNAV', 'VNAV PTH'])
})

test('climbs and descents show the vertical speed; final shows the glideslope', () => {
  const base = { FLAGS: ENGAGED, AP_MODES: ApModes.AUTOTHROTTLE | ApModes.MANAGED, AP_ALT_FT: 9500, AP_SPEED_KT: 250, AP_DIST_NM: 40 }
  assert.match(autopilotStatus(snapshot({ ...base, AP_PHASE: phase('CLIMB'), AP_VS_FPM: 2400 })).targets, /▲ 2,400/)
  assert.match(autopilotStatus(snapshot({ ...base, AP_PHASE: phase('DESCENT'), AP_VS_FPM: -1800 })).targets, /▼ 1,800/)
  const fin = snapshot({ ...base, AP_PHASE: phase('FINAL'), AP_LATERAL: 6, AP_DIST_NM: 3.25, AP_SPEED_KT: 147 })
  const st = autopilotStatus(fin, { destination: 'KORD', runway: '28R' })
  assert.equal(st.nav, 'LOC · KORD · 3.3 NM · RWY 28R')
  assert.match(st.targets, /^G\/S · SPD 147/)
  assert.deepEqual(flightModes(fin), ['SPD', 'VOR/LOC', 'G/S'])
})

test('takeoff, flare, go-around and landed states', () => {
  const managed = ApModes.AUTOTHROTTLE | ApModes.MANAGED
  const to = snapshot({ FLAGS: ENGAGED, AP_PHASE: phase('TAKEOFF'), AP_MODES: managed, AP_SPEED_KT: 145, AP_DIST_NM: 58 })
  assert.deepEqual(flightModes(to), ['N1', 'TO/GA', 'TO/GA'])
  assert.equal(autopilotStatus(to, { destination: 'KMKE', runway: '01L' }).nav, 'KMKE', 'no distance or landing runway shown on the takeoff roll')
  assert.deepEqual(flightModes(snapshot({ FLAGS: ENGAGED, AP_PHASE: phase('FLARE'), AP_MODES: managed })), ['RETARD', 'VOR/LOC', 'FLARE'])
  assert.equal(autopilotStatus(snapshot({ FLAGS: ENGAGED, AP_PHASE: phase('GO-AROUND'), AP_MODES: managed })).tone, 'caution')
  const landed = autopilotStatus(snapshot({ FLAGS: ENGAGED, AP_PHASE: phase('LANDED'), AP_MODES: managed }))
  assert.equal(landed.tone, 'complete')
  assert.match(landed.targets, /Z TO TAKE OVER/)
})

test('manual thrust is shown when the autothrottle is off', () => {
  const s = snapshot({ FLAGS: ENGAGED, AP_PHASE: phase('CRUISE'), AP_MODES: ApModes.MANAGED, AP_ALT_FT: 30000 })
  assert.match(autopilotStatus(s).targets, /A\/T OFF/)
  assert.equal(flightModes(s)[0], '')
})

test('phase names are clamped to the known list', () => {
  assert.equal(phaseName(0), 'OFF')
  assert.equal(phaseName(99), AP_PHASES.at(-1))
  assert.equal(phaseName(-3), 'OFF')
})
