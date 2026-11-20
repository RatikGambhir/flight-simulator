# Architecture

How the GeoFlight repository is organised, how the simulator works at runtime, and where to find the
code for each piece of behaviour. For what GeoFlight *does*, see the [README](README.md). For setup,
controls and data-provider keys, see [app/README.md](app/README.md).

- [Repository layout](#repository-layout)
- [Simulator (`app/`)](#simulator-app)
  - [Runtime overview](#runtime-overview)
  - [Where the logic lives](#where-the-logic-lives)
  - [Rust: `crates/sim-core`](#rust-cratessim-core)
  - [Hosts: `src-tauri` and `crates/sim-wasm`](#hosts-src-tauri-and-cratessim-wasm)
  - [Frontend: `src/`](#frontend-src)
  - [Subsystems in depth](#subsystems-in-depth)
  - [Contracts and invariants](#contracts-and-invariants)
  - [Build, test and release](#build-test-and-release)
- [Website (`site/`)](#website-site)

---

## Repository layout

The repository holds two independent projects. They share no code, packages or build steps; each has
its own `package.json`, lockfile and `node_modules`.

```
/
├── app/                    GeoFlight simulator (Tauri 2 desktop app)
│   ├── crates/
│   │   ├── sim-core/       Platform-independent Rust simulation (physics, autopilot, world DB)
│   │   └── sim-wasm/       sim-core compiled to WebAssembly for browser development
│   ├── src-tauri/          Native desktop host (sim thread, IPC commands, window, icons)
│   ├── src/                React + Three.js frontend (rendering, UI, input, audio)
│   ├── data/               Bundled datasets compiled into sim-core (airports, runways, places, geoid)
│   ├── public/             Runtime assets served to the web view (clouds, stars, water, Draco, sim.wasm)
│   ├── scripts/            Dataset generators and Node test suites
│   ├── assets/             Source app icon
│   ├── Cargo.toml          Rust workspace (sim-core, sim-wasm, src-tauri)
│   └── package.json        Frontend, Tauri CLI and test scripts
├── site/                   Marketing website (Vite + React + Tailwind + shadcn/ui)
├── .github/workflows/      CI: builds and releases the macOS app from app/
├── package.json            Convenience scripts that delegate to app/ and site/
├── README.md               Product overview
└── ARCHITECTURE.md         This file
```

The only links between the two projects are content, not code: `site/src/content/aircraft.ts` mirrors
the aircraft list in `app/crates/sim-core/src/aircraft.rs`, and the site's photos were captured in the
simulator. If you add an aircraft, update both.

---

## Simulator (`app/`)

All paths in this section are relative to `app/`.

### Runtime overview

GeoFlight splits the work across a native simulation and a web-based renderer. The simulation is
authoritative: it owns position, attitude, velocity, engines, gear, flaps and the autopilot. The
renderer only displays an interpolated copy and reports back what it can see (ground height, terrain
ahead, collisions).

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

**Threads and channels**

| Where | Runs | Talks to |
| --- | --- | --- |
| Rust sim thread (`src-tauri/src/lib.rs`) | `sim-core::Simulation` stepped at a fixed 120 Hz by `stepper.rs` | Streams snapshots as raw little-endian `f64` arrays over a Tauri IPC `Channel` (~60 Hz, no JSON on the hot path); drains an mpsc queue of inputs and commands |
| Tauri command handlers | `sim_subscribe`, `sim_input`, `sim_command`, `world_query` (async) | Post into the sim queue, or answer database searches without blocking the UI |
| Web view main thread | React UI, `FlightLoop` (one Three.js frame per display refresh) | `SimClient` reads snapshots; `controls.ts` posts inputs; `worldSystem.ts` posts ground height and terrain-ahead |
| Web workers | Night-lights atlas decoding (`scene/cityLights.worker.ts`); in browser dev mode, the WASM sim (`sim/sim.worker.ts`) | Same snapshot protocol as the native host |

**One display frame**

1. `SimClient` (`src/sim/simClient.ts`) picks the two snapshots around the render time and
   interpolates position (f64 ECEF) and attitude (quaternion slerp).
2. `FlightLoop` (`src/scene/FlightLoop.tsx`) re-bases the floating origin if the aircraft has moved
   more than 3 km, then converts ECEF to the local scene frame on the CPU in double precision.
3. `aircraftController.ts` places the model and animates control surfaces, gear, engines and lights;
   `cameraRig.ts` positions the active camera.
4. `worldSystem.ts` updates the 3D Tiles layers, probes the ground under the aircraft (10 Hz) and casts
   collision rays, then sends the results to Rust as commands.
5. The post-processing stack renders sky, clouds, aerial perspective, night lighting, tone mapping and
   anti-aliasing. The HUD writes its numbers straight to the DOM from its own rAF loop.

**One physics step (120 Hz, in Rust)**

`stepper.rs` accumulates elapsed time and calls `Simulation::step` a whole number of times. Each step
applies pilot or autopilot inputs through the universal control law, integrates forces in ECEF
(`sim/dynamics.rs`), updates engines and systems, resolves runway or terrain contact against the
latest ground height from the renderer, and raises events (touchdown with rating, liftoff, stall,
crash).

### Where the logic lives

| If you want to change… | Look in |
| --- | --- |
| How an aircraft flies (mass, wing, thrust, speeds, handling, gust limits) | `crates/sim-core/src/aircraft.rs` |
| Forces, ground handling, brakes, reversers, ground effect | `crates/sim-core/src/sim/dynamics.rs`, `sim.rs` |
| Fighter afterburner and transonic drag | `crates/sim-core/src/engine.rs` |
| Wind, turbulence and gust models | `crates/sim-core/src/weather.rs` |
| Atmosphere (ISA density, temperature) | `crates/sim-core/src/atmosphere.rs` |
| Autopilot phases, guidance, runway choice, go-arounds | `crates/sim-core/src/autopilot/` |
| Airport, city and landmark search | `crates/sim-core/src/world.rs`, `world/search.rs`, data in `data/` |
| Messages between Rust and the UI | `crates/sim-core/src/protocol.rs` **and** `src/sim/protocol.ts` |
| Menu actions (start, relocate, restart, destination, weather) | `src/flight.ts` |
| App state and saved settings | `src/state/store.ts` (Zustand) |
| Keyboard, mouse and gamepad mapping | `src/input/controls.ts` |
| Exterior 3D models | `src/aircraft/models.ts`, `src/aircraft/exterior/*`, `src/aircraft/geometry.ts` |
| Liveries and materials | `src/aircraft/liveries.ts`, `src/aircraft/materials.ts` |
| Cockpits and instruments | `src/aircraft/cockpit*.ts`, `src/aircraft/instruments.ts`, `src/aircraft/instruments/*` |
| Cameras | `src/camera/cameraRig.ts` |
| Scenery providers (Google, Cesium, open data) | `src/world/providers.ts` |
| Tile streaming, ground probe, collision rays, prefetch | `src/world/worldSystem.ts`, `src/world/flightPrefetch.ts` |
| Floating origin | `src/world/frame.ts` |
| Clouds | `src/scene/VolumetricCloudPass.ts`, `cloudVolumeShader.ts`, `cloudField.ts`, `cloudGroundLighting.ts`; weather-to-cloud mapping in `src/weather/cloudProfiles.ts` |
| Sun, moon and stars | `src/scene/celestial.ts`, `celestialRendering.ts`, `CelestialSky.tsx` |
| Night lighting | `src/scene/NightEffect.ts`, `cityLights.worker.ts`, `src/aircraft/cockpitLighting.ts` |
| Ocean and lakes | `src/scene/Ocean.ts`, `LakeWater.ts`, `lakeGeometry.ts`, `WaterMask.ts`, `WaterMaterial.ts` |
| Rain and snow | `src/scene/Precipitation.ts` |
| Colour grade and tone | `src/scene/Grade.ts`, exposure and composer setup in `FlightScene.tsx` |
| Live weather | `src/weather/liveWeather.ts` |
| Routes, skip-to and runway alignment | `src/navigation/` |
| HUD, menus and dialogs | `src/ui/` |
| Sound | `src/audio/sound.ts` |
| Window, CSP, bundle settings | `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json` |
| Datasets | `scripts/build_*.{py,mjs}` (see `scripts/README.md`) |

### Rust: `crates/sim-core`

Platform-independent and fully unit tested (`cargo test -p sim-core`). No rendering, no I/O beyond the
datasets compiled in with `include_str!` / `include_bytes!`.

| Module | Responsibility |
| --- | --- |
| `lib.rs` | Crate root and public API |
| `geo.rs` | WGS84 geodesy: geodetic ↔ ECEF, local tangent frames, great-circle helpers (radians unless named `_deg`) |
| `atmosphere.rs` | International Standard Atmosphere up to 20 km |
| `aircraft.rs` | `AircraftSpec` for every type: mass, wing, thrust, speeds, limits, handling and autoland gust limit |
| `sim.rs`, `sim/dynamics.rs` | The `Simulation`: rigid-body translation in f64 ECEF with a universal rate-command control law; one physics substep including systems and runway contact |
| `engine.rs` | Afterburning turbofan thrust and transonic drag for fighter-class aircraft |
| `weather.rs` | Power-law boundary-layer wind and Dryden (MIL-F-8785C) turbulence |
| `stepper.rs` | Fixed-timestep driver at `SIM_HZ = 120`, shared by both hosts |
| `protocol.rs` | Snapshot layout, control inputs, commands and events exchanged with the frontend |
| `world.rs`, `world/search.rs` | Bundled airports/runways (OurAirports), populated places (Natural Earth), landmarks and the EGM96 geoid; ranked search |
| `autopilot/mod.rs` | Flight management and the flight-phase state machine |
| `autopilot/ground.rs` | Taxi, line-up, takeoff roll and landing rollout |
| `autopilot/airborne.rs` | Climb, cruise, descent, approach, flare and go-around guidance |
| `autopilot/control.rs` | Inner loops that turn guidance into the same stick, throttle and rudder demands a pilot makes |
| `autopilot/nav.rs`, `autopilot/route.rs` | Runway frames and selection, path following, approach legs and glidepath |
| `autopilot/perf.rs` | Operating speeds, limits and distances derived from `AircraftSpec` (no per-type code) |

`examples/` holds `trace`, `maneuver` and `autoflight` (fly a whole autopilot flight and print a
trace, or run many approaches and summarise them). `tests/autopilot_e2e.rs` flies complete flights
through the real flight model.

### Hosts: `src-tauri` and `crates/sim-wasm`

- **`src-tauri`** (production). `lib.rs` spawns the sim thread, owns the `SimHandle`, and exposes
  `sim_subscribe` (opens the snapshot channel), `sim_input`, `sim_command` and the async
  `world_query`. `tauri.conf.json` sets the window, the content security policy and the macOS bundle.
- **`crates/sim-wasm`** (browser development only). Dependency-free WASM exports with the same API.
  `npm run build:wasm` compiles it to `public/sim/sim.wasm`, which `src/sim/sim.worker.ts` runs in a
  Web Worker. The production Tauri build strips `dist/sim` (see `vite.config.ts`).

The frontend picks a host through `src/sim/transport.ts`: `TauriTransport` inside the desktop app,
`WorkerTransport` in a plain browser. Everything above the transport is identical.

### Frontend: `src/`

| Directory | Contents |
| --- | --- |
| `main.tsx`, `App.tsx` | Entry point; the heavy 3D scene is lazy-loaded in parallel with the menu so first paint is fast |
| `flight.ts` | High-level flight actions shared by menus and in-flight UI: spawn, relocate, restart, destination and weather commands |
| `state/` | `store.ts`: one Zustand store for screens, selections, camera mode, toasts and persisted settings (`geoflight.settings.v1`, liveries) |
| `sim/` | `transport.ts` (Tauri or WASM worker), `protocol.ts` (TypeScript mirror of `protocol.rs`), `simClient.ts` (snapshot history and interpolation), `autopilotStatus.ts` (pure HUD/PFD text from a snapshot), `sim.worker.ts` |
| `world/` | Floating origin (`frame.ts`): a local East-Up-South frame re-based every 3 km. `providers.ts` configures the 3D Tiles layers; `worldSystem.ts` streams them, probes ground height with BVH-accelerated raycasts (rejecting tiles whose geometric error is too coarse) and casts forward collision rays; `flightPrefetch.ts` runs a coarse, never-rendered view ~12 s ahead along the velocity (600 m to 6 km), off below 25 m/s and outside active flight |
| `scene/` | React Three Fiber scene and post-processing: Takram's precomputed atmospheric scattering (sky, aerial perspective, sun and sky light), custom volumetric clouds and their ground shadows, sun/moon/stars, night lighting, lens flare, AgX tone mapping plus grade, SMAA, dithering, a PMREM sky environment for reflections, animated ocean (open-data mode) and shoreline-clipped, geoid-corrected lakes; `FlightLoop.tsx` is the per-frame driver |
| `aircraft/` | Procedural models (parametric fuselage sections, NACA-airfoil wings with hinged flaps, ailerons and spoilers, lathe-turned nacelles with spinning fans, retractable gear, nav/strobe/beacon lights), painted liveries, cockpit interiors with live PFD/ND/EICAS or six-pack instruments, and a sun-projected ground shadow |
| `camera/` | Exterior, cockpit, wing, free, cinematic and flyby cameras. Exterior cameras trail the aircraft's acceleration on a spring; the pilot's head moves with g-forces and runway rumble |
| `input/` | The universal control scheme: smoothed keyboard axes, mouse camera control and standard-mapping gamepads |
| `navigation/` | Great-circle route sampling, skip-to placement, the runway alignment guide |
| `weather/` | Google Weather API client and the mapping from reported conditions to cloud layers |
| `audio/` | Procedural Web Audio: turbofan or propeller sound from engine RPM, wind with airspeed and drag devices, tyre rumble, touchdowns, gear and flap motors, stall warnings, overspeed, autopilot disconnect and spoken radio-altitude / GPWS callouts; the cockpit muffles outside sound |
| `ui/` | Main menu, aircraft and location pickers, route planner and map, settings, controls help, skip-to dialog, HUD and in-flight chrome |
| `assets/` | Coastline and land outlines for the maps |

### Subsystems in depth

**Flight model.** Forces are integrated in ECEF at 120 Hz: lift from an angle-of-attack lift curve with
flaps, spoilers and a soft stall; parabolic drag with gear, flap and spoiler increments; thrust with
altitude lapse (jets) or a power-limited propeller model; gravity; wheel friction, braking and
nosewheel steering on the ground. Aerodynamics use the air-relative velocity, so wind produces real
crab angles and ground-speed changes. Ground effect adds lift and cuts induced drag within about a
wingspan of the surface. Rotation uses a rate-command law so one control scheme works for every
aircraft: *Assisted* commands load factor and holds path and bank like a fly-by-wire airliner;
*Direct* commands angle of attack around an auto-trimmed point. The sim reports felt g-load in body
axes, which drives the HUD G meter, camera head motion and shake.

**Autopilot.** A flight-phase state machine (takeoff, climb, cruise, descent, approach, final, flare,
rollout, landed, go-around) running inside the physics step. Guidance produces targets; the inner
control loops convert them into stick, throttle, rudder, brake, reverser, gear and flap inputs, so the
autopilot flies the same airplane a pilot does and never moves it directly. Performance numbers come
from `autopilot/perf.rs`, derived from each `AircraftSpec`. The terrain-ahead heights from the
renderer raise its minimum altitude.

**Floating origin.** Earth-scale coordinates do not fit in float32. The scene is a local frame anchored
near the aircraft and re-based every 3 km; ECEF-to-scene conversion happens on the CPU in f64, so the
GPU only sees small numbers. Anything that keeps world-space state across frames (today, the camera
rig's smoothed position and springs) subscribes to `frame.onRebase` and transforms itself.

**Level of detail and memory.** 3d-tiles-renderer refines tiles by screen-space error (the *Scenery
detail* setting sets the target), fades between levels, unloads tiles after a delay and uses a
per-layer cache budget. Photogrammetry uses 160 to 480 MB by quality, plus decoding and rendering
memory. Google tiles are never cached to disk (provider terms).

**Ground and elevation.** The renderer samples the real surface under the aircraft at 10 Hz and sends
it to Rust, so you land on the actual runway, rooftop or mountain in the tiles. Spawns wait until
scenery is loaded before placing the aircraft; the airport database elevation (converted to ellipsoid
height with EGM96) is the fallback. HUD altitudes are true MSL (ellipsoid height minus geoid).

**Clouds.** `VolumetricCloudPass` marches a fixed Earth-space density field (`cloudField.ts`) that drifts
with the wind: a low cumulus/stratus layer shaped by the weather profile, plus middle and high
(cirrus) layers. It renders an HDR premultiplied image that the atmosphere and night passes composite,
using scene depth to sit correctly around the aircraft and terrain, and a separate map that shades the
ground beneath the deck. It keeps no frame history; the *Scenery detail* setting sets its resolution,
step budget and shadow-map size. `?clouds=legacy` in the browser build switches back to the Takram
renderer, patched in `cloudRendering.ts`.

**Rendering budget.** Clouds dominate GPU time; everything else is comparatively cheap. On top of the
quality presets, `FlightScene.tsx` can lower the render resolution automatically while frames run long
(*Adaptive resolution* in Settings).

### Contracts and invariants

- **Protocol sync.** `crates/sim-core/src/protocol.rs` and `src/sim/protocol.ts` describe the same
  snapshot layout and messages. Change both together; `npm run test:autopilot` checks they agree.
- **Coordinates.** Simulation positions are f64 ECEF metres. The scene frame is East-Up-South around the
  floating origin. Model space is x right, y up, z aft (the nose points to -z), with the origin at the
  aircraft's centre of gravity.
- **Angles.** Rust uses radians unless a name ends in `_deg`.
- **The sim owns the aircraft.** The renderer never moves it; it only sends inputs, commands, ground
  height and terrain-ahead. Skip-to and spawns are sim commands.
- **Per-frame values bypass React.** The HUD and world status update the DOM or small stores outside
  the React tree so the 3D scene never re-renders for them.
- **Shader patches do not hot-reload.** After editing cloud shaders, reload the window to see changes.
- **Third-party fixes live at the boundary.** Library workarounds (e.g. `cloudRendering.ts`) wrap the
  library's materials instead of editing `node_modules`.

### Build, test and release

Run these from `app/`:

| Command | What it does |
| --- | --- |
| `npm run app:dev` | Native app with hot reload (Vite on port 1420 + `cargo run`) |
| `npm run dev:web` | Builds the WASM sim, then serves the app in a browser |
| `npm run app:build` | Release `.app` and `.dmg` in `target/release/bundle/` |
| `npm run typecheck` | TypeScript, no emit |
| `cargo test -p sim-core` | Rust unit tests and end-to-end autopilot flights |
| `npm run test:graphics` | Cloud, geometry, lake and prefetch tests (Node) |
| `npm run test:graphics:gpu` | Rendered-pixel checks in WebKit (macOS) |
| `npm run test:navigation`, `test:cockpit`, `test:skip-to`, `test:autopilot` | Node test suites in `scripts/` |

CI (`.github/workflows/build-macos.yml`) runs in `app/` on pushes to `main` that touch `app/`: graphics
tests, Rust tests, a universal (Apple Silicon + Intel) build, and a GitHub Release with the `.dmg`. The
website's download button links to the latest of those releases.

---

## Website (`site/`)

A static Vite + React 19 single page with TypeScript (strict), Tailwind CSS 4, shadcn/ui (Radix, Nova
preset), Lucide icons and Motion. Paths below are relative to `site/`.

```
src/
├── main.tsx, App.tsx    Entry; App composes the sections inside <MotionConfig reducedMotion="user">
├── index.css            Tailwind import, theme tokens (dark-only palette, one warm accent), base styles
├── sections/            One file per page section, top to bottom:
│                        Hero, ExploreWorld, CityShowcase, JoyOfFlying,
│                        ImmersiveExperience, AircraftShowcase, FinalCta
├── components/          SiteNav, SiteFooter, Picture (AVIF + JPEG fallback), Reveal (scroll
│                        entrances), SectionHeading
├── components/ui/       shadcn/ui primitives (button, card, badge, carousel, sheet, tabs, separator)
├── content/             Typed data: images.ts (every photo and its alt text), aircraft.ts
├── lib/                 site.ts (download/repo links, platforms), motion.ts (easing), utils.ts
└── assets/images/       AVIF at 1280 and 2560 px wide, a 1600 px JPEG fallback, aircraft renders
```

**Where to change things**

| To change… | Edit |
| --- | --- |
| Download URL, repository links, supported platforms | `src/lib/site.ts` |
| Copy for a section | That section's file in `src/sections/` |
| Cities in the bento grid | `CITIES` in `src/sections/CityShowcase.tsx` (+ photos in `src/content/images.ts`) |
| Aircraft carousel | `src/content/aircraft.ts` (keep in step with `app/crates/sim-core/src/aircraft.rs`) |
| Colours, radius, fonts | Tokens in `src/index.css` |
| Entrance motion | `src/components/Reveal.tsx`, curve in `src/lib/motion.ts` |

**Conventions**

- Only advertise what the simulator does today, and only link to releases that exist.
- Gameplay images must be real captures from the simulator. The hero is the one exception.
- Animate `transform` and `opacity` only. Scroll-linked effects check `useReducedMotion()`; everything
  else is covered by `MotionConfig reducedMotion="user"`. Hover effects are gated behind
  `@media (hover: hover)`.
- Images declare their dimensions and lazy-load below the fold; the hero loads eagerly.
- Encode AVIF with even pixel dimensions: macOS `sips` silently writes a blank AVIF for odd sizes.

Commands (from `site/`): `npm run dev` (port 5180), `npm run build` (type-check, then `dist/`),
`npm run lint` (oxlint), `npm run preview`.

### Endeavour mission extension

`app/crates/sim-core/src/sim/shuttle.rs` owns the Shuttle mission phases and
inertial orbital integration. Only Endeavour takes this stepping path; airplane
and X-15 dynamics remain in their existing modules. Native and WASM use the
same commands (`spawn_shuttle`, `launch_shuttle`, `separate_shuttle`) and appended
snapshot fields for mission time, staging, ISS ECEF position, inertial speed and
local gravity. The original 64 snapshot indices retain their meanings. The WASM
input ABI adds strafe/vertical RCS axes after the original six axes.

`SpaceScene.tsx` owns the globe, assisted launch platform, ISS and mission camera.
Both flight scenes use `useWorld.ts` and `WorldSystem` for real terrain, imagery,
provider errors and attribution. Shuttle snapshots identify Houston, Kennedy,
Tanegashima or Sriharikota and the pad's ellipsoid height; stationary ground
samples refine the stack and ascent origin together. The launch view uses the
ordinary flight pipeline's sun and sky lights, lighting mask and aerial
perspective (with `stabilizeAerialPerspective`), so streamed scenery is lit and
hazed exactly as in normal flight. The ISS and pad are forward-lit (masked)
objects that only receive haze; the globe outputs graded albedo plus procedural
clouds and is lit by the same pass as the tiles, so the 120 km hand-over matches,
with city lights added afterwards by an additive overlay. The globe stays 1 km
inset until the tiles are hidden (ocean tiles lie below the ellipsoid and would
otherwise fight it for depth). Exposure eases from the flight value of 10 to
about half by 220 km, like an orbital camera exposing for the sunlit planet.
The lens flare only takes ghosts from the sun (threshold 200), not the exhaust.
Performance: the launch light set never changes (the firelight stays at zero
intensity, far pad meshes hide but its floodlights stay) and the exhaust shaders
are compiled against a linear render target at load, so liftoff compiles no
programs. The globe's cloud field is baked once into a 4096x2048 R8 map.
`WorldSystem` is released above 140 km, freeing the tile cache, and recreated
below 120 km. Smoke keeps a live-index list and reuses last frame's draw order
(insertion sort, no per-frame allocation); `npm run bench:launch` measures it.
Aircraft ground-shadow silhouettes are rendered on first `attachShadow` and kept
as a resolved, depth-less 1024² texture. `launchEffects.ts` draws the
exhaust in a composer pass after aerial perspective (so it is never relit as
terrain), reading the composer's stable log depth for occlusion and soft edges:
shader plumes on anchors in the Endeavour model, a sorted, sun-lit smoke column
and pad exhaust cloud anchored in ECEF and deflected along the flame trench,
firelight, bloom and launch camera shake. Cinematic and Flyby become long-lens
site and pad tracking cameras during the ascent. Tile updates stop and groups hide above
120 km; the coarse globe sits below local terrain until it reaches its exact
WGS84 size at that altitude. The scene shares the floating origin, aircraft
controller, inputs and celestial sky, without atmospheric collision probes.
All tile resources and pointer listeners end when switching flight scenes.

`land_shuttle` validates a long paved runway, skips re-entry and uses the shared
approach placement and autopilot. It clears orbital mission state and publishes
Shuttle phase 6, which `useShuttlePhase` observes through snapshot subscriptions.
The renderer swaps to the ordinary streamed-terrain flight scene; standard flight
dynamics, weather, ground probing, landing gear contact, flare and rollout take
over. The landing assist is deliberately fictional; orbital dynamics stay isolated.
