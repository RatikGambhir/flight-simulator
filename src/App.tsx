import { lazy, Suspense, useEffect } from 'react'
import { applySelection, syncDestination } from './flight'
import { controls } from './input/controls'
import { sim } from './sim/simClient'
import { useApp } from './state/store'
import { Attribution, FlightChrome } from './ui/FlightChrome'
import { MainMenu } from './ui/MainMenu'

// The 3D scene (three.js, 3D Tiles, atmosphere) is the heavy part of the
// bundle; load it in parallel with the menu rather than blocking first paint.
const FlightScene = lazy(() => import('./scene/FlightScene'))

export default function App() {
  const phase = useApp((s) => s.phase)

  useEffect(() => {
    controls.attach()
    const off = sim.onEvent((e) => {
      const app = useApp.getState()
      switch (e.type) {
        case 'touchdown': {
          const fpm = Math.round(e.vertical_speed_fpm)
          app.toast(`Touchdown ${fpm} fpm — ${e.rating}`, e.rating === 'Hard' ? 'warn' : 'good')
          break
        }
        case 'crashed':
          app.setCrashed(e.reason)
          break
        case 'stall':
          if (app.phase === 'flying') app.toast('STALL — lower the nose and add power', 'bad')
          break
        case 'message':
          if (app.phase === 'flying') app.toast(e.text, 'info')
          break
        case 'spawned':
          app.setCrashed(null)
          app.setAutopilotRunway(null)
          break
        case 'ap_runway':
          app.setAutopilotRunway({ airport: e.airport, runway: e.runway })
          break
        case 'liftoff':
          break
      }
    })
    // Show the selected departure behind the menu (paused) as a live preview.
    sim.ready.then(() => applySelection({ paused: true })).catch((err) => console.error('Simulation failed to start', err))
    const unsync = syncDestination()
    return () => {
      unsync()
      off()
      controls.detach()
    }
  }, [])

  return (
    <div className="app">
      <div className="drag-region" data-tauri-drag-region />
      <Suspense fallback={<div className="boot">Loading the world…</div>}>
        <FlightScene />
      </Suspense>
      {phase === 'menu' ? <MainMenu /> : <FlightChrome />}
      <Attribution />
    </div>
  )
}
