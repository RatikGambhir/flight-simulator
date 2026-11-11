// Universal control scheme shared by every aircraft: keyboard (smoothed
// axes), mouse (camera) and standard-mapping gamepads.

import { sim } from '../sim/simClient'
import type { ControlInput } from '../sim/protocol'
import { CAMERA_MODES, useApp } from '../state/store'

export interface Binding {
  keys: string
  action: string
}

export const BINDINGS: { group: string; items: Binding[] }[] = [
  {
    group: 'Flight',
    items: [
      { keys: 'W / ↑', action: 'Nose down' },
      { keys: 'S / ↓', action: 'Nose up' },
      { keys: 'A / ←', action: 'Roll left' },
      { keys: 'D / →', action: 'Roll right' },
      { keys: 'Q / E', action: 'Rudder left / right (steer on ground)' },
      { keys: 'R / F', action: 'Throttle up / down' },
      { keys: '⇧R / ⇧F', action: 'Full throttle / idle' },
    ],
  },
  {
    group: 'Aircraft',
    items: [
      { keys: 'G', action: 'Landing gear up / down' },
      { keys: '[ / ]', action: 'Flaps up / down' },
      { keys: '/', action: 'Speed brakes' },
      { keys: 'Space (hold)', action: 'Wheel brakes' },
      { keys: 'N', action: 'Parking brake' },
      { keys: 'T', action: 'Assisted flight on / off' },
    ],
  },
  {
    group: 'Autopilot',
    items: [
      { keys: 'Z', action: 'Engage / disengage (holds heading, altitude, speed)' },
      { keys: '⇧← / ⇧→', action: 'Heading −5° / +5°' },
      { keys: '⇧↑ / ⇧↓', action: 'Altitude +500 / −500 ft' },
      { keys: '⌥R / ⌥F', action: 'Speed +5 / −5 kt' },
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
      { keys: 'P', action: 'Pause' },
      { keys: 'Esc', action: 'Menu' },
      { keys: '?', action: 'Controls help' },
    ],
  },
]

const AXIS_ATTACK = 2.6
const AXIS_RELEASE = 4.5

class Controls {
  private down = new Set<string>()
  private axes = { pitch: 0, roll: 0, yaw: 0 }
  private attached = false
  private gamepadButtons: boolean[] = []
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
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    const app = useApp.getState()
    if (app.phase !== 'flying') return
    if (e.metaKey || e.ctrlKey) return
    const code = e.code
    if (e.key === 'Escape') {
      app.setPauseMenu(!app.pauseMenu)
      sim.command({ type: 'set_paused', paused: !app.pauseMenu })
      e.preventDefault()
      return
    }
    if (app.pauseMenu) return
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Slash'].includes(code)) e.preventDefault()
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

  /** Advances smoothed axes and returns the input to send this frame. */
  update(dt: number): ControlInput {
    const { settings, pauseMenu } = useApp.getState()
    const shift = this.down.has('ShiftLeft') || this.down.has('ShiftRight')
    const alt = this.down.has('AltLeft') || this.down.has('AltRight')
    const blocked = pauseMenu
    const up = !blocked && !shift && this.key('KeyW', 'ArrowUp')
    const dn = !blocked && !shift && this.key('KeyS', 'ArrowDown')
    const lf = !blocked && !shift && this.key('KeyA', 'ArrowLeft')
    const rt = !blocked && !shift && this.key('KeyD', 'ArrowRight')
    const inv = settings.invertPitch ? -1 : 1
    const targets = {
      pitch: ((dn ? 1 : 0) - (up ? 1 : 0)) * inv,
      roll: (rt ? 1 : 0) - (lf ? 1 : 0),
      yaw: (!blocked && this.key('KeyE') ? 1 : 0) - (!blocked && this.key('KeyQ') ? 1 : 0),
    }
    let throttleRate = 0
    if (!blocked && !shift && !alt) {
      if (this.key('KeyR', 'Equal', 'PageUp')) throttleRate += 1
      if (this.key('KeyF', 'Minus', 'PageDown')) throttleRate -= 1
    }
    let brake = !blocked && this.key('Space') ? 1 : 0

    for (const k of ['pitch', 'roll', 'yaw'] as const) {
      const target = targets[k]
      const cur = this.axes[k]
      const rate = Math.abs(target) > Math.abs(cur) || Math.sign(target) !== Math.sign(cur) ? AXIS_ATTACK : AXIS_RELEASE
      const step = rate * dt
      this.axes[k] = Math.abs(target - cur) <= step ? target : cur + Math.sign(target - cur) * step
    }
    const sens = settings.sensitivity
    const out: ControlInput = {
      pitch: this.axes.pitch * sens,
      roll: this.axes.roll * sens,
      yaw: this.axes.yaw * sens,
      throttle_rate: throttleRate,
      brake,
    }

    // Gamepad (standard mapping) overrides the keyboard when deflected.
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : []
    const pad = pads && Array.from(pads).find((p) => p && p.connected && p.mapping === 'standard')
    this.look.x = 0
    this.look.y = 0
    if (pad && !blocked) {
      const dz = (v: number) => (Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88)
      const rx = dz(pad.axes[0] ?? 0)
      const ry = dz(pad.axes[1] ?? 0)
      if (rx !== 0) out.roll = rx
      if (ry !== 0) out.pitch = ry * inv
      this.look.x = dz(pad.axes[2] ?? 0)
      this.look.y = dz(pad.axes[3] ?? 0)
      const b = pad.buttons.map((x) => x.pressed)
      const lt = pad.buttons[6]?.value ?? 0
      const rtv = pad.buttons[7]?.value ?? 0
      if (rtv > 0.05) out.throttle_rate = rtv
      if (lt > 0.05) out.throttle_rate = -lt
      if (b[4]) out.yaw = -1
      if (b[5]) out.yaw = 1
      if (b[12]) brake = 1
      out.brake = Math.max(out.brake, brake)
      const pressed = (i: number) => b[i] && !this.gamepadButtons[i]
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
      this.gamepadButtons = b
    }
    return out
  }
}

export const controls = new Controls()
