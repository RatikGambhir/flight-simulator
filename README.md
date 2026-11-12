# GeoFlight

A macOS desktop flight simulator for exploring a real, photorealistic Earth.
Built with **Tauri 2 + Rust** (simulation) and **React + TypeScript + Three.js /
React Three Fiber** (rendering and UI).

Pick an aircraft (737‑style, A320‑style, business jet, Longitude‑style super‑midsize jet or Cessna‑style single), choose any of
~9,600 real airports or any point on the globe, take off with one simple control
scheme, and fly over streamed, geographically accurate scenery: Google Photorealistic
3D Tiles (real buildings and landmarks), Cesium ion, or a free open‑data terrain mode.

---

## Quick start (macOS)

Prerequisites: macOS 13+, Xcode Command Line Tools (`xcode-select --install`),
[Rust](https://rustup.rs) (stable), Node.js 20+.

```bash
npm install
```

```bash
npm run app:dev
```

That launches the native app with hot reload. To build a signed‑less `.app` and `.dmg`:

```bash
npm run app:build
```

The bundle lands in `target/release/bundle/macos/` and `target/release/bundle/dmg/`.

The app runs immediately in **Open data** mode (no key). For photorealistic cities, add a
Google or Cesium key in **Settings → World data** (stored only in local app storage), or
put it in a `.env` file at the project root before building:

```bash
echo 'VITE_GOOGLE_MAPS_API_KEY=AIza...' > .env.local
```

`VITE_CESIUM_ION_TOKEN=...` works the same way.

### Browser development mode (optional)

The Rust simulation core also compiles to WebAssembly, so the whole app can run in a
regular browser for UI work:

```bash
rustup target add wasm32-unknown-unknown
```

```bash
npm run dev:web
```

Then open http://localhost:1420. Add `?lite` to the URL on slow GPUs (no clouds/shadows,
half resolution).

---

## World data providers, keys and costs

| Mode | What you see | Needs | Cost / terms |
| --- | --- | --- | --- |
| **Google Photorealistic 3D Tiles** (recommended) | Photogrammetry of 2,500+ cities with real buildings and landmarks, plus global terrain and imagery | Google Cloud project with billing and the **Map Tiles API** enabled; an API key | Billed per root‑tileset request/session beyond the monthly free allowance — check current [Map Tiles API pricing](https://developers.google.com/maps/billing-and-pricing/pricing). Tiles may not be cached/stored offline or used outside the API terms; on‑screen Google attribution is required. |
| **Cesium ion** | Either Google 3D Tiles relayed through ion (asset 2275207), or Cesium World Terrain + Bing Maps Aerial + Cesium OSM Buildings worldwide | Free [Cesium ion](https://ion.cesium.com) account + access token | Free Community tier (non‑commercial, usage caps); commercial use needs a paid plan. |
| **Open data** (default, no key) | Real terrain (AWS Terrain Tiles: SRTM/GMTED/ETOPO/NED) draped with satellite imagery; animated ocean at true sea level | Nothing | Esri World Imagery: free with attribution for development/non‑commercial use under Esri’s terms (production use may require an ArcGIS account). EOX Sentinel‑2 cloudless: CC BY‑NC‑SA 4.0. AWS Terrain Tiles: open, attribution required. No 3D buildings. |

**API key tips (Google):** the app's web view origin is `tauri://localhost`, so HTTP‑referrer
key restrictions won't match. Restrict the key by **API** (Map Tiles API only) and keep it
private. The app requests a new session token when needed (`autoRefreshToken`).

**Online place search** ("Search online" in the location picker) uses OpenStreetMap
Nominatim, which allows at most 1 request/second and requires attribution; everything
else (airports, cities, landmarks) is searched offline from bundled data.

---

## Controls (identical for every aircraft)

| Keys | Action |
| --- | --- |
| `W`/`↑`, `S`/`↓` | Nose down / nose up (invertible in Settings) |
| `A`/`←`, `D`/`→` | Roll left / right |
| `J` / `E` | Rudder; nosewheel steering on the ground |
| `R` / `F` | Throttle up / down (`⇧R` full, `⇧F` idle) |
| `X` (hold) | Reverse thrust (jets, on the ground with throttle at idle) |
| `G` | Landing gear |
| `[` / `]` | Flaps up / down |
| `/` | Speed brakes |
| `Space` or `.` (hold) / `N` | Wheel brakes / parking brake |
| `T` | Assisted flight on/off |
| `Z` | Autopilot on/off at any moment. With a destination it flies the whole flight (see below); without one it holds heading, altitude and speed. `⇧←/→` heading ±5°, `⇧↑/↓` altitude ±500 ft, `⌥R/⌥F` speed ±5 kt (cruise level/speed when navigating) |
| `C`, `V`, `1`–`6` | Cycle cameras, cockpit↔exterior, Exterior / Cockpit / Wing / Free / Cinematic / Flyby |
| Mouse drag / scroll / double‑click | Look around or orbit / zoom / reset view |
| `H`, `P`, `Esc`, `?` | HUD, pause, menu, controls help |
| `M` | Destination selection and live route map |
| `Q` | Skip to a chosen number of miles from the destination |
| `Shift` + `~` (the backquote key) | Toggle the destination airport beacon |

The **737-800 cockpit** has a dedicated NG-style interior with six main display
units, standby instruments, a labeled MCP/EFIS panel, dual yokes, throttle
quadrant, CDU keypads and overhead switches. Click **CMD A** to toggle autopilot;
click the speed, heading and altitude knobs to increase their targets, or
Shift-click to decrease. Throttle handles change power by 10% (Shift-click to
decrease); the gear and speed-brake handles toggle their controls, and the flap
handle moves one notch down (Shift-click up). Hover a main control for its hint.
Other buttons, radios and overhead switches are decorative. Secondary engine
readouts are visual approximations of the simulator's engine spool, not a
full aircraft-systems simulation. Existing keyboard controls work as before.

Choose **Destination** before flying to search for an arrival airport and preview a
direct great-circle route. The compass places the airport icon and name at its
current true bearing, with distance remaining below. The optional world beacon
is anchored to the airport's coordinates and elevation and follows the camera;
it disappears when outside the view. The map uses the bundled coastline and
airport data and shows your live aircraft position. Routes are direct navigation
guides, not airway or ATC flight plans. Clear the destination to return to free flight.

Press **Q** for **Skip to**, enter **1–10,000 ordinary miles (mi)** from your selected
airport, then press **Okay**. The screen fades to black while the aircraft is
placed airborne on the current route, pointing toward the airport, then fades
back in. Terrain placement finishes before the transition ends. The aircraft
uses a trimmed flying speed, with at least 5,000 ft terrain clearance (1,500 ft
within 15 miles). Cancel/Escape preserves the flight, and an already paused
flight stays paused. The compass continues to display nautical miles (NM).

Holding a flight key builds up deflection gradually (a tap is a small correction), like
moving a real yoke. Standard‑layout gamepads work too (left stick flies, triggers throttle,
bumpers rudder, A gear, B/X flaps, Y camera, D‑pad down reverse thrust, Start menu).

**First takeoff:** `⇧R` for full power, keep straight with `J`/`E`, gently hold `S` at the
rotate speed shown on the aircraft card, then `G` (gear up) and `[` (flaps up). `Z` hands
over to the autopilot.

### Autopilot

Choose a destination (`M`), then press `Z` — parked on a runway, mid-climb, in a turn, on
final or rolling out. The autopilot assesses the aircraft's state and flies the rest of the
flight through the same controls you use (stick, throttle, rudder/nosewheel, brakes,
reversers, gear, flaps), never by moving the aircraft:

* **Ground:** taxis straight to a nearby runway if you are not on one, lines up, sets
  takeoff flaps and power, tracks the centreline, rotates at Vr and lifts off.
* **Climb and cruise:** retracts gear and flaps on schedule, climbs to a cruise level sized
  to the trip (short hops stay low), observes 250 kt below 10,000 ft and a Mach limit, and
  flies a great-circle route.
* **Descent:** starts at the top of descent on a 3° profile with a level segment to slow
  down and configure before the glideslope.
* **Approach and landing:** picks the runway from the wind, length and arrival direction
  (the landing guide shows it), flies a straight-in or a downwind/base pattern, intercepts
  the extended centreline and a 3° glidepath, lowers gear and flaps, adds a wind/gust
  speed additive, flares, lands, deploys spoilers and reversers, autobrakes and stops with
  the parking brake set.
* **Safety:** it goes around if the approach is not stable at 1,000 ft (500 ft in light
  aircraft), sinks too fast, is not lined up at 100 ft, floats or bounces, and tries
  again; after three attempts it holds and asks you to take over. In severe turbulence,
  gusts beyond what an automatic landing can handle, or crosswinds/tailwinds beyond the
  aircraft's limits, it circles the field instead of landing. Terrain reported ahead by
  the renderer raises the minimum altitude, with a climb-away if it gets close.
* **Hand-back:** press `Z` again, or move the stick firmly (or brake during the takeoff
  roll) to take over; nothing changes abruptly. Using the throttle in flight only turns
  the autothrottle off.

The HUD shows the active phase (TAKEOFF, CLIMB, CRUISE, DESCENT, APPROACH, FINAL, FLARE,
ROLLOUT, LANDED, GO-AROUND …), the route and the targets; the 737's PFD shows matching
flight modes. Without a destination, `Z` on the runway takes off and holds runway heading
5,000 ft (3,000 ft for light aircraft) above the field; choosing a destination later hands
over to full navigation.

---

## Architecture

```
┌──────────────────────── Tauri app (macOS) ───────────────────────────┐
│  Rust (native)                         WebView (React + Three.js)    │
│  ┌──────────────────────────┐          ┌──────────────────────────┐  │
│  │ sim thread @120 Hz fixed │─ binary ─▶ SimClient: snapshot       │  │
│  │  sim-core::Simulation    │ snapshots│  history + interpolation │  │
│  │  - flight dynamics       │  ~60 Hz  │                          │  │
│  │  - autopilot             │ (IPC     │ FlightLoop (per frame):  │  │
│  │  - spawn / runways       │ Channel) │  floating origin rebase  │  │
│  │  - world DB (airports,   │◀─ input ─│  aircraft + animation    │  │
│  │    cities, geoid)        │  cmds    │  camera rig              │  │
│  └──────────────────────────┘ ◀ ground │  3D Tiles streaming      │  │
│       ▲ world_query (async)     height │  ground probe + collision│  │
│       └────────────────────── search ──│  atmosphere / clouds     │  │
│                                        └──────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

* **`crates/sim-core`** — platform‑independent Rust: WGS84 geodesy, ISA atmosphere,
  aircraft specs, flight dynamics, autopilot (`autopilot/`: flight-phase state machine,
  per-aircraft performance model, runway/route geometry and rate-limited control laws,
  run inside the fixed physics step), fixed‑step driver, and the bundled world
  database (OurAirports airports/runways, Natural Earth cities, curated landmarks,
  EGM96 geoid). Fully unit tested (`cargo test -p sim-core`).
* **`src-tauri`** — the desktop host. A dedicated thread runs the simulation at a fixed
  120 Hz step and streams snapshots as raw little‑endian `f64` arrays over a Tauri IPC
  `Channel` (no JSON on the hot path). Inputs and commands are posted through an mpsc queue,
  so the UI thread never blocks. World searches run as async commands.
* **`crates/sim-wasm`** — the same core compiled to WebAssembly for the browser dev mode,
  running in a Web Worker with the identical snapshot protocol.
* **Frontend (`src/`)**
  * `sim/` — transport abstraction (Tauri or WASM worker), snapshot protocol mirror, and
    `SimClient`, which keeps a snapshot history and interpolates position (f64 ECEF) and
    attitude (quaternion slerp) for each display frame.
  * `world/` — **floating origin**: the scene is a local East‑Up‑South frame anchored near
    the aircraft and re‑based every 3 km. ECEF→world conversion happens on the CPU in double
    precision, so the GPU only sees small coordinates (no Earth‑scale float32 jitter).
    `providers.ts` configures the 3D Tiles layers; `worldSystem.ts` streams them, probes
    ground height (BVH‑accelerated raycasts, rejecting tiles whose geometric error is too
    coarse) and casts forward collision rays against buildings/terrain. A coarse
    secondary streaming view follows horizontal flight velocity roughly 12 seconds
    ahead (600 m–6 km), using the same bounded cache and download queues. The visible
    camera continues to request full detail; prefetch switches off below 25 m/s
    and outside active flight.
  * `scene/` — React Three Fiber scene: Takram’s precomputed atmospheric scattering
    (sky, aerial perspective, sun & sky light), volumetric clouds, stars, lens flare, AgX
    tone mapping, SMAA, dithering, a PMREM sky environment for reflections and an animated
    ocean (open‑data mode), plus shoreline-clipped, geoid-corrected Great Lakes water
    in all providers. Lake surfaces load nearby and are released when flying away;
    source data and elevation limitations are documented in `public/water/README.md`.
  * `aircraft/` — procedural models (parametric fuselage cross‑sections, NACA‑airfoil wings
    with hinged flaps/ailerons/spoilers, lathe‑turned nacelles with spinning fans,
    retractable gear, nav/strobe/beacon lights), painted liveries, cockpit interiors with
    live PFD/ND/EICAS or six‑pack instruments, and a sun‑projected ground shadow.
  * `camera/`, `input/`, `ui/` — camera modes (exterior cameras trail the aircraft's
    acceleration on a spring; the pilot's head moves with g‑forces and runway rumble), the
    universal control scheme, menus and HUD.
  * `audio/` — procedural Web Audio: turbofan whine/roar or propeller buzz from engine RPM,
    wind noise with airspeed and drag devices, tyre rumble, touchdown thumps, gear/flap
    motors, stall horn / stick shaker, overspeed clacker, autopilot‑disconnect tone and
    spoken radio‑altitude / GPWS callouts. The cockpit muffles outside sound.

**Level of detail & memory:** 3d‑tiles‑renderer refines tiles by screen‑space error
(the *Scenery detail* setting sets the error target), fades between levels, unloads tiles
after a delay and keeps GPU memory under an LRU byte budget (350 MB–1.4 GB by quality).

**Ground & elevation:** the renderer samples the real surface under the aircraft at 10 Hz
and sends it to Rust, so you land on the actual runway / rooftop / mountain in the tiles.
Spawns wait until scenery is loaded before placing the aircraft; the airport database
elevation (converted to ellipsoid height with EGM96) is the fallback. Altitudes on the HUD
are true MSL (ellipsoid height minus geoid).

### Flight model

Forces are integrated in ECEF at 120 Hz: lift from an angle‑of‑attack lift curve with
flaps, spoilers and a soft stall; parabolic drag with gear/flap/spoiler increments; thrust
with altitude lapse (jets) or a power‑limited propeller model; gravity; wheel friction,
braking and nosewheel steering on the ground.

* **Wind and turbulence** (`crates/sim-core/src/weather.rs`): surface wind follows the 1/7
  power‑law boundary layer (weaker in the flare than at pattern altitude); turbulence is a
  Dryden‑style gust model (MIL‑F‑8785C) with height‑dependent length scales. Below
  1,000 ft the wind adds mechanical turbulence (vertical gusts of 0.1 × the 20 ft wind, the
  MIL low‑altitude value, fading out by 2,000 ft), combined with the turbulence setting as
  an independent source, so 15 kt of wind on top of Moderate adds only a little. Roll,
  pitch and yaw gusts match the RMS of the Dryden rotary spectra for the aircraft's
  wingspan; eddies smaller than the airframe (near the ground the vertical ones are only as
  big as the height) don't rock it harder, so in the flare a light aircraft is rocked far
  more than an airliner, and side
  gusts (about twice the vertical ones low down) make yaw the liveliest axis. Aerodynamics
  use the air‑relative velocity, so headwinds cut ground speed, crosswinds need a crab, and
  approaches spawn crabbed onto a true 3° glideslope over the ground.
* **Ground effect** within about a wingspan of the runway reduces induced drag and adds
  lift, so airliners float in the flare.
* **Turbofan spool‑up** is slow from idle and quick near the top; **thrust reversers**
  deploy on the ground at idle and give roughly 40 % reverse thrust.
* The simulation reports the **felt g‑load** in body axes, which drives the HUD G meter,
  camera head motion and shake. Rotation uses a rate‑command control law so
one control scheme works for every aircraft — heavier aircraft have lower rate limits and
slower response.

* **Assisted** (default): the stick commands load factor like a fly‑by‑wire airliner;
  releasing it holds the current flight path and bank, turns are auto‑coordinated, wings
  level themselves from shallow bank and the wing is protected from stalling.
* **Direct**: the stick commands angle of attack around an auto‑trimmed point with natural
  stability; stalls and spiral dives are possible.

Takeoff performance is in the right ballpark (e.g. the 737 rotates ~25 s after brake
release at full power, the Cessna climbs ~700 fpm at 64 kt); it is not a certified model.

---

## Project layout

```
crates/sim-core     Rust simulation core (+ examples/trace.rs, examples/maneuver.rs)
crates/sim-wasm     WASM exports for browser dev mode
src-tauri           Tauri 2 desktop host (sim thread, IPC commands, config, icons)
src                 React/TypeScript frontend
data                Bundled datasets (airports, runways, cities, geoid grid)
public              Cloud noise volumes, Draco decoder, star catalogue, icon
scripts             Dataset generators (see scripts/README.md)
```

## Development

```bash
cargo test -p sim-core
```

```bash
cargo run -p sim-core --example maneuver
```

```bash
cargo run -p sim-core --release --example autoflight -- b737 KORD 28R KMKE
```

The `autoflight` example flies a complete autopilot flight and prints a trace (`-- c172
approach KORD 28R 270 15 0.2` starts on final with wind and turbulence; `-- stats b737 270
15 0.2 20` flies many approaches and summarises the touchdowns and go-arounds).
End-to-end autopilot flights are part of `cargo test -p sim-core`
(`crates/sim-core/tests/autopilot_e2e.rs`).

```bash
npm run test:autopilot # snapshot/protocol sync with Rust, HUD autopilot annunciator
```

```bash
npm run typecheck
```

```bash
npm run test:graphics # Node 22.18+; clouds, aircraft geometry/hinges, lake surfaces and flight prefetch
npm run test:graphics:gpu # macOS with WebGL 2; checks rendered pixels for day, sunset and night
```

Clouds use continuous reduced-resolution sampling with temporal antialiasing,
rather than the library's 16-frame checkerboard reconstruction. History is reset
on camera cuts, relocation, world-origin changes, resolution and quality changes.
Atmosphere precomputation is owned per effect lifetime so development reloads
cannot dispose the lighting textures still used by the sky and clouds.

### Adding an aircraft

1. Add an `AircraftSpec` to `crates/sim-core/src/aircraft.rs` (mass, wing, thrust, handling).
2. Add a builder in `src/aircraft/models.ts` (reuse `buildAirliner` with new dimensions or
   compose the geometry helpers) and register it in `BUILDERS` under the same `id`.
3. Optionally add a livery in `src/aircraft/materials.ts`.

### Adding a data provider

Add a case to `createLayers` in `src/world/providers.ts` returning one or more
`TilesRenderer` layers; everything else (streaming, ground probing, attribution) is generic.

---

## Data sources & licences

| Data | Source | Licence |
| --- | --- | --- |
| Airports, runways (positions, true headings, elevations) | [OurAirports](https://ourairports.com/data/) | Public domain |
| Cities | [Natural Earth](https://www.naturalearthdata.com) populated places | Public domain |
| World map outline | Natural Earth 1:50m land | Public domain |
| Geoid | EGM96 (NGA), sampled via `egm96-universal` (MIT) | Public domain |
| Atmosphere & clouds | [@takram/three-atmosphere, three-clouds](https://github.com/takram-design-engineering/three-geospatial) | MIT (cloud noise textures bundled from the npm packages) |
| 3D Tiles streaming | [3d-tiles-renderer](https://github.com/NASA-AMMOS/3DTilesRendererJS) | Apache‑2.0 |
| Scenery | Google / Cesium / Esri / EOX / AWS | Per provider terms (table above); attributions are shown on screen |

`public/clouds/stbn.bin` is generated by `scripts/build_stbn.mjs` (interleaved gradient
noise) as a stand‑in for Takram's blue‑noise volume, which is distributed via Git LFS.
You can drop the original `stbn.bin` in its place.

## Known constraints

* **Google branding:** Google requires its logo alongside Photorealistic 3D Tiles. The app
  shows the “Google” wordmark and the per‑tile data attributions; for distribution, add the
  official logo asset per Google’s attribution guidelines (pass `logoUrl` to
  `GoogleCloudAuthPlugin` in `src/world/providers.ts`).
* **No offline caching** of Google tiles (prohibited by the terms); tiles are held only in
  the in‑memory LRU cache while flying.
* **Open‑data mode** has no 3D buildings, and the ocean surface floods the few land areas
  below sea level (e.g. Dutch polders, the Dead Sea).
* **Volumetric clouds** are GPU‑heavy. On older Macs lower *Scenery detail* (which also
  lowers cloud quality) or turn clouds off in Settings.
* **Weather**: with *Live weather* on (Settings → Weather; needs the Weather API enabled on
  the Google Maps Platform key) cloud cover, haze, rain, snow, wind and turbulence follow
  the Google Weather API report at the aircraft. The report describes surface conditions:
  cloud layers sit at fixed heights, precipitation stops above the low deck, and haze is
  capped so the ground stays visible. Thunderstorms add turbulence but no lightning.
* **Night** (real time, or the Night preset) uses a subtle cool terrain fill, moon-aware
  aircraft lighting, airglow and occluded aircraft lamps. City lights are not simulated.
  Stars retain catalog positions, colors and magnitudes, fade through twilight and dim
  under moonlight. The Moon uses today’s date and aircraft position for its phase,
  tilt, angular size and parallax, with a NASA LRO surface map (see
  [asset attribution](public/atmosphere/README.md)). Manual time keeps today’s date;
  daylight hours therefore follow the season.
* **Aircraft** are original procedural models in the style of each type — not licensed
  replicas of manufacturer designs or liveries.
