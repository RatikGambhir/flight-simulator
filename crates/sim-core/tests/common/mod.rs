//! Shared flight harness for end-to-end autopilot tests (and the
//! `autoflight` example). It plays the renderer's part: it feeds the
//! simulation ground-height samples under the aircraft at 10 Hz and the
//! terrain-ahead profile at 2 Hz, steps the physics at the fixed 120 Hz rate
//! and records what happened.

#![allow(dead_code)]

use sim_core::autopilot::Phase;
use sim_core::geo::{self, FT_TO_M};
use sim_core::protocol::{RunwaySpawnKind, SpawnMode, SpawnRequest, WeatherRequest};
use sim_core::{snap, world, ControlInput, SimCommand, SimEvent, Simulation};

pub const DT: f64 = 1.0 / 120.0;

/// Terrain model: ground height (m above the ellipsoid) at a point.
pub type Terrain = Box<dyn Fn(f64, f64) -> f64>;

/// Flat terrain at the elevations of the airports involved: within 10 km of
/// an airport the ground is at its elevation, in between it blends.
pub fn airport_terrain(idents: &[&str]) -> Terrain {
    let db = world::db();
    let fields: Vec<(f64, f64, f64)> = idents
        .iter()
        .map(|i| {
            let a = db.airport(i).unwrap_or_else(|| panic!("airport {i}"));
            (a.lat, a.lon, a.elevation_ft)
        })
        .collect();
    Box::new(move |lat, lon| {
        let mut wsum = 0.0;
        let mut hsum = 0.0;
        for &(la, lo, ft) in &fields {
            let d = geo::haversine_m(lat.to_radians(), lon.to_radians(), la.to_radians(), lo.to_radians());
            if d < 10_000.0 {
                return world::msl_ft_to_ellipsoid_m(lat, lon, ft);
            }
            let w = 1.0 / (d * d);
            wsum += w;
            hsum += w * ft;
        }
        world::msl_ft_to_ellipsoid_m(lat, lon, hsum / wsum)
    })
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Sample {
    pub t: f64,
    pub lat: f64,
    pub lon: f64,
    pub alt_ft: f64,
    pub agl_ft: f64,
    pub ias: f64,
    pub gs: f64,
    pub vs: f64,
    pub pitch: f64,
    pub roll: f64,
    pub heading: f64,
    pub track: f64,
    pub nz: f64,
    pub throttle: f64,
    pub phase: u32,
    pub on_ground: bool,
    pub ecef: [f64; 3],
}

pub struct Harness {
    pub sim: Simulation,
    pub terrain: Terrain,
    pub t: f64,
    pub events: Vec<(f64, SimEvent)>,
    pub log: Vec<Sample>,
    pub phases: Vec<(f64, Phase)>,
    pub touchdowns: Vec<(f64, f64)>,
    pub crashed: Option<String>,
    pub verbose: bool,
    pub input: ControlInput,
    /// Latest snapshot (refreshed every step and after commands).
    pub last: Vec<f64>,
    /// Record every n-th step in `log` (1 = every 120 Hz step).
    pub log_every: usize,
    /// Largest position change beyond what the velocity explains (m): the
    /// autopilot must fly the aircraft, never move it.
    pub max_jump_m: f64,
    steps: usize,
    /// Optional extra terrain feature for terrain-ahead reports (lat, lon) -> height.
    ground_timer: f64,
    terrain_timer: f64,
    log_timer: f64,
}

impl Harness {
    pub fn new(aircraft: &str, terrain: Terrain) -> Self {
        let mut sim = Simulation::new();
        sim.command(SimCommand::SetAircraft { id: aircraft.into() });
        sim.command(SimCommand::SetWeather(WeatherRequest { wind_from_deg: 270.0, wind_speed_kt: 0.0, turbulence: 0.0 }));
        let mut h = Self {
            sim,
            terrain,
            t: 0.0,
            events: Vec::new(),
            log: Vec::new(),
            phases: Vec::new(),
            touchdowns: Vec::new(),
            crashed: None,
            verbose: std::env::var("AP_TRACE").is_ok(),
            input: ControlInput::default(),
            last: vec![0.0; snap::LEN],
            log_every: 6,
            max_jump_m: 0.0,
            steps: 0,
            ground_timer: 0.0,
            terrain_timer: 0.0,
            log_timer: 0.0,
        };
        h.sim.take_events();
        h.refresh();
        h
    }

    pub fn refresh(&mut self) {
        self.sim.write_snapshot(&mut self.last);
    }

    pub fn weather(&mut self, from_deg: f64, kt: f64, turbulence: f64) {
        self.sim.command(SimCommand::SetWeather(WeatherRequest { wind_from_deg: from_deg, wind_speed_kt: kt, turbulence }));
    }

    pub fn destination(&mut self, ident: &str) {
        self.sim.command(SimCommand::SetDestination { airport: Some(ident.into()), runway: None });
    }

    pub fn spawn_runway(&mut self, airport: &str, runway: &str, kind: RunwaySpawnKind) {
        self.sim.command(SimCommand::SpawnRunway { airport: airport.into(), runway: Some(runway.into()), kind });
        self.settle();
    }

    pub fn spawn_air(&mut self, lat: f64, lon: f64, heading: f64, agl_ft: f64, speed_kt: Option<f64>) {
        let ground_ft = (((self.terrain)(lat, lon)) - world::geoid_undulation(lat, lon)) / FT_TO_M;
        self.sim.command(SimCommand::Spawn(SpawnRequest {
            lat,
            lon,
            heading,
            mode: SpawnMode::Air,
            agl_ft: Some(agl_ft),
            speed_kt,
            ground_elevation_ft: Some(ground_ft),
            keep_autopilot: false,
        }));
        self.settle();
    }

    /// Gives the sim the ground sample it waits for after a spawn.
    pub fn settle(&mut self) {
        self.feed_ground();
        self.collect();
        self.refresh();
    }

    pub fn snap(&self) -> &[f64] {
        &self.last
    }

    pub fn phase(&self) -> Phase {
        Phase::from_code(self.last[snap::AP_PHASE] as u32).unwrap_or(Phase::Off)
    }

    pub fn engaged(&self) -> bool {
        (self.last[snap::FLAGS] as u32) & snap::flags::AP_ENGAGED != 0
    }

    pub fn on_ground(&self) -> bool {
        (self.last[snap::FLAGS] as u32) & snap::flags::ON_GROUND != 0
    }

    pub fn command(&mut self, cmd: SimCommand) {
        self.sim.command(cmd);
        self.collect();
        self.refresh();
    }

    pub fn toggle_ap(&mut self) {
        self.command(SimCommand::ToggleAutopilot);
    }

    fn feed_ground(&mut self) {
        self.refresh();
        let (lat, lon) = (self.last[snap::LAT], self.last[snap::LON]);
        let h = (self.terrain)(lat, lon);
        self.sim.command(SimCommand::Ground { lat, lon, height: Some(h) });
    }

    fn feed_terrain_ahead(&mut self) {
        let s = &self.last;
        let (lat, lon) = (s[snap::LAT].to_radians(), s[snap::LON].to_radians());
        let trk = s[snap::TRACK].to_radians();
        let mut max = f64::MIN;
        for d in [1_000.0, 2_000.0, 3_500.0, 5_000.0, 7_500.0, 10_000.0] {
            let (la, lo) = geo::destination(lat, lon, trk, d);
            max = max.max((self.terrain)(la.to_degrees(), lo.to_degrees()));
        }
        self.sim.command(SimCommand::TerrainAhead { height: Some(max) });
    }

    fn collect(&mut self) {
        for e in self.sim.take_events() {
            if self.verbose {
                eprintln!("[{:7.1}] {:?}", self.t, e);
            }
            match &e {
                SimEvent::Crashed { reason } => self.crashed = Some(reason.clone()),
                SimEvent::Touchdown { vertical_speed_fpm, .. } => self.touchdowns.push((self.t, *vertical_speed_fpm)),
                _ => {}
            }
            self.events.push((self.t, e));
        }
    }

    /// One fixed physics step plus the renderer's periodic reports.
    pub fn step(&mut self) {
        let before = [self.last[snap::ECEF_X], self.last[snap::ECEF_Y], self.last[snap::ECEF_Z]];
        let gen = self.last[snap::GENERATION];
        self.sim.set_input(self.input);
        self.sim.step(DT);
        self.t += DT;
        self.steps += 1;
        self.refresh();
        {
            let s = &self.last;
            let d = ((s[snap::ECEF_X] - before[0]).powi(2) + (s[snap::ECEF_Y] - before[1]).powi(2) + (s[snap::ECEF_Z] - before[2]).powi(2)).sqrt();
            let v = (s[snap::VEL_E].powi(2) + s[snap::VEL_N].powi(2) + s[snap::VEL_U].powi(2)).sqrt();
            let scale = s[snap::TIME_SCALE].max(1.0);
            if s[snap::GENERATION] == gen && (s[snap::FLAGS] as u32) & snap::flags::AWAITING_GROUND == 0 && before[0] != 0.0 {
                // Ground contact may settle the wheels onto the surface by a few centimetres.
                self.max_jump_m = self.max_jump_m.max(d - v * DT * scale);
            }
        }
        self.ground_timer += DT;
        self.terrain_timer += DT;
        self.log_timer += DT;
        if self.ground_timer >= 0.1 {
            self.ground_timer = 0.0;
            self.feed_ground();
        }
        if self.terrain_timer >= 0.5 {
            self.terrain_timer = 0.0;
            self.feed_terrain_ahead();
        }
        let s = self.last.clone();
        let phase = Phase::from_code(s[snap::AP_PHASE] as u32).unwrap_or(Phase::Off);
        if self.phases.last().map(|p| p.1) != Some(phase) {
            self.phases.push((self.t, phase));
        }
        let sample = Sample {
            t: self.t,
            lat: s[snap::LAT],
            lon: s[snap::LON],
            alt_ft: s[snap::ALT_MSL_FT],
            agl_ft: s[snap::AGL_FT],
            ias: s[snap::IAS_KT],
            gs: s[snap::GS_KT],
            vs: s[snap::VS_FPM],
            pitch: s[snap::PITCH],
            roll: s[snap::ROLL],
            heading: s[snap::HEADING],
            track: s[snap::TRACK],
            nz: s[snap::NZ],
            throttle: s[snap::THROTTLE],
            phase: phase.code(),
            on_ground: (s[snap::FLAGS] as u32) & snap::flags::ON_GROUND != 0,
            ecef: [s[snap::ECEF_X], s[snap::ECEF_Y], s[snap::ECEF_Z]],
        };
        if self.steps.is_multiple_of(self.log_every.max(1)) {
            self.log.push(sample);
        }
        let every = std::env::var("AP_TRACE").ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(10.0);
        if self.verbose && self.log_timer >= every {
            self.log_timer = 0.0;
            if let Some(rw) = self.sim.autopilot.runway() {
                let (a, c) = rw.frame(s[snap::LAT], s[snap::LON]);
                eprint!("  rwy {} along {:7.0} cross {:6.1} ", rw.ident, a, c);
            }
            eprintln!(
                "[{:7.1}] {:13} lat {:8.4} lon {:9.4} alt {:6.0} agl {:6.0} ias {:5.1} gs {:5.1} vs {:6.0} pit {:5.1} rol {:5.1} hdg {:5.1} trk {:5.1} thr {:.2} gear {:.1} flp {} spd {:.1} dist {:6.1} apHdg {:5.1} apAlt {:6.0} apSpd {:5.1} apVs {:5.0} lat#{}",
                self.t,
                phase.label(),
                s[snap::LAT],
                s[snap::LON],
                s[snap::ALT_MSL_FT],
                s[snap::AGL_FT],
                s[snap::IAS_KT],
                s[snap::GS_KT],
                s[snap::VS_FPM],
                s[snap::PITCH],
                s[snap::ROLL],
                s[snap::HEADING],
                s[snap::TRACK],
                s[snap::THROTTLE],
                s[snap::GEAR],
                s[snap::FLAPS_INDEX],
                s[snap::SPOILERS],
                s[snap::AP_DIST_NM],
                s[snap::AP_HEADING],
                s[snap::AP_ALT_FT],
                s[snap::AP_SPEED_KT],
                s[snap::AP_VS_FPM],
                s[snap::AP_LATERAL],
            );
        }
        self.collect();
    }

    /// Steps until `done` returns true or `max_s` seconds pass (or a crash). Returns whether `done` fired.
    pub fn run_until(&mut self, max_s: f64, mut done: impl FnMut(&Harness) -> bool) -> bool {
        let end = self.t + max_s;
        while self.t < end {
            self.step();
            if self.crashed.is_some() {
                return false;
            }
            if done(self) {
                return true;
            }
        }
        false
    }

    pub fn run_for(&mut self, secs: f64) {
        let end = self.t + secs;
        while self.t < end && self.crashed.is_none() {
            self.step();
        }
    }

    pub fn messages(&self) -> Vec<String> {
        self.events
            .iter()
            .filter_map(|(_, e)| if let SimEvent::Message { text } = e { Some(text.clone()) } else { None })
            .collect()
    }

    pub fn saw_phase(&self, p: Phase) -> bool {
        self.phases.iter().any(|(_, q)| *q == p)
    }

    pub fn phase_names(&self) -> String {
        self.phases.iter().map(|(t, p)| format!("{:.0}s {}", t, p.label())).collect::<Vec<_>>().join(" → ")
    }

    /// Runway-frame position (along, cross) of the aircraft for a runway end at an airport.
    pub fn runway_position(&self, airport: &str, runway: &str) -> (f64, f64, f64) {
        let db = world::db();
        let a = db.airport(airport).unwrap();
        let (rw, end) = db.runway_end(a, Some(runway)).unwrap();
        let g = sim_core::autopilot::RunwayGeom::new(a, &rw, end);
        let (along, cross) = g.frame(self.last[snap::LAT], self.last[snap::LON]);
        (along, cross, g.length_m)
    }

    /// Largest absolute step-to-step change of a logged quantity over a time window, per second.
    pub fn max_rate(&self, from_t: f64, to_t: f64, f: impl Fn(&Sample) -> f64, wrap: bool) -> f64 {
        let mut max: f64 = 0.0;
        let window: Vec<&Sample> = self.log.iter().filter(|s| s.t >= from_t && s.t <= to_t).collect();
        for w in window.windows(2) {
            let mut d = f(w[1]) - f(w[0]);
            if wrap {
                d = geo::wrap_deg_180(d);
            }
            max = max.max(d.abs() / (w[1].t - w[0].t));
        }
        max
    }

    pub fn range(&self, from_t: f64, to_t: f64, f: impl Fn(&Sample) -> f64) -> (f64, f64) {
        self.log.iter().filter(|s| s.t >= from_t && s.t <= to_t).map(f).fold((f64::MAX, f64::MIN), |(lo, hi), v| (lo.min(v), hi.max(v)))
    }
}
