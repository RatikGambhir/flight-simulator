// Minimal glass HUD. Values change every frame, so they are written straight
// to the DOM from a requestAnimationFrame loop instead of React state.

import { useEffect, useRef } from 'react'
import { ApModes, Flags, S } from '../sim/protocol'
import { sim } from '../sim/simClient'
import { useAircraftList } from './useAircraftList'
import { useApp } from '../state/store'

function fmt(n: number, digits = 0) {
  return n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits })
}

const HEADING_PX_PER_DEG = 4

export function Hud() {
  const root = useRef<HTMLDivElement>(null)
  const list = useAircraftList()
  const listRef = useRef(list)
  listRef.current = list
  // In the cockpit the real instruments take over; keep the HUD compact.
  const cockpit = useApp((s) => s.camera === 'cockpit')

  useEffect(() => {
    const el = root.current!
    const q = <T extends HTMLElement = HTMLElement>(k: string) => el.querySelector<T>(`[data-k="${k}"]`)!
    const nodes = {
      ias: q('ias'),
      gs: q('gs'),
      mach: q('mach'),
      alt: q('alt'),
      agl: q('agl'),
      vs: q('vs'),
      hdg: q('hdg'),
      strip: q('strip'),
      thrBar: q('thrBar'),
      thr: q('thr'),
      gear: q('gear'),
      flaps: q('flaps'),
      spd: q('spd'),
      brake: q('brake'),
      gload: q('gload'),
      coords: q('coords'),
      ap: q('ap'),
      apModes: q('apModes'),
      warn: q('warn'),
      status: q('status'),
      assist: q('assist'),
    }
    // Build the heading strip once.
    const strip = nodes.strip
    strip.innerHTML = ''
    for (let d = -360; d <= 720; d += 5) {
      const x = (d + 360) * HEADING_PX_PER_DEG
      const t = document.createElement('div')
      t.className = 'tick'
      t.style.left = `${x}px`
      t.style.height = d % 10 === 0 ? '10px' : '5px'
      strip.appendChild(t)
      if (d % 30 === 0) {
        const l = document.createElement('div')
        l.className = 'lbl'
        l.style.left = `${x}px`
        const h = ((d % 360) + 360) % 360
        l.textContent = h === 0 ? 'N' : h === 90 ? 'E' : h === 180 ? 'S' : h === 270 ? 'W' : String(h / 10)
        strip.appendChild(l)
      }
    }
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const s = sim.latest
      const flags = s[S.FLAGS] | 0
      const spec = listRef.current[s[S.AIRCRAFT_INDEX] | 0]
      nodes.ias.textContent = fmt(s[S.IAS_KT])
      nodes.gs.textContent = `GS ${fmt(s[S.GS_KT])}  TAS ${fmt(s[S.TAS_KT])}`
      nodes.mach.textContent = s[S.MACH] > 0.4 ? `M ${s[S.MACH].toFixed(2)}` : `G ${s[S.G_LOAD].toFixed(1)}`
      nodes.alt.textContent = fmt(Math.round(s[S.ALT_MSL_FT] / 10) * 10)
      const agl = s[S.AGL_FT]
      nodes.agl.textContent = agl < 2500 ? `RA ${fmt(agl)}` : ''
      const vs = s[S.VS_FPM]
      nodes.vs.textContent = `${vs >= 0 ? '▲' : '▼'} ${fmt(Math.abs(Math.round(vs / 10) * 10))} fpm`
      const hdg = s[S.HEADING]
      nodes.hdg.textContent = `${String(Math.round(hdg) % 360).padStart(3, '0')}°`
      strip.style.transform = `translateX(${210 - (hdg + 360) * HEADING_PX_PER_DEG}px)`
      const thr = s[S.THROTTLE]
      ;(nodes.thrBar.firstElementChild as HTMLElement).style.height = `${thr * 100}%`
      nodes.thr.textContent = `${Math.round(thr * 100)}%`
      const gear = s[S.GEAR]
      if (spec && !spec.retractable_gear) {
        nodes.gear.textContent = 'FIXED'
        nodes.gear.style.color = '#9aa6b6'
      } else {
        nodes.gear.textContent = gear > 0.99 ? 'DOWN' : gear < 0.01 ? 'UP' : 'MOVING'
        nodes.gear.style.color = gear > 0.99 ? '#55e08a' : gear < 0.01 ? '#e9fbff' : '#ffb547'
      }
      const fi = s[S.FLAPS_INDEX] | 0
      nodes.flaps.textContent = spec ? spec.flap_detents[fi] ?? String(fi) : String(fi)
      nodes.spd.textContent = s[S.SPOILERS] > 0.05 ? 'EXT' : '—'
      nodes.spd.style.color = s[S.SPOILERS] > 0.05 ? '#ffb547' : ''
      nodes.brake.textContent = flags & Flags.PARKING_BRAKE ? 'PARK' : s[S.BRAKE] > 0 ? 'ON' : '—'
      nodes.brake.style.color = flags & Flags.PARKING_BRAKE || s[S.BRAKE] > 0 ? '#ffb547' : ''
      nodes.gload.textContent = `${s[S.G_LOAD].toFixed(1)} G`
      const lat = s[S.LAT]
      const lon = s[S.LON]
      nodes.coords.textContent = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}  ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`
      const apOn = (flags & Flags.AP_ENGAGED) !== 0
      nodes.ap.textContent = apOn ? 'AP ON' : 'AP OFF'
      nodes.ap.className = apOn ? 'ap-on' : 'faint'
      const m = s[S.AP_MODES] | 0
      nodes.apModes.textContent = apOn
        ? `${m & ApModes.HEADING ? `HDG ${String(Math.round(s[S.AP_HEADING])).padStart(3, '0')}` : ''}  ${m & ApModes.ALTITUDE ? `ALT ${fmt(s[S.AP_ALT_FT])}` : ''}  ${m & ApModes.AUTOTHROTTLE ? `SPD ${fmt(s[S.AP_SPEED_KT])}` : ''}`
        : ''
      nodes.assist.textContent = flags & Flags.ASSIST ? 'ASSIST' : 'DIRECT'
      let warn = ''
      if (flags & Flags.STALL) warn = 'STALL'
      else if (flags & Flags.OVERSPEED) warn = 'OVERSPEED'
      else if (flags & Flags.TAILSTRIKE) warn = 'TAIL STRIKE'
      else if (!(flags & Flags.ON_GROUND) && gear < 0.5 && agl < 500 && vs < -200 && spec?.retractable_gear) warn = 'GEAR'
      nodes.warn.textContent = warn
      nodes.warn.style.display = warn ? 'block' : 'none'
      nodes.status.textContent = flags & Flags.PAUSED ? 'PAUSED' : s[S.TIME_SCALE] > 1 ? `SIM RATE ${s[S.TIME_SCALE]}×` : ''
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className={`hud ${cockpit ? 'compact' : ''}`} ref={root}>
      <div className="hud-heading box">
        <div className="strip" data-k="strip" />
        <div className="pointer" />
      </div>
      <div className="hud-heading" style={{ height: 'auto', top: 66, width: 'auto', overflow: 'visible' }}>
        <b data-k="hdg" style={{ fontSize: 16 }} />
      </div>
      <div className="hud-status" data-k="status" />
      <div className="hud-side left box">
        <div className="hud-unit">AIRSPEED KT</div>
        <div className="hud-big" data-k="ias" />
        <div className="hud-small" data-k="gs" />
        <div className="hud-small" data-k="mach" />
      </div>
      <div className="hud-side right box">
        <div className="hud-unit">ALTITUDE FT</div>
        <div className="hud-big" data-k="alt" />
        <div className="hud-small" data-k="vs" />
        <div className="hud-small" data-k="agl" />
      </div>
      <div className="hud-warning" data-k="warn" />
      <div className="hud-bottom box">
        <div className="cell">
          <div className="throttle-bar" data-k="thrBar">
            <i />
          </div>
        </div>
        <div className="cell">
          <span className="hud-unit">THR</span>
          <b data-k="thr" />
        </div>
        <div className="cell">
          <span className="hud-unit">GEAR</span>
          <b data-k="gear" />
        </div>
        <div className="cell">
          <span className="hud-unit">FLAPS</span>
          <b data-k="flaps" />
        </div>
        <div className="cell">
          <span className="hud-unit">SPDBRK</span>
          <b data-k="spd" />
        </div>
        <div className="cell">
          <span className="hud-unit">BRAKE</span>
          <b data-k="brake" />
        </div>
        <div className="cell">
          <span className="hud-unit">LOAD</span>
          <b data-k="gload" />
        </div>
      </div>
      <div className="hud-coords box">
        <div data-k="coords" />
        <div className="faint" data-k="assist" />
      </div>
      <div className="hud-ap box">
        <b data-k="ap" />
        <span data-k="apModes" />
      </div>
    </div>
  )
}
