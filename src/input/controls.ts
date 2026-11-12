// Universal control scheme shared by every aircraft: keyboard (smoothed
// axes), mouse (camera) and standard-mapping gamepads.

import { sound } from '../audio/sound'
import { sim } from '../sim/simClient'
import type { ControlInput } from '../sim/protocol'
import { CAMERA_MODES, useApp } from '../state/store'

export interface Binding {
  keys: string
  action: string
}

export const BINDINGS: { group: string; items: Binding[] }[] = [
  {
    group: '737 cockpit',
    items: [
      { keys: 'Click CMD A', action: 'Autopilot on / off' },
      { keys: 'Click / Shift-click knobs', action: 'Increase / decrease autopilot speed, heading or altitude' },
      { keys: 'Click / Shift-click throttles', action: 'Throttle +10% / −10%' },
      { keys: 'Click gear / speed-brake lever', action: 'Toggle landing gear / speed brakes' },
      { keys: 'Click / Shift-click flap lever', action: 'Flaps down / up one notch' },
      { keys: 'Other switches', action: 'Decorative; drag to look around as usual' },
    ],
  },
  {
    group: 'Flight',
    items: [
      { keys: 'W / ↑', action: 'Nose down' },
      { keys: 'S / ↓', action: 'Nose up' },
      { keys: 'A / ←', action: 'Roll left' },
      { keys: 'D / →', action: 'Roll right' },
      { keys: 'J / E', action: 'Rudder left / right (steer on ground)' },
      { keys: 'R / F', action: 'Throttle up / down' },
      { keys: '⇧R / ⇧F', action: 'Full throttle / idle' },
      { keys: 'X (hold)', action: 'Reverse thrust (jets, on the ground at idle)' },
    ],
  },
  {
    group: 'Aircraft',
    items: [
      { keys: 'G', action: 'Landing gear up / down' },
      { keys: '[ / ]', action: 'Flaps up / down' },
      { keys: '/', action: 'Speed brakes' },
      { keys: 'Space / . (hold)', action: 'Wheel brakes' },
      { keys: 'N', action: 'Parking brake' },
      { keys: 'T', action: 'Assisted flight on / off' },
    ],
  },
  {
    group: 'Autopilot',
    items: [
      { keys: 'Z', action: 'Engage / disengage. With a destination it takes off, flies there and lands; without one it holds heading, altitude and speed' },
      { keys: 'M', action: 'Choose the destination the autopilot flies to' },
      { keys: '⇧← / ⇧→', action: 'Heading −5° / +5°' },
      { keys: '⇧↑ / ⇧↓', action: 'Altitude +500 / −500 ft (cruise level when navigating)' },
      { keys: '⌥R / ⌥F', action: 'Speed +5 / −5 kt (cruise speed when navigating)' },
    ],
  },
  {
    group: 'View & app',
    items: [
      { keys: 'C / ⇧C', action: 'Next / previous camera' },
      { keys: 'V', action: 'Toggle cockpit / exterior' },
      { keys: '1 – 6', action: 'Exterior, cockpit, wing, free, cinematic, flyby' },
      { keys: 'Mouse drag', action: 'Look around / orbit' },
      { keys: 'Scroll', action: 'Zoom' },
      { keys: 'Double-click', action: 'Reset view' },
      { keys: 'H', action: 'Hide / show HUD' },
      { keys: 'M', action: 'Destination & route map' },
      { keys: 'Q', action: 'Skip to a distance from your destination' },
      { keys: 'Shift + ~', action: 'Show / hide destination airport in the world' },
      { keys: 'P', action: 'Pause' },
      { keys: 'Esc', action: 'Menu' },
      { keys: '?', action: 'Controls help' },
    ],
  },
]

// Keyboard axes ramp while a key is held, so a tap is a small correction and
// holding the key builds up to full deflection, like moving a real yoke.
const AXIS_ATTACK = { pitch: 0.8, roll: 1.4, yaw: 1.8 } as const
const AXIS_RELEASE = 3.5
/** Reversing direction recentres quickly before building the other way. */
const AXIS_REVERSE = 6

/** Softens the centre of an axis for fine corrections while keeping full travel. */
function expo(v: number, k = 0.55) {
  return v * (1 - k + k * v * v)
}

const AXES = ['pitch', 'roll', 'yaw'] as const
const KEY_CAPTURE = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Slash', 'Period'])

class Controls {
  private down = new Set<string>()
  private axes = { pitch: 0, roll: 0, yaw: 0 }
  private attached = false
  private gamepadButtons: boolean[] = []
  private readonly targets = { pitch: 0, roll: 0, yaw: 0 }
  private readonly out: ControlInput = { pitch: 0, roll: 0, yaw: 0, throttle_rate: 0, brake: 0, reverse: 0 }
  /** Camera look input from a gamepad right stick (consumed by the camera rig). */
  readonly look = { x: 0, y: 0 }

  attach() {
    if (this.attached) return
    this.attached = true
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
  }

  detach() {
    this.attached = false
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    this.down.clear()
  }

  private onBlur = () => this.down.clear()

  private onKeyUp = (e: KeyboardEvent) => {
    this.down.delete(e.code)
  }

  private onKeyDown = (e: KeyboardEvent) => {
    const app = useApp.getState()
    // The native Skip-to dialog owns Escape, Enter, typing and focus while open.
    if (app.skipToOpen) return
    if (e.key === 'Escape' && app.routeOpen) {
      app.setRouteOpen(false)
      e.preventDefault()
      return
    }
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    if (app.phase !== 'flying') return
    if (e.metaKey || e.ctrlKey) return
    // A key press is a user gesture: make sure audio is running.
    sound.unlock()
    const code = e.code
    if (e.key === 'Escape') {
      app.setPauseMenu(!app.pauseMenu)
      sim.command({ type: 'set_paused', paused: !app.pauseMenu })
      e.preventDefault()
      return
    }
    if (app.pauseMenu) return
    if (code === 'KeyQ' && !app.routeOpen && !app.helpOverlay && !app.crashed) {
      e.preventDefault()
      if (!e.repeat) { this.down.clear(); app.setSkipToOpen(true) }
      return
    }
    if (code === 'KeyM') {
      if (!e.repeat) { this.down.clear(); app.setRouteOpen(!app.routeOpen) }
      e.preventDefault()
      return
    }
    if (app.routeOpen) return
    if (e.shiftKey && (code === 'Backquote' || e.key === '~')) {
      e.preventDefault()
      if (!e.repeat) {
        if (app.destination) app.toggleDestinationMarker()
        else app.toast('Choose a destination first — press M to open the route map.')
      }
      return
    }
    if (KEY_CAPTURE.has(code)) e.preventDefault()
    // Autopilot target adjustments.
    if (e.shiftKey && code.startsWith('Arrow')) {
      const ap =
        code === 'ArrowLeft'
          ? { heading_delta: -5 }
          : code === 'ArrowRight'
            ? { heading_delta: 5 }
            : code === 'ArrowUp'
              ? { altitude_delta_ft: 500 }
              : { altitude_delta_ft: -500 }
      sim.command({ type: 'autopilot', ...ap })
      return
    }
    if (e.altKey && (code === 'KeyR' || code === 'KeyF')) {
      sim.command({ type: 'autopilot', speed_delta_kt: code === 'KeyR' ? 5 : -5 })
      e.preventDefault()
      return
    }
    if (e.shiftKey && code === 'KeyR') return sim.command({ type: 'set_throttle', value: 1 })
    if (e.shiftKey && code === 'KeyF') return sim.command({ type: 'set_throttle', value: 0 })
    if (e.repeat) {
      this.down.add(code)
      return
    }
    switch (code) {
      case 'KeyG':
        sim.command({ type: 'toggle_gear' })
        break
      case 'BracketLeft':
        sim.command({ type: 'flaps_up' })
        break
      case 'BracketRight':
        sim.command({ type: 'flaps_down' })
        break
      case 'Slash':
        if (e.shiftKey) app.setHelpOverlay(!app.helpOverlay)
        else sim.command({ type: 'toggle_spoilers' })
        break
      case 'KeyN':
        sim.command({ type: 'toggle_parking_brake' })
        break
      case 'KeyZ':
        sim.command({ type: 'toggle_autopilot' })
        break
      case 'KeyT': {
        const assist = !app.settings.assist
        app.updateSettings({ assist })
        sim.command({ type: 'set_assist', enabled: assist })
        app.toast(assist ? 'Assisted flight ON' : 'Assisted flight OFF — direct control', 'info')
        break
      }
      case 'KeyC':
        app.cycleCamera(e.shiftKey ? -1 : 1)
        break
      case 'KeyV':
        app.setCamera(app.camera === 'cockpit' ? 'chase' : 'cockpit')
        break
      case 'KeyH':
        app.toggleHud()
        break
      case 'KeyP':
        sim.command({ type: 'toggle_pause' })
        break
      case 'F1':
        app.setHelpOverlay(!app.helpOverlay)
        break
      default: {
        const digit = /^Digit([1-6])$/.exec(code)
        if (digit) app.setCamera(CAMERA_MODES[Number(digit[1]) - 1].id)
      }
    }
    this.down.add(code)
  }

  private key(...codes: string[]) {
    return codes.some((c) => this.down.has(c))
  }

  /** Advances smoothed axes and returns the input to send this frame (reused object). */
  update(dt: number): ControlInput {
    const { settings, pauseMenu, routeOpen, skipToOpen } = useApp.getState()
    const shift = this.down.has('ShiftLeft') || this.down.has('ShiftRight')
    const alt = this.down.has('AltLeft') || this.down.has('AltRight')
    const blocked = pauseMenu || routeOpen || skipToOpen
    if (skipToOpen) {
      this.down.clear()
      this.axes.pitch = this.axes.roll = this.axes.yaw = 0
    }
    const free = !blocked && !shift
    const up = free && this.key('KeyW', 'ArrowUp')
    const dn = free && this.key('KeyS', 'ArrowDown')
    const lf = free && this.key('KeyA', 'ArrowLeft')
    const rt = free && this.key('KeyD', 'ArrowRight')
    const inv = settings.invertPitch ? -1 : 1
    const targets = this.targets
    targets.pitch = ((dn ? 1 : 0) - (up ? 1 : 0)) * inv
    targets.roll = (rt ? 1 : 0) - (lf ? 1 : 0)
    targets.yaw = (!blocked && this.key('KeyE') ? 1 : 0) - (!blocked && this.key('KeyJ') ? 1 : 0)
    let throttleRate = 0
    if (!blocked && !shift && !alt) {
      if (this.key('KeyR', 'Equal', 'PageUp')) throttleRate += 1
      if (this.key('KeyF', 'Minus', 'PageDown')) throttleRate -= 1
    }
    let brake = !blocked && this.key('Space', 'Period') ? 1 : 0
    const reverse = !blocked && this.key('KeyX', 'F2') ? 1 : 0

    for (const k of AXES) {
      const target = targets[k]
      const cur = this.axes[k]
      let rate: number
      if (target === 0) rate = AXIS_RELEASE
      else if (cur !== 0 && Math.sign(target) !== Math.sign(cur)) rate = AXIS_REVERSE
      else rate = AXIS_ATTACK[k]
      const step = rate * dt
      this.axes[k] = Math.abs(target - cur) <= step ? target : cur + Math.sign(target - cur) * step
    }
    const sens = settings.sensitivity
    const out = this.out
    out.pitch = expo(this.axes.pitch) * sens
    out.roll = expo(this.axes.roll) * sens
    out.yaw = this.axes.yaw * sens
    out.throttle_rate = throttleRate
    out.brake = brake
    out.reverse = reverse

    // Gamepad (standard mapping) overrides the keyboard when deflected.
    this.look.x = 0
    this.look.y = 0
    const pad = blocked ? null : firstStandardPad()
    if (pad) {
      const dz = (v: number) => (Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88)
      const rx = dz(pad.axes[0] ?? 0)
      const ry = dz(pad.axes[1] ?? 0)
      if (rx !== 0) out.roll = expo(rx, 0.4)
      if (ry !== 0) out.pitch = expo(ry, 0.4) * inv
      this.look.x = dz(pad.axes[2] ?? 0)
      this.look.y = dz(pad.axes[3] ?? 0)
      const btn = pad.buttons
      const lt = btn[6]?.value ?? 0
      const rtv = btn[7]?.value ?? 0
      if (rtv > 0.05) out.throttle_rate = rtv
      if (lt > 0.05) out.throttle_rate = -lt
      if (btn[4]?.pressed) out.yaw = -1
      if (btn[5]?.pressed) out.yaw = 1
      if (btn[12]?.pressed) brake = 1
      if (btn[13]?.pressed) out.reverse = 1
      out.brake = Math.max(out.brake, brake)
      const prev = this.gamepadButtons
      const pressed = (i: number) => !!btn[i]?.pressed && !prev[i]
      const app = useApp.getState()
      if (pressed(0)) sim.command({ type: 'toggle_gear' })
      if (pressed(1)) sim.command({ type: 'flaps_down' })
      if (pressed(2)) sim.command({ type: 'flaps_up' })
      if (pressed(3)) app.cycleCamera(1)
      if (pressed(8)) sim.command({ type: 'toggle_autopilot' })
      if (pressed(9)) {
        app.setPauseMenu(!app.pauseMenu)
        sim.command({ type: 'set_paused', paused: !app.pauseMenu })
      }
      prev.length = btn.length
      for (let i = 0; i < btn.length; i++) prev[i] = !!btn[i]?.pressed
    }
    return out
  }
}

function firstStandardPad(): Gamepad | null {
  if (typeof navigator.getGamepads !== 'function') return null
  const pads = navigator.getGamepads()
  for (const p of pads) if (p && p.connected && p.mapping === 'standard') return p
  return null
}

export const controls = new Controls()
