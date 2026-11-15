// High-level flight actions shared by the menus and in-flight UI.

import { sound } from './audio/sound'
import { sim } from './sim/simClient'
import type { AirportDetail, RocketFlightState, SimCommand } from './sim/protocol'
import { useApp, type Settings, type SpawnChoice } from './state/store'
import { simWeather, useWeather } from './weather/liveWeather'

/** Wind and turbulence for the sim: the live report when enabled and available, else the manual settings. */
export function weatherCommand(s: Settings): SimCommand {
  const live = s.liveWeather ? useWeather.getState().conditions : null
  if (live) {
    const w = simWeather(live)
    return { type: 'set_weather', wind_from_deg: w.windFromDeg, wind_speed_kt: w.windSpeedKt, turbulence: w.turbulence }
  }
  return { type: 'set_weather', wind_from_deg: s.windFromDeg, wind_speed_kt: s.windSpeedKt, turbulence: s.turbulence }
}

/** The destination the autopilot navigates to (null: hold / climb out only). */
export function destinationCommand(d: AirportDetail | null): SimCommand {
  return { type: 'set_destination', airport: d?.airport.ident ?? null }
}

/**
 * Keeps the simulation's destination in step with the one chosen in the UI.
 * (The initial value goes with `applySelection`, once the simulation is ready.)
 */
export function syncDestination() {
  return useApp.subscribe((s, prev) => {
    if (s.destination !== prev.destination) {
      if (!s.destination) useApp.getState().setAutopilotRunway(null)
      const cmd = destinationCommand(s.destination)
      sim.ready.then(() => sim.command(cmd)).catch(() => {})
    }
  })
}

export const X15_LAUNCH: RocketFlightState = { altitude_ft: 45_000, mach: 0.75, heading: 270 }
export const X15_MAX_ALT_FT = 354_200
export const X15_MAX_MACH = 6.7

export function x15Departure(spawn: SpawnChoice): SpawnChoice {
  if (spawn.kind === 'rocket') return spawn
  const location = spawn.kind === 'coords' ? spawn : {
    label: 'Edwards flight test area', lat: 34.9054, lon: -117.8837, elevationFt: null,
  }
  return { kind: 'rocket', label: location.label, lat: location.lat, lon: location.lon, elevationFt: location.elevationFt,
    ...X15_LAUNCH, heading: spawn.kind === 'coords' ? spawn.heading : X15_LAUNCH.heading }
}

export function spawnCommand(s: SpawnChoice): SimCommand {
  if (s.kind === 'runway') return { type: 'spawn_runway', airport: s.airport, runway: s.runway, kind: s.mode }
  if (s.kind === 'rocket') return {
    type: 'spawn_rocket', lat: s.lat, lon: s.lon, altitude_ft: s.altitude_ft,
    heading: s.heading, mach: s.mach, ground_elevation_ft: s.elevationFt,
  }
  return {
    type: 'spawn',
    lat: s.lat,
    lon: s.lon,
    heading: s.heading,
    mode: s.mode,
    agl_ft: s.aglFt,
    cruise: s.cruise,
    speed_kt: null,
    ground_elevation_ft: s.elevationFt,
  }
}

/** Applies the menu selection to the simulation (used for the live preview too). */
export function applySelection(opts: { paused: boolean }) {
  const { aircraftId, spawn, settings, destination } = useApp.getState()
  sim.command({ type: 'set_aircraft', id: aircraftId })
  sim.command(destinationCommand(destination))
  sim.command({ type: 'set_assist', enabled: settings.assist })
  sim.command({ type: 'set_time_scale', scale: settings.timeScale })
  sim.command(weatherCommand(settings))
  sim.command(spawnCommand(spawn))
  sim.command({ type: 'set_paused', paused: opts.paused })
}

export function startFlight() {
  const app = useApp.getState()
  // Called from the "Fly now" click, so the browser allows audio to start.
  sound.unlock()
  applySelection({ paused: false })
  app.setCamera('chase')
  app.setPhase('flying')
}

export function relocate(spawn: SpawnChoice) {
  const app = useApp.getState()
  app.setSpawn(spawn)
  app.setCrashed(null)
  sim.command(spawnCommand(spawn))
  sim.command({ type: 'set_paused', paused: false })
  app.setPauseMenu(false)
}

export function restartFlight() {
  const app = useApp.getState()
  app.setCrashed(null)
  // Skip-to changes the sim's last spawn, but "restart from departure" should
  // still return to the departure selected by the user.
  sim.command(spawnCommand(app.spawn))
  sim.command({ type: 'set_paused', paused: false })
  app.setPauseMenu(false)
}

export function returnToMenu() {
  const app = useApp.getState()
  sim.command({ type: 'set_paused', paused: true })
  app.setPhase('menu')
  app.setScreen('home')
}

export function describeSpawn(s: SpawnChoice): { title: string; subtitle: string } {
  if (s.kind === 'runway') {
    return {
      title: s.airportName,
      subtitle: `${s.airport}${s.runway ? ` · Runway ${s.runway}` : ''} · ${s.mode === 'takeoff' ? 'Ready for takeoff' : 'Final approach (6 nm)'}`,
    }
  }
  if (s.kind === 'rocket') return {
    title: s.label,
    subtitle: `${s.altitude_ft.toLocaleString()} ft MSL · Mach ${s.mach.toFixed(2)} · ${s.heading % 360}° true`,
  }
  return {
    title: s.label,
    subtitle: `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)} · ${s.cruise ? 'Mach 3.2 at 85,000 ft MSL' : s.mode === 'air' ? `In flight at ${Math.round(s.aglFt).toLocaleString()} ft AGL` : 'On the ground'}`,
  }
}
