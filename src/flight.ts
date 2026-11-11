// High-level flight actions shared by the menus and in-flight UI.

import { sim } from './sim/simClient'
import type { SimCommand } from './sim/protocol'
import { useApp, type SpawnChoice } from './state/store'

export function spawnCommand(s: SpawnChoice): SimCommand {
  if (s.kind === 'runway') return { type: 'spawn_runway', airport: s.airport, runway: s.runway, kind: s.mode }
  return {
    type: 'spawn',
    lat: s.lat,
    lon: s.lon,
    heading: s.heading,
    mode: s.mode,
    agl_ft: s.aglFt,
    speed_kt: null,
    ground_elevation_ft: s.elevationFt,
  }
}

/** Applies the menu selection to the simulation (used for the live preview too). */
export function applySelection(opts: { paused: boolean }) {
  const { aircraftId, spawn, settings } = useApp.getState()
  sim.command({ type: 'set_aircraft', id: aircraftId })
  sim.command({ type: 'set_assist', enabled: settings.assist })
  sim.command({ type: 'set_time_scale', scale: settings.timeScale })
  sim.command(spawnCommand(spawn))
  sim.command({ type: 'set_paused', paused: opts.paused })
}

export function startFlight() {
  const app = useApp.getState()
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
  sim.command({ type: 'reset' })
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
  return {
    title: s.label,
    subtitle: `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)} · ${s.mode === 'air' ? `In flight at ${Math.round(s.aglFt).toLocaleString()} ft AGL` : 'On the ground'}`,
  }
}
