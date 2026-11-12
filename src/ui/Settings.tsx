import { sim } from '../sim/simClient'
import { useApp, type Provider, type Quality } from '../state/store'
import { simWeather, useWeather } from '../weather/liveWeather'

const PROVIDERS: { id: Provider; title: string; text: string }[] = [
  {
    id: 'google',
    title: 'Google Photorealistic 3D Tiles',
    text: 'Best realism: photogrammetry of 2,500+ cities with real buildings and landmarks. Needs a Google Maps Platform API key with the Map Tiles API enabled (billed usage).',
  },
  {
    id: 'cesium',
    title: 'Cesium ion',
    text: 'Google 3D Tiles via Cesium ion, or Cesium World Terrain + Bing aerial imagery + OSM 3D buildings worldwide. Needs a free Cesium ion access token.',
  },
  {
    id: 'open',
    title: 'Open data (no key)',
    text: 'Real terrain (AWS Terrain Tiles / SRTM) draped with satellite imagery. Accurate mountains, coastlines and valleys everywhere, but no 3D buildings.',
  },
]

const QUALITIES: { id: Quality; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'ultra', label: 'Ultra' },
]

const TURBULENCE: [string, number][] = [
  ['None', 0],
  ['Light', 0.2],
  ['Moderate', 0.45],
  ['Severe', 0.8],
]

function compass(deg: number) {
  const pts = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return pts[Math.round(deg / 45) % 8]
}

function formatHour(h: number) {
  const hh = Math.floor(h)
  const mm = Math.round((h - hh) * 60)
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

export function Settings({ onClose, full }: { onClose: () => void; full?: boolean }) {
  const s = useApp((st) => st.settings)
  const update = useApp((st) => st.updateSettings)
  const wx = useWeather()
  const hasKey = s.googleApiKey.trim().length > 10
  // Live weather owns clouds, wind and turbulence while it has a report.
  const live = s.liveWeather && wx.conditions ? wx.conditions : null
  const liveWind = live ? simWeather(live) : null
  const wind = liveWind ?? { windFromDeg: s.windFromDeg, windSpeedKt: s.windSpeedKt, turbulence: s.turbulence }

  return (
    <div className={`sheet glass ${full ? 'full' : ''}`}>
      <div className="sheet-header">
        <h2>Settings</h2>
        <div className="spacer" />
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
      <div className="sheet-body">
        <div className="settings-grid">
          <section className="settings-section glass">
            <h3>World data</h3>
            {PROVIDERS.map((p) => (
              <div key={p.id} className={`provider-option ${s.provider === p.id ? 'on' : ''}`} onClick={() => update({ provider: p.id })}>
                <input type="radio" readOnly checked={s.provider === p.id} />
                <div>
                  <div style={{ fontWeight: 600 }}>{p.title}</div>
                  <p>{p.text}</p>
                </div>
              </div>
            ))}
            {s.provider === 'google' || s.liveWeather ? (
              <div className="field">
                <label>Google Maps Platform API key</label>
                <input className="input" type="password" value={s.googleApiKey} placeholder="AIza…" onChange={(e) => update({ googleApiKey: e.target.value })} />
                <span className="faint" style={{ fontSize: 12 }}>
                  Stored only on this Mac. Enable “Map Tiles API” (scenery) and “Weather API” (live weather) for the key in Google Cloud Console.
                </span>
              </div>
            ) : null}
            {s.provider === 'cesium' ? (
              <>
                <div className="field">
                  <label>Cesium ion access token</label>
                  <input className="input" type="password" value={s.cesiumToken} placeholder="eyJhbGciOi…" onChange={(e) => update({ cesiumToken: e.target.value })} />
                </div>
                <div className="segmented">
                  <button className={s.cesiumMode === 'photorealistic' ? 'on' : ''} onClick={() => update({ cesiumMode: 'photorealistic' })}>
                    Google 3D Tiles via ion
                  </button>
                  <button className={s.cesiumMode === 'terrain' ? 'on' : ''} onClick={() => update({ cesiumMode: 'terrain' })}>
                    World Terrain + OSM Buildings
                  </button>
                </div>
              </>
            ) : null}
            {s.provider === 'open' ? (
              <div className="field">
                <label>Imagery</label>
                <div className="segmented">
                  <button className={s.openImagery === 'esri' ? 'on' : ''} onClick={() => update({ openImagery: 'esri' })}>
                    Esri World Imagery (sharpest)
                  </button>
                  <button className={s.openImagery === 'eox' ? 'on' : ''} onClick={() => update({ openImagery: 'eox' })}>
                    Sentinel-2 cloudless
                  </button>
                </div>
              </div>
            ) : null}
          </section>

          <section className="settings-section glass">
            <h3>Graphics</h3>
            <div className="field">
              <label>Scenery detail</label>
              <div className="segmented">
                {QUALITIES.map((q) => (
                  <button key={q.id} className={s.quality === q.id ? 'on' : ''} onClick={() => update({ quality: q.id })}>
                    {q.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label>Render resolution: {Math.round(s.renderScale * 100)}%</label>
              <input type="range" min={0.5} max={1} step={0.05} value={s.renderScale} onChange={(e) => update({ renderScale: Number(e.target.value) })} />
            </div>
            <div className="toggle-row">
              <span>Adaptive cloud detail (holds the frame rate; scene resolution stays fixed)</span>
              <input type="checkbox" checked={s.adaptiveResolution} onChange={(e) => update({ adaptiveResolution: e.target.checked })} />
            </div>
            <div className="toggle-row">
              <span>Volumetric clouds</span>
              <input type="checkbox" checked={s.clouds} onChange={(e) => update({ clouds: e.target.checked })} />
            </div>
            <div className="field">
              <label>{live ? `Cloud coverage: live (${Math.round(live.cloudCover * 100)}% sky cover)` : `Cloud coverage: ${Math.round(s.cloudCoverage * 100)}%`}</label>
              <input type="range" min={0} max={0.8} step={0.01} value={s.cloudCoverage} disabled={!s.clouds || !!live} onChange={(e) => update({ cloudCoverage: Number(e.target.value) })} />
            </div>
            <div className="toggle-row">
              <span>Aircraft shadows</span>
              <input type="checkbox" checked={s.shadows} onChange={(e) => update({ shadows: e.target.checked })} />
            </div>
            <div className="toggle-row">
              <span>Show FPS and render resolution</span>
              <input type="checkbox" checked={s.showFps} onChange={(e) => update({ showFps: e.target.checked })} />
            </div>
          </section>

          <section className="settings-section glass">
            <h3>Time of day</h3>
            <div className="toggle-row">
              <div>
                <div>Use real time</div>
                <div className="faint" style={{ fontSize: 12 }}>
                  The sun, moon and stars are where they really are right now over the aircraft: day, dusk or night follows your position.
                </div>
              </div>
              <input type="checkbox" checked={s.realTime} onChange={(e) => update({ realTime: e.target.checked })} />
            </div>
            <div className="field">
              <div className="faint" style={{ fontSize: 12 }}>Manual time uses today’s date at the aircraft. Moon phase and daylight follow the season.</div>
              <label>Local solar time: {formatHour(s.timeOfDay)}</label>
              <input type="range" min={0} max={23.99} step={0.05} value={s.timeOfDay} disabled={s.realTime} onChange={(e) => update({ timeOfDay: Number(e.target.value) })} />
            </div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {[
                ['Early morning', 6.6],
                ['Morning', 9.5],
                ['Noon', 12.5],
                ['Afternoon', 15.5],
                ['Evening', 18.6],
                ['Night', 22],
              ].map(([l, h]) => (
                <button key={l as string} className="btn" style={{ padding: '5px 10px', fontSize: 12 }} disabled={s.realTime} onClick={() => update({ timeOfDay: h as number })}>
                  {l}
                </button>
              ))}
            </div>
          </section>

          <section className="settings-section glass">
            <h3>Weather</h3>
            <div className="toggle-row">
              <div>
                <div>Live weather</div>
                <div className="faint" style={{ fontSize: 12 }}>
                  {!s.liveWeather
                    ? 'Real clouds, haze, rain, snow and wind at the aircraft, from the Google Weather API.'
                    : !hasKey
                      ? 'Add a Google Maps Platform API key under World data.'
                      : live
                        ? `${live.description}${live.tempC !== null ? ` · ${Math.round(live.tempC)}°C` : ''}${live.visibilityKm !== null ? ` · visibility ${Math.round(live.visibilityKm)} km` : ''}`
                        : wx.status === 'error'
                          ? `Unavailable: ${wx.error}`
                          : 'Fetching conditions…'}
                </div>
              </div>
              <input type="checkbox" checked={s.liveWeather} onChange={(e) => update({ liveWeather: e.target.checked })} />
            </div>
            <div className="field">
              <label>
                Surface wind: {wind.windSpeedKt < 1 ? 'calm' : `${String(Math.round(wind.windFromDeg)).padStart(3, '0')}° (${compass(wind.windFromDeg)}) at ${Math.round(wind.windSpeedKt)} kt`}
              </label>
              <input type="range" min={0} max={40} step={1} value={Math.min(40, wind.windSpeedKt)} disabled={!!live} onChange={(e) => update({ windSpeedKt: Number(e.target.value) })} />
            </div>
            <div className="field">
              <label>Wind from</label>
              <input type="range" min={0} max={350} step={10} value={wind.windFromDeg % 360} disabled={!!live || s.windSpeedKt < 1} onChange={(e) => update({ windFromDeg: Number(e.target.value) })} />
            </div>
            <div className="field">
              <label>Turbulence</label>
              <div className="segmented">
                {TURBULENCE.map(([label, v]) => (
                  <button key={label} className={!live && Math.abs(s.turbulence - v) < 0.05 ? 'on' : ''} disabled={!!live} onClick={() => update({ turbulence: v })}>
                    {label}
                  </button>
                ))}
              </div>
              <span className="faint" style={{ fontSize: 12 }}>
                {live ? 'Wind and turbulence follow the live report. ' : ''}Wind strengthens with height and gusts near the ground. Clouds drift with it.
              </span>
            </div>
          </section>

          <section className="settings-section glass">
            <h3>Sound</h3>
            <div className="field">
              <label>Volume: {Math.round(s.volume * 100)}%</label>
              <input type="range" min={0} max={1} step={0.05} value={s.volume} onChange={(e) => update({ volume: Number(e.target.value) })} />
            </div>
            <div className="toggle-row">
              <div>
                <div>Cockpit callouts</div>
                <div className="faint" style={{ fontSize: 12 }}>
                  Radio-altitude calls and ground-proximity warnings in jets.
                </div>
              </div>
              <input type="checkbox" checked={s.callouts} onChange={(e) => update({ callouts: e.target.checked })} />
            </div>
          </section>

          <section className="settings-section glass">
            <h3>Flying</h3>
            <div className="toggle-row">
              <div>
                <div>Assisted flight</div>
                <div className="faint" style={{ fontSize: 12 }}>
                  Holds attitude, coordinates turns and prevents stalls. Off = direct control.
                </div>
              </div>
              <input
                type="checkbox"
                checked={s.assist}
                onChange={(e) => {
                  update({ assist: e.target.checked })
                  sim.command({ type: 'set_assist', enabled: e.target.checked })
                }}
              />
            </div>
            <div className="field">
              <label>Control sensitivity: {Math.round(s.sensitivity * 100)}%</label>
              <input type="range" min={0.3} max={1} step={0.05} value={s.sensitivity} onChange={(e) => update({ sensitivity: Number(e.target.value) })} />
            </div>
            <div className="toggle-row">
              <span>Invert pitch (↑ = nose up)</span>
              <input type="checkbox" checked={s.invertPitch} onChange={(e) => update({ invertPitch: e.target.checked })} />
            </div>
            <div className="field">
              <label>Simulation speed</label>
              <div className="segmented">
                {[1, 2, 4].map((t) => (
                  <button
                    key={t}
                    className={s.timeScale === t ? 'on' : ''}
                    onClick={() => {
                      update({ timeScale: t })
                      sim.command({ type: 'set_time_scale', scale: t })
                    }}
                  >
                    {t}×
                  </button>
                ))}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
