// Procedural flight audio with the Web Audio API (no sample files).
//
//  * Turbofans: fan whine (tonal, rises with N1), jet roar (band-passed noise)
//    and a low rumble; reversers add roar.
//  * Propeller: blade-pass buzz with engine firing harmonics.
//  * Airflow: wind noise rising with airspeed, louder with gear/flaps/spoilers.
//  * Ground: tyre rumble with ground speed, touchdown thump + tyre chirp.
//  * Systems: gear and flap motors while they move.
//  * Warnings: stall horn (props) / stick shaker (jets), overspeed clacker,
//    autopilot-disconnect wail, and spoken radio-altitude / GPWS callouts.
//
// In the cockpit everything outside is low-passed and quieter, like a real cabin.

import { Flags, S, type AircraftSpec, type SimEvent } from '../sim/protocol'
import { sim } from '../sim/simClient'

type Ctx = AudioContext

interface Loop {
  src: AudioBufferSourceNode
  filter: BiquadFilterNode
  gain: GainNode
}

interface Tone {
  osc: OscillatorNode
  gain: GainNode
}

const CALLOUTS: [number, string][] = [
  [2500, 'two thousand five hundred'],
  [1000, 'one thousand'],
  [500, 'five hundred'],
  [100, 'one hundred'],
  [50, 'fifty'],
  [40, 'forty'],
  [30, 'thirty'],
  [20, 'twenty'],
  [10, 'ten'],
]

function makeNoise(ctx: Ctx, seconds: number, brown: boolean) {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  let last = 0
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1
    if (brown) {
      last = (last + 0.02 * w) / 1.02
      d[i] = last * 3.5
    } else d[i] = w
  }
  return buf
}

class SoundEngine {
  private ctx: Ctx | null = null
  private master!: GainNode
  /** Everything outside the cabin goes through this (low-passed in the cockpit). */
  private outside!: BiquadFilterNode
  private outsideGain!: GainNode
  private white!: AudioBuffer
  private brown!: AudioBuffer

  private roar!: Loop
  private rumbleLow!: Loop
  private whine1!: Tone
  private whine2!: Tone
  private prop!: Tone
  private propFire!: Tone
  private propFilter!: BiquadFilterNode
  private wind!: Loop
  private tyres!: Loop
  private motor!: Tone
  private stall!: Tone
  private shaker!: GainNode

  private specs: AircraftSpec[] = []
  private volume = 0.7
  private callouts = true
  private active = false
  private interior = false

  private prevGear = 1
  private prevFlaps = 0
  private prevAgl = 0
  private prevAp = false
  private lastClack = 0
  /** Callouts re-arm once the aircraft climbs back above them. */
  private armed = CALLOUTS.map(() => true)
  private lastWarn = 0
  private lastBank = 0
  private retardSaid = false
  private time = 0

  constructor() {
    sim.onEvent((e) => this.onEvent(e))
  }

  /** Must be called from a user gesture (click / key) before audio can start. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume()
      return
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    try {
      this.ctx = new AC({ latencyHint: 'interactive' })
    } catch {
      return
    }
    this.build(this.ctx)
    void sim.query<AircraftSpec[]>({ type: 'aircraft_list' }).then((l) => (this.specs = l)).catch(() => {})
  }

  configure(volume: number, callouts: boolean) {
    this.volume = Math.max(0, Math.min(1, volume))
    this.callouts = callouts
    if (this.ctx) this.master.gain.setTargetAtTime(this.active ? this.volume : 0, this.ctx.currentTime, 0.1)
  }

  /** Mutes while in menus or paused. */
  setActive(active: boolean) {
    if (active === this.active) return
    this.active = active
    if (!this.ctx) return
    this.master.gain.setTargetAtTime(active ? this.volume : 0, this.ctx.currentTime, active ? 0.3 : 0.08)
    if (!active) window.speechSynthesis?.cancel()
  }

  private loop(ctx: Ctx, buf: AudioBuffer, type: BiquadFilterType, freq: number, q: number, dest: AudioNode): Loop {
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    // Start each loop at a different offset so layers don't correlate.
    const filter = ctx.createBiquadFilter()
    filter.type = type
    filter.frequency.value = freq
    filter.Q.value = q
    const gain = ctx.createGain()
    gain.gain.value = 0
    src.connect(filter).connect(gain).connect(dest)
    src.start(0, Math.random() * buf.duration)
    return { src, filter, gain }
  }

  private tone(ctx: Ctx, type: OscillatorType, freq: number, dest: AudioNode): Tone {
    const osc = ctx.createOscillator()
    osc.type = type
    osc.frequency.value = freq
    const gain = ctx.createGain()
    gain.gain.value = 0
    osc.connect(gain).connect(dest)
    osc.start()
    return { osc, gain }
  }

  private build(ctx: Ctx) {
    this.white = makeNoise(ctx, 3, false)
    this.brown = makeNoise(ctx, 4, true)
    this.master = ctx.createGain()
    this.master.gain.value = 0
    // Gentle limiter so stacked layers never clip.
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -10
    comp.ratio.value = 6
    this.master.connect(comp).connect(ctx.destination)
    this.outside = ctx.createBiquadFilter()
    this.outside.type = 'lowpass'
    this.outside.frequency.value = 18000
    this.outsideGain = ctx.createGain()
    this.outside.connect(this.outsideGain).connect(this.master)
    const out = this.outside

    this.roar = this.loop(ctx, this.white, 'bandpass', 500, 0.6, out)
    this.rumbleLow = this.loop(ctx, this.brown, 'lowpass', 140, 0.7, out)
    this.whine1 = this.tone(ctx, 'sine', 1200, out)
    this.whine2 = this.tone(ctx, 'triangle', 2400, out)
    this.propFilter = ctx.createBiquadFilter()
    this.propFilter.type = 'lowpass'
    this.propFilter.frequency.value = 700
    this.propFilter.connect(out)
    this.prop = this.tone(ctx, 'sawtooth', 40, this.propFilter)
    this.propFire = this.tone(ctx, 'square', 80, this.propFilter)
    this.wind = this.loop(ctx, this.white, 'bandpass', 600, 0.5, out)
    this.tyres = this.loop(ctx, this.brown, 'lowpass', 220, 0.8, out)
    // Systems and warnings are heard inside the cabin, so they bypass the outside filter.
    this.motor = this.tone(ctx, 'sawtooth', 160, this.master)
    this.stall = this.tone(ctx, 'square', 420, this.master)
    // Stick shaker: a rumble amplitude-modulated at ~17 Hz, behind an on/off envelope.
    const shake = this.loop(ctx, this.brown, 'lowpass', 90, 1, this.master)
    shake.gain.gain.value = 0.5
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 17
    const depth = ctx.createGain()
    depth.gain.value = 0.5
    lfo.connect(depth).connect(shake.gain.gain)
    lfo.start()
    this.shaker = ctx.createGain()
    this.shaker.gain.value = 0
    shake.gain.disconnect()
    shake.gain.connect(this.shaker).connect(this.master)
  }

  private set(param: AudioParam, v: number, tc = 0.06) {
    param.setTargetAtTime(v, this.ctx!.currentTime, tc)
  }

  /** Updates every layer from the newest snapshot. Call once per frame. */
  update(s: Float64Array, cockpit: boolean, dt: number) {
    const ctx = this.ctx
    if (!ctx || !this.active) return
    this.time += dt
    const flags = s[S.FLAGS] | 0
    const onGround = (flags & Flags.ON_GROUND) !== 0
    const crashed = (flags & Flags.CRASHED) !== 0
    const spec = this.specs[s[S.AIRCRAFT_INDEX] | 0]
    const jet = spec ? spec.engine === 'jet' : true
    const n1 = crashed ? 0 : s[S.ENGINE]
    const ias = s[S.IAS_KT]
    const gs = s[S.GS_KT]
    const rev = s[S.REVERSER]

    if (cockpit !== this.interior) {
      this.interior = cockpit
      this.set(this.outside.frequency, cockpit ? 1500 : 18000, 0.15)
      this.set(this.outsideGain.gain, cockpit ? 0.55 : 1, 0.15)
    }

    // ---- Engines ------------------------------------------------------
    if (jet) {
      const fan = 0.2 + 0.8 * n1
      this.set(this.whine1.osc.frequency, 700 + 2600 * fan)
      this.set(this.whine2.osc.frequency, (700 + 2600 * fan) * 1.97)
      this.set(this.whine1.gain.gain, 0.025 * fan * fan + 0.004)
      this.set(this.whine2.gain.gain, 0.008 * fan * fan)
      this.set(this.roar.filter.frequency, 250 + 1100 * n1)
      this.set(this.roar.gain.gain, 0.03 + 0.5 * n1 * n1 * (1 + rev * 0.6))
      this.set(this.rumbleLow.gain.gain, 0.06 + 0.55 * n1 * n1)
      this.set(this.prop.gain.gain, 0)
      this.set(this.propFire.gain.gain, 0)
    } else {
      const rpm = crashed ? 0 : 750 + 1950 * n1
      const bladePass = (rpm / 60) * 2
      this.set(this.prop.osc.frequency, bladePass)
      this.set(this.propFire.osc.frequency, bladePass * 1.0 + 0.7)
      this.set(this.propFilter.frequency, 300 + 900 * n1)
      this.set(this.prop.gain.gain, crashed ? 0 : 0.1 + 0.25 * n1)
      this.set(this.propFire.gain.gain, crashed ? 0 : 0.05 + 0.08 * n1)
      this.set(this.roar.filter.frequency, 400 + 600 * n1)
      this.set(this.roar.gain.gain, crashed ? 0 : 0.02 + 0.12 * n1)
      this.set(this.rumbleLow.gain.gain, crashed ? 0 : 0.08 + 0.2 * n1)
      this.set(this.whine1.gain.gain, 0)
      this.set(this.whine2.gain.gain, 0)
    }

    // ---- Airflow --------------------------------------------------------
    const drag = 1 + s[S.GEAR] * 0.6 + s[S.FLAPS] * 0.4 + s[S.SPOILERS] * 0.7
    const q = Math.min(1.6, (ias / 260) ** 2) * drag
    this.set(this.wind.filter.frequency, 300 + ias * 4 + (cockpit ? 900 : 0))
    this.set(this.wind.gain.gain, q * (cockpit ? 0.35 : 0.5))

    // ---- Ground roll ----------------------------------------------------
    const roll = onGround && !crashed ? Math.min(1, gs / 80) : 0
    this.set(this.tyres.filter.frequency, 80 + gs * 2.5)
    this.set(this.tyres.gain.gain, roll * 0.7 + (onGround && gs > 0.5 ? 0.05 : 0))

    // ---- Gear and flap motors --------------------------------------------
    const gearMoving = Math.abs(s[S.GEAR] - this.prevGear) > 1e-4
    const flapsMoving = Math.abs(s[S.FLAPS] - this.prevFlaps) > 1e-5
    this.prevGear = s[S.GEAR]
    this.prevFlaps = s[S.FLAPS]
    this.set(this.motor.osc.frequency, gearMoving ? 140 : 210)
    this.set(this.motor.gain.gain, gearMoving ? 0.05 : flapsMoving ? 0.025 : 0, 0.15)

    // ---- Warnings -------------------------------------------------------
    const stalled = (flags & Flags.STALL) !== 0 && !crashed
    // Warn a little before the critical angle of attack (flaps lower it ~2°).
    const nearStall = !!spec && !onGround && ias > 30 && s[S.ALPHA] > spec.alpha_stall_deg - 2 * s[S.FLAPS] - 2.5
    const warnStall = stalled || nearStall
    if (jet) {
      this.set(this.shaker.gain, warnStall ? 0.9 : 0, 0.03)
      this.set(this.stall.gain.gain, 0)
    } else {
      this.set(this.stall.osc.frequency, 410 + Math.sin(this.time * 9) * 12)
      this.set(this.stall.gain.gain, warnStall ? 0.06 : 0, 0.03)
      this.set(this.shaker.gain, 0)
    }
    if ((flags & Flags.OVERSPEED) !== 0 && this.time - this.lastClack > 0.11) {
      this.lastClack = this.time
      this.click(1800, 0.04, 0.12)
    }
    const ap = (flags & Flags.AP_ENGAGED) !== 0
    if (this.prevAp && !ap && !crashed) this.cavalryCharge()
    this.prevAp = ap

    this.voiceCallouts(s, jet, onGround, crashed, spec?.id ?? '')
  }

  /** Radio-altitude callouts and basic GPWS for airliners and jets. */
  private voiceCallouts(s: Float64Array, jet: boolean, onGround: boolean, crashed: boolean, id: string) {
    const agl = s[S.AGL_FT]
    const vs = s[S.VS_FPM]
    const prev = this.prevAgl
    this.prevAgl = agl
    if (!jet || crashed || !this.callouts) return
    for (let i = 0; i < CALLOUTS.length; i++) {
      const [h, text] = CALLOUTS[i]
      if (agl > h + 80 || onGround) this.armed[i] = agl > h + 80
      if (this.armed[i] && !onGround && vs < 0 && prev > h && agl <= h) {
        this.armed[i] = false
        this.say(text, h <= 50 ? 1.25 : 1.05)
        if (h === 20 && id === 'a320' && s[S.THROTTLE] > 0.05 && !this.retardSaid) {
          this.retardSaid = true
          setTimeout(() => this.say('retard', 1.2), 650)
        }
      }
    }
    if (agl > 100) this.retardSaid = false
    if (onGround) return
    const now = this.time
    if (now - this.lastWarn > 3.2) {
      const gearUp = s[S.GEAR] < 0.9
      if (agl < 1500 && vs < -(1800 + agl * 1.4)) {
        this.lastWarn = now
        this.say('pull up', 1.1)
      } else if (agl < 2500 && vs < -(1100 + agl * 0.9)) {
        this.lastWarn = now
        this.say('sink rate', 1.1)
      } else if (gearUp && agl < 500 && vs < -200 && s[S.IAS_KT] < 190) {
        this.lastWarn = now
        this.say('too low, gear', 1.1)
      }
    }
    if (Math.abs(s[S.ROLL]) > 35 && now - this.lastBank > 2.5) {
      this.lastBank = now
      this.say('bank angle, bank angle', 1.15)
    }
  }

  private say(text: string, rate = 1) {
    const synth = window.speechSynthesis
    if (!synth || this.volume <= 0.01) return
    const u = new SpeechSynthesisUtterance(text)
    u.rate = rate
    u.pitch = 0.85
    u.volume = Math.min(1, this.volume * 1.2)
    const voice = synth.getVoices().find((v) => /en[-_](US|GB)/i.test(v.lang))
    if (voice) u.voice = voice
    synth.speak(u)
  }

  /** Short filtered noise burst. */
  private burst(freq: number, q: number, peak: number, decay: number, type: BiquadFilterType = 'lowpass') {
    const ctx = this.ctx
    if (!ctx) return
    const src = ctx.createBufferSource()
    src.buffer = type === 'lowpass' ? this.brown : this.white
    const f = ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = freq
    f.Q.value = q
    const g = ctx.createGain()
    const t = ctx.currentTime
    g.gain.setValueAtTime(peak, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay)
    src.connect(f).connect(g).connect(this.outside)
    src.start(t, Math.random() * 2)
    src.stop(t + decay + 0.05)
  }

  private click(freq: number, len: number, peak: number) {
    const ctx = this.ctx
    if (!ctx) return
    const o = ctx.createOscillator()
    o.type = 'square'
    o.frequency.value = freq
    const g = ctx.createGain()
    const t = ctx.currentTime
    g.gain.setValueAtTime(peak, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + len)
    o.connect(g).connect(this.master)
    o.start(t)
    o.stop(t + len + 0.02)
  }

  /** Autopilot-disconnect "cavalry charge". */
  private cavalryCharge() {
    const ctx = this.ctx
    if (!ctx) return
    const notes = [660, 880, 990, 1320]
    const t0 = ctx.currentTime
    for (let rep = 0; rep < 2; rep++) {
      notes.forEach((f, i) => {
        const o = ctx.createOscillator()
        o.type = 'triangle'
        o.frequency.value = f
        const g = ctx.createGain()
        const t = t0 + rep * 0.75 + i * 0.13
        g.gain.setValueAtTime(0, t)
        g.gain.linearRampToValueAtTime(0.06, t + 0.02)
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24)
        o.connect(g).connect(this.master)
        o.start(t)
        o.stop(t + 0.3)
      })
    }
  }

  private onEvent(e: SimEvent) {
    if (!this.ctx || !this.active) return
    switch (e.type) {
      case 'touchdown': {
        const hard = Math.min(1, Math.abs(e.vertical_speed_fpm) / 600)
        this.burst(110, 0.8, 0.5 + hard * 1.4, 0.35 + hard * 0.4)
        // Tyre chirp as the wheels spin up.
        this.burst(2600, 2.5, 0.15 + hard * 0.2, 0.18, 'bandpass')
        break
      }
      case 'crashed':
        this.burst(70, 0.7, 2.5, 1.8)
        this.burst(900, 0.5, 0.8, 1.2, 'bandpass')
        break
    }
  }
}

export const sound = new SoundEngine()
