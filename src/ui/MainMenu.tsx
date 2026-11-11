import { describeSpawn, startFlight, applySelection } from '../flight'
import { sim } from '../sim/simClient'
import { providerReady, useApp, type SpawnChoice } from '../state/store'
import { AircraftSelect } from './AircraftSelect'
import { ControlsHelp } from './ControlsHelp'
import { LocationSelect } from './LocationSelect'
import { Settings } from './Settings'
import { useAircraftList } from './useAircraftList'
import { useWorldStatus } from '../scene/worldStatus'
import { RoutePlanner } from './RoutePlanner'

const PROVIDER_LABEL = { google: 'Google Photorealistic 3D Tiles', cesium: 'Cesium ion', open: 'Open data terrain + imagery' }

export function MainMenu() {
  const screen = useApp((s) => s.screen)
  const setScreen = useApp((s) => s.setScreen)
  const aircraftId = useApp((s) => s.aircraftId)
  const spawn = useApp((s) => s.spawn)
  const destination = useApp((s) => s.destination)
  const setSpawn = useApp((s) => s.setSpawn)
  const settings = useApp((s) => s.settings)
  const list = useAircraftList()
  const error = useWorldStatus((s) => s.error)
  const aircraft = list.find((a) => a.id === aircraftId)
  const where = describeSpawn(spawn)
  const ready = providerReady(settings)

  const chooseLocation = (s: SpawnChoice) => {
    setSpawn(s)
    applySelection({ paused: true })
    setScreen('home')
  }

  return (
    <div className="menu-root">
      <div className="menu-side">
        <div className="brand">
          <img src="/app-icon.png" alt="" width={52} height={52} style={{ borderRadius: 12 }} />
          <div>
            <h1>GeoFlight</h1>
            <div className="tag">Fly anywhere on a real, photorealistic Earth</div>
          </div>
        </div>

        <div className="summary-card glass" onClick={() => setScreen('aircraft')}>
          <div style={{ fontSize: 26 }}>✈︎</div>
          <div style={{ minWidth: 0 }}>
            <div className="k">Aircraft</div>
            <div className="v">{aircraft?.name ?? '…'}</div>
            <div className="s">{aircraft ? `${aircraft.manufacturer_style} · ${aircraft.category}` : ''}</div>
          </div>
          <div className="spacer" />
          <span className="muted">Change</span>
        </div>

        <div className="summary-card glass" onClick={() => setScreen('location')}>
          <div style={{ fontSize: 26 }}>◎</div>
          <div style={{ minWidth: 0 }}>
            <div className="k">Departure</div>
            <div className="v">{where.title}</div>
            <div className="s">{where.subtitle}</div>
          </div>
          <div className="spacer" />
          <span className="muted">Change</span>
        </div>

        <button className="summary-card glass destination-card" onClick={() => setScreen('destination')}>
          <span style={{ fontSize: 26 }}>✈</span>
          <div><div className="k">Destination</div><div className="v">{destination?.airport.name ?? 'Choose an arrival airport'}</div><div className="s">{destination ? `${destination.airport.ident} · View route` : 'Optional · Preview your flight route'}</div></div>
        </button>

        {!ready ? (
          <div className="notice">
            {settings.provider === 'google' ? 'Add your Google Maps Platform API key' : 'Add your Cesium ion token'} in Settings to stream photorealistic scenery, or switch to the open-data
            world.
          </div>
        ) : error ? (
          <div className="notice">
            Scenery failed to load from {PROVIDER_LABEL[settings.provider]}: {error}. Check your key and network in Settings.
          </div>
        ) : (
          <div className="row">
            <span className={`chip ${settings.provider === 'open' ? '' : 'good'}`}>{PROVIDER_LABEL[settings.provider]}</span>
            <span className="chip">{sim.transportKind === 'tauri' ? 'Native simulation' : 'WASM simulation (browser)'}</span>
          </div>
        )}

        <button className="btn primary big" onClick={startFlight} disabled={!ready}>
          Fly now
        </button>

        <div className="menu-links">
          <button className="btn" onClick={() => setScreen('settings')}>
            Settings
          </button>
          <button className="btn" onClick={() => setScreen('controls')}>
            Controls
          </button>
        </div>
        <div className="spacer" />
        <div className="faint" style={{ fontSize: 11, lineHeight: 1.5 }}>
          Airports & runways: OurAirports (public domain). Cities: Natural Earth. Geoid: EGM96 (NGA). Scenery © its respective providers, shown in-flight.
        </div>
      </div>

      {screen === 'aircraft' ? <AircraftSelect onClose={() => setScreen('home')} /> : null}
      {screen === 'location' ? <LocationSelect initial={spawn} confirmLabel="Set departure" onConfirm={chooseLocation} onClose={() => setScreen('home')} /> : null}
      {screen === 'destination' ? <RoutePlanner onClose={() => setScreen('home')} /> : null}
      {screen === 'settings' ? <Settings onClose={() => setScreen('home')} /> : null}
      {screen === 'controls' ? <ControlsHelp onClose={() => setScreen('home')} /> : null}
    </div>
  )
}
