// Minimal glass HUD. Values change every frame, so they are written straight
// to the DOM from a requestAnimationFrame loop instead of React state.

import { useEffect, useRef } from 'react'
import { ApModes, Flags, S } from '../sim/protocol'
import { sim } from '../sim/simClient'
import { useAircraftList } from './useAircraftList'
import { useApp } from '../state/store'
import { angleDelta, navigationTo } from '../navigation/route'

// Intl formatters are expensive to create; build them once.
const FORMATTERS = [0, 1, 2].map((d) => new Intl.NumberFormat('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }))

function fmt(n: number, digits = 0) {
  return FORMATTERS[digits].format(n)
}

/** Writes text/colour only when they change, so steady values cost no DOM work. */
type Cached = HTMLElement & { _t?: string; _c?: string }
function text(el: HTMLElement, v: string) {
  const c = el as Cached
  if (c._t !== v) {
    c._t = v
    el.textContent = v
  }
}
function color(el: HTMLElement, v: string) {
  const c = el as Cached
  if (c._c !== v) {
    c._c = v
    el.style.color = v
  }
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
      wind: q('wind'),
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
      destination: q('destination'),
      destinationLabel: q('destinationLabel'),
      destinationHint: q('destinationHint'),
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
      text(nodes.ias, fmt(s[S.IAS_KT]))
      text(nodes.gs, `GS ${fmt(s[S.GS_KT])}  TAS ${fmt(s[S.TAS_KT])}`)
      text(nodes.mach, s[S.MACH] > 0.4 ? `M ${s[S.MACH].toFixed(2)}` : `G ${s[S.G_LOAD].toFixed(1)}`)
      text(nodes.alt, fmt(Math.round(s[S.ALT_MSL_FT] / 10) * 10))
      const agl = s[S.AGL_FT]
      text(nodes.agl, agl < 2500 ? `RA ${fmt(agl)}` : '')
      const vs = s[S.VS_FPM]
      text(nodes.vs, `${vs >= 0 ? '▲' : '▼'} ${fmt(Math.abs(Math.round(vs / 10) * 10))} fpm`)
      const hdg = s[S.HEADING]
      text(nodes.hdg, `${String(Math.round(hdg) % 360).padStart(3, '0')}°`)
      strip.style.transform = `translateX(${210 - (hdg + 360) * HEADING_PX_PER_DEG}px)`
      const destination = useApp.getState().destination?.airport
      if (destination && sim.snapshotsReceived) {
        const nav = navigationTo({ lat: s[S.LAT], lon: s[S.LON] }, destination)
        const delta = angleDelta(nav.bearing, hdg)
        // Same scale as the cardinal heading strip; never clamp a marker to a false bearing.
        const inStrip = Math.abs(delta) <= 50 && nav.distanceNm > 0.05
        nodes.destination.style.display = inStrip ? 'flex' : 'none'
        nodes.destination.style.left = `${210 + delta * HEADING_PX_PER_DEG}px`
        text(nodes.destinationLabel, `${destination.ident} · ${destination.name}`)
        const bearing = String(Math.round(nav.bearing) % 360).padStart(3, '0')
        text(nodes.destinationHint, nav.distanceNm <= 0.05 ? `✈ ${destination.ident} · At destination` : `${!inStrip ? (delta < 0 ? '◀ ' : '▶ ') : ''}${destination.ident} · ${bearing}°T · ${nav.distanceNm.toFixed(1)} NM`)
        nodes.destinationHint.style.display = 'block'
      } else {
        nodes.destination.style.display = 'none'
        nodes.destinationHint.style.display = 'none'
      }
      const thr = s[S.THROTTLE]
      ;(nodes.thrBar.firstElementChild as HTMLElement).style.height = `${thr * 100}%`
      const rev = s[S.REVERSER]
      text(nodes.thr, rev > 0.05 ? (rev > 0.95 ? 'REV' : 'REV…') : `${Math.round(thr * 100)}%`)
      color(nodes.thr, rev > 0.05 ? '#ffb547' : '')
      // Wind as pilots read it: direction it blows from / speed.
      const we = s[S.WIND_E]
      const wn = s[S.WIND_N]
      const wkt = Math.hypot(we, wn) * 1.943844
      const wdir = (Math.round((Math.atan2(-we, -wn) * 180) / Math.PI + 360) % 360) || 360
      text(nodes.wind, wkt >= 1 ? `WIND ${String(wdir).padStart(3, '0')}°/${Math.round(wkt)}` : 'WIND CALM')
      const gear = s[S.GEAR]
      if (spec && !spec.retractable_gear) {
        text(nodes.gear, 'FIXED')
        color(nodes.gear, '#9aa6b6')
      } else {
        text(nodes.gear, gear > 0.99 ? 'DOWN' : gear < 0.01 ? 'UP' : 'MOVING')
        color(nodes.gear, gear > 0.99 ? '#55e08a' : gear < 0.01 ? '#e9fbff' : '#ffb547')
      }
      const fi = s[S.FLAPS_INDEX] | 0
      text(nodes.flaps, spec ? spec.flap_detents[fi] ?? String(fi) : String(fi))
      text(nodes.spd, s[S.SPOILERS] > 0.05 ? 'EXT' : '—')
      color(nodes.spd, s[S.SPOILERS] > 0.05 ? '#ffb547' : '')
      text(nodes.brake, flags & Flags.PARKING_BRAKE ? 'PARK' : s[S.BRAKE] > 0 ? 'ON' : '—')
      color(nodes.brake, flags & Flags.PARKING_BRAKE || s[S.BRAKE] > 0 ? '#ffb547' : '')
      text(nodes.gload, `${s[S.G_LOAD].toFixed(1)} G`)
      const lat = s[S.LAT]
      const lon = s[S.LON]
      text(nodes.coords, `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}  ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`)
      const apOn = (flags & Flags.AP_ENGAGED) !== 0
      text(nodes.ap, apOn ? 'AP ON' : 'AP OFF')
      const apClass = apOn ? 'ap-on' : 'faint'
      if (nodes.ap.className !== apClass) nodes.ap.className = apClass
      const m = s[S.AP_MODES] | 0
      text(
        nodes.apModes,
        apOn
          ? `${m & ApModes.HEADING ? `HDG ${String(Math.round(s[S.AP_HEADING])).padStart(3, '0')}` : ''}  ${m & ApModes.ALTITUDE ? `ALT ${fmt(s[S.AP_ALT_FT])}` : ''}  ${m & ApModes.AUTOTHROTTLE ? `SPD ${fmt(s[S.AP_SPEED_KT])}` : ''}`
          : '',
      )
      text(nodes.assist, flags & Flags.ASSIST ? 'ASSIST' : 'DIRECT')
      let warn = ''
      if (flags & Flags.STALL) warn = 'STALL'
      else if (flags & Flags.OVERSPEED) warn = 'OVERSPEED'
      else if (flags & Flags.TAILSTRIKE) warn = 'TAIL STRIKE'
      else if (!(flags & Flags.ON_GROUND) && gear < 0.5 && agl < 500 && vs < -200 && spec?.retractable_gear) warn = 'GEAR'
      text(nodes.warn, warn)
      nodes.warn.style.display = warn ? 'block' : 'none'
      text(nodes.status, flags & Flags.PAUSED ? 'PAUSED' : s[S.TIME_SCALE] > 1 ? `SIM RATE ${s[S.TIME_SCALE]}×` : '')
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className={`hud ${cockpit ? 'compact' : ''}`} ref={root}>
      <div className="hud-heading box heading-with-destination">
        <div className="strip" data-k="strip" />
        <div className="pointer" />
        <div className="compass-destination" data-k="destination" style={{ display: 'none' }}><span>✈</span><b data-k="destinationLabel" /></div>
      </div>
      <div className="hud-heading" style={{ height: 'auto', top: 94, width: 'auto', overflow: 'visible' }}>
        <b data-k="hdg" style={{ fontSize: 16 }} />
      </div>
      <div className="destination-heading-hint" data-k="destinationHint" style={{ display: 'none' }} />
      <div className="hud-status" data-k="status" />
      <div className="hud-side left box">
        <div className="hud-unit">AIRSPEED KT</div>
        <div className="hud-big" data-k="ias" />
        <div className="hud-small" data-k="gs" />
        <div className="hud-small" data-k="mach" />
        <div className="hud-small" data-k="wind" />
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
