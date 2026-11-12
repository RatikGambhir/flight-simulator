//! The flight simulation: rigid-body translation in ECEF with a simplified,
//! universal control law. Positions are f64 ECEF meters, attitude is a
//! body->ECEF quaternion with body axes x forward, y left, z up.
//!
//! Control philosophy (see README "Flight model"):
//! * **Assisted** (default): stick commands load factor like a fly-by-wire
//!   airliner; neutral stick holds the flight path, bank is held, turns are
//!   automatically coordinated and the wing is protected from stalling.
//! * **Direct**: stick commands angle of attack around an auto-trimmed point,
//!   with natural stability; stalls are possible.

use glam::{DMat3, DQuat, DVec3};

use crate::aircraft::{self, AircraftSpec, EngineKind};
use crate::atmosphere::{isa, G0, RHO_SL};
use crate::autopilot::{ApInputs, ApOutput, Autopilot, NavTarget};
use crate::engine;
use crate::geo::{self, ecef_to_geodetic, geodetic_to_ecef, EnuFrame, FT_TO_M, KT_TO_MS, MS_TO_KT, M_TO_FT};
pub use crate::autopilot::nav::nosewheel_limit;
use crate::protocol::{snap, ControlInput, RunwaySpawnKind, SimCommand, SimEvent, SpawnMode, SpawnRequest};
use crate::weather::{Weather, WeatherSettings};
use crate::world;

const MS_TO_FPM: f64 = M_TO_FT * 60.0;
/// How far the aircraft may move from the last ground sample before it is considered stale.
const GROUND_SAMPLE_RANGE_M: f64 = 1_500.0;

#[inline]
fn smoothstep(x: f64) -> f64 {
    let t = x.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[inline]
fn approach(current: f64, target: f64, max_step: f64) -> f64 {
    if (target - current).abs() <= max_step { target } else { current + max_step.copysign(target - current) }
}

/// Builds a body->ECEF attitude from heading/pitch/roll (radians) at a location.
pub fn attitude_from_hpr(enu: &EnuFrame, heading: f64, pitch: f64, roll: f64) -> DQuat {
    let (sh, ch) = heading.sin_cos();
    let (sp, cp) = pitch.sin_cos();
    let fwd = DVec3::new(sh * cp, ch * cp, sp);
    let right0 = DVec3::new(ch, -sh, 0.0);
    let up0 = right0.cross(fwd);
    let (sr, cr) = roll.sin_cos();
    let right = right0 * cr - up0 * sr;
    let up = up0 * cr + right0 * sr;
    let local = DMat3::from_cols(fwd, -right, up);
    DQuat::from_mat3(&(enu.to_ecef_matrix() * local)).normalize()
}

/// Heading, pitch, roll (radians) of a body->ECEF attitude at a location.
pub fn hpr_from_attitude(enu: &EnuFrame, att: DQuat) -> (f64, f64, f64) {
    let f = enu.to_local(att * DVec3::X);
    let l = enu.to_local(att * DVec3::Y);
    let u = enu.to_local(att * DVec3::Z);
    let heading = f.x.atan2(f.y);
    let pitch = f.z.clamp(-1.0, 1.0).asin();
    let roll = l.z.atan2(u.z);
    (heading, pitch, roll)
}

#[derive(Debug, Clone, Copy, Default)]
struct Derived {
    lat: f64,
    lon: f64,
    height: f64,
    geoid: f64,
    heading: f64,
    pitch: f64,
    roll: f64,
    /// True airspeed (relative to the moving air mass), m/s.
    tas: f64,
    ias_kt: f64,
    gs: f64,
    vs: f64,
    mach: f64,
    alpha: f64,
    g_load: f64,
    agl: f64,
    track: f64,
    fpa: f64,
    vel_enu: DVec3,
    wind_enu: DVec3,
    ground_height: f64,
}

#[derive(Debug, Clone, Copy)]
struct GroundSample {
    lat: f64,
    lon: f64,
    height: f64,
}

/// Highest terrain ahead reported by the renderer, and where/when.
#[derive(Debug, Clone, Copy)]
struct TerrainAhead {
    height: f64,
    lat: f64,
    lon: f64,
    time: f64,
}

#[derive(Debug, Clone, Copy)]
struct AwaitGround {
    deadline: f64,
    mode: SpawnMode,
    /// For air spawns: desired height above the sampled ground (m).
    agl_m: f64,
    /// For air spawns placed relative to a known field elevation: keep the
    /// height unless terrain turns out to be higher.
    absolute: bool,
}

pub struct Simulation {
    spec: &'static AircraftSpec,
    aircraft_index: usize,

    pos: DVec3,
    vel: DVec3,
    att: DQuat,
    omega: DVec3,

    lever: f64,
    engine: f64,
    gear: f64,
    gear_cmd_down: bool,
    flaps_index: usize,
    flaps: f64,
    spoilers: f64,
    spoilers_cmd: bool,
    parking_brake: bool,
    surfaces: DVec3,
    /// Thrust reverser deployment 0..1.
    reverser: f64,
    input: ControlInput,
    assist: bool,
    alpha_trim: f64,
    /// Flight path angle captured when the pitch stick returns to neutral (assisted mode).
    gamma_ref: Option<f64>,
    /// Bank angle captured when the roll stick returns to neutral (aerobatic assisted mode).
    bank_ref: Option<f64>,
    pub autopilot: Autopilot,
    /// The autopilot's demands for the current step (merged with the pilot's inputs).
    ap_out: ApOutput,
    /// Re-engage the autopilot once a relocation finishes (skip-to).
    ap_resume: bool,
    terrain_ahead: Option<TerrainAhead>,
    weather: Weather,
    /// Low-passed specific force in body axes (x fwd, y left, z up), in g.
    spec_force: DVec3,
    /// Ground-effect strength 0..1 from the last step.
    ground_effect: f64,

    on_ground: bool,
    crashed: bool,
    paused: bool,
    stall: bool,
    tailstrike: bool,
    awaiting: Option<AwaitGround>,
    ground: Option<GroundSample>,
    ground_fallback: f64,

    time: f64,
    time_scale: f64,
    last_touchdown_fpm: f64,
    generation: u32,
    last_spawn: Option<SimCommand>,
    events: Vec<SimEvent>,
    d: Derived,
}

impl Default for Simulation {
    fn default() -> Self {
        Self::new()
    }
}

impl Simulation {
    pub fn new() -> Self {
        let spec = aircraft::default_aircraft();
        let mut sim = Self {
            spec,
            aircraft_index: 0,
            pos: DVec3::ZERO,
            vel: DVec3::ZERO,
            att: DQuat::IDENTITY,
            omega: DVec3::ZERO,
            lever: 0.0,
            engine: 0.0,
            gear: 1.0,
            gear_cmd_down: true,
            flaps_index: 0,
            flaps: 0.0,
            spoilers: 0.0,
            spoilers_cmd: false,
            parking_brake: false,
            surfaces: DVec3::ZERO,
            reverser: 0.0,
            input: ControlInput::default(),
            assist: true,
            alpha_trim: 0.04,
            gamma_ref: None,
            bank_ref: None,
            autopilot: Autopilot::default(),
            ap_out: ApOutput::default(),
            ap_resume: false,
            terrain_ahead: None,
            weather: Weather::default(),
            spec_force: DVec3::Z,
            ground_effect: 0.0,
            on_ground: true,
            crashed: false,
            paused: false,
            stall: false,
            tailstrike: false,
            awaiting: None,
            ground: None,
            ground_fallback: 0.0,
            time: 0.0,
            time_scale: 1.0,
            last_touchdown_fpm: 0.0,
            generation: 0,
            last_spawn: None,
            events: Vec::new(),
            d: Derived::default(),
        };
        sim.command(SimCommand::SpawnRunway { airport: "KORD".into(), runway: Some("28R".into()), kind: RunwaySpawnKind::Takeoff });
        sim
    }

    pub fn spec(&self) -> &'static AircraftSpec {
        self.spec
    }

    pub fn set_input(&mut self, input: ControlInput) {
        let c = |v: f64, lo: f64| if v.is_finite() { v.clamp(lo, 1.0) } else { 0.0 };
        self.input = ControlInput {
            pitch: c(input.pitch, -1.0),
            roll: c(input.roll, -1.0),
            yaw: c(input.yaw, -1.0),
            throttle_rate: c(input.throttle_rate, -1.0),
            brake: c(input.brake, 0.0),
            reverse: c(input.reverse, 0.0),
        };
    }

    /// Drains pending UI events.
    pub fn take_events(&mut self) -> Vec<SimEvent> {
        self.drain_autopilot();
        std::mem::take(&mut self.events)
    }

    /// Moves autopilot announcements into the event queue.
    fn drain_autopilot(&mut self) {
        for text in self.autopilot.take_messages() {
            self.events.push(SimEvent::Message { text });
        }
        if let Some((airport, runway)) = self.autopilot.take_runway_event() {
            self.events.push(SimEvent::ApRunway { airport, runway });
        }
    }

    /// Ground height the simulation is currently using under the aircraft (m above the ellipsoid).
    pub fn ground_height(&self) -> f64 {
        self.d.ground_height
    }

    fn message(&mut self, text: impl Into<String>) {
        self.events.push(SimEvent::Message { text: text.into() });
    }

    // -----------------------------------------------------------------------
    // Commands
    // -----------------------------------------------------------------------

    pub fn command(&mut self, cmd: SimCommand) {
        match cmd {
            SimCommand::Spawn(req) => {
                self.last_spawn = Some(SimCommand::Spawn(req.clone()));
                self.spawn(&req);
            }
            SimCommand::SpawnRunway { ref airport, ref runway, kind } => {
                if self.spawn_runway(airport, runway.as_deref(), kind) {
                    self.last_spawn = Some(cmd);
                } else {
                    self.message(format!("Unknown airport or runway: {airport}"));
                }
            }
            SimCommand::Reset => {
                if let Some(c) = self.last_spawn.clone() {
                    self.command(c);
                }
            }
            SimCommand::SetAircraft { id } => {
                if let Some(idx) = aircraft::catalog().iter().position(|a| a.id == id) {
                    self.aircraft_index = idx;
                    self.spec = &aircraft::catalog()[idx];
                    self.flaps_index = self.flaps_index.min(self.spec.flap_detents.len() - 1);
                    if let Some(c) = self.last_spawn.clone() {
                        self.command(c);
                    }
                }
            }
            SimCommand::SetPaused { paused } => self.paused = paused,
            SimCommand::TogglePause => self.paused = !self.paused,
            SimCommand::SetThrottle { value } => {
                if value.is_finite() {
                    self.lever = value.clamp(0.0, 1.0);
                    self.autopilot.manual_throttle();
                }
            }
            SimCommand::ToggleGear => {
                if !self.spec.retractable_gear {
                    self.message("Fixed landing gear");
                } else if self.on_ground && self.gear_cmd_down {
                    self.message("Gear lever locked on the ground");
                } else {
                    self.gear_cmd_down = !self.gear_cmd_down;
                }
            }
            SimCommand::FlapsUp | SimCommand::FlapsDown | SimCommand::SetFlaps { .. } if self.spec.auto_flaps => {
                self.message("Flaps are automatic: they extend with the landing gear");
            }
            SimCommand::FlapsUp => self.flaps_index = self.flaps_index.saturating_sub(1),
            SimCommand::FlapsDown => self.flaps_index = (self.flaps_index + 1).min(self.spec.flap_detents.len() - 1),
            SimCommand::SetFlaps { index } => self.flaps_index = index.min(self.spec.flap_detents.len() - 1),
            SimCommand::ToggleSpoilers => {
                if self.spec.spoiler_cd > 0.0 {
                    self.spoilers_cmd = !self.spoilers_cmd;
                } else {
                    self.message("No speed brakes on this aircraft");
                }
            }
            SimCommand::ToggleParkingBrake => self.parking_brake = !self.parking_brake,
            SimCommand::SetAssist { enabled } => self.assist = enabled,
            SimCommand::ToggleAutopilot => {
                if self.autopilot.engaged {
                    self.autopilot.disengage(Some("Autopilot disengaged"));
                } else {
                    self.engage_autopilot();
                }
            }
            SimCommand::Autopilot(c) => {
                match c.engaged {
                    Some(true) if !self.autopilot.engaged => self.engage_autopilot(),
                    Some(false) => self.autopilot.disengage(Some("Autopilot disengaged")),
                    _ => {}
                }
                self.autopilot.apply(&c, self.spec);
            }
            SimCommand::SetDestination { airport, runway } => {
                let target = airport.as_deref().and_then(|id| NavTarget::lookup(id, runway.clone()));
                if let (Some(id), None) = (&airport, &target) {
                    self.message(format!("Unknown destination airport: {id}"));
                }
                let inp = self.ap_inputs();
                self.autopilot.set_destination(target, &inp, self.spec);
            }
            SimCommand::TerrainAhead { height } => {
                self.terrain_ahead =
                    height.filter(|h| h.is_finite()).map(|height| TerrainAhead { height, lat: self.d.lat, lon: self.d.lon, time: self.time });
            }
            SimCommand::Ground { lat, lon, height } => self.ground_sample(lat, lon, height),
            SimCommand::Collision { what } => {
                if !self.crashed && !self.on_ground && self.awaiting.is_none() && self.d.tas > 20.0 {
                    self.crashed = true;
                    self.vel = DVec3::ZERO;
                    self.omega = DVec3::ZERO;
                    self.autopilot.disengage(None);
                    self.events.push(SimEvent::Crashed { reason: format!("Collided with {what}") });
                }
            }
            SimCommand::SetTimeScale { scale } => {
                if scale.is_finite() {
                    self.time_scale = scale.clamp(0.25, 8.0);
                }
            }
            SimCommand::SetWeather(w) => self.weather.set(WeatherSettings {
                wind_from_deg: w.wind_from_deg,
                wind_speed_ms: w.wind_speed_kt * KT_TO_MS,
                turbulence: w.turbulence,
            }),
        }
        self.drain_autopilot();
    }

    fn engage_autopilot(&mut self) {
        if self.crashed {
            self.message("Autopilot unavailable after a crash");
        } else if self.awaiting.is_some() {
            self.message("Autopilot is available once the aircraft is placed");
        } else {
            let inp = self.ap_inputs();
            self.autopilot.engage(&inp, self.spec);
        }
    }

    fn ground_sample(&mut self, lat: f64, lon: f64, height: Option<f64>) {
        let Some(h) = height.filter(|h| h.is_finite()) else { return };
        let dist = geo::haversine_m(lat.to_radians(), lon.to_radians(), self.d.lat.to_radians(), self.d.lon.to_radians());
        if dist > GROUND_SAMPLE_RANGE_M {
            return;
        }
        self.ground = Some(GroundSample { lat, lon, height: h });
        if let Some(aw) = self.awaiting {
            self.finish_await(aw, h);
        }
    }

    fn finish_await(&mut self, aw: AwaitGround, ground_h: f64) {
        let g = ecef_to_geodetic(self.pos);
        let target = match aw.mode {
            SpawnMode::Ground => ground_h + self.spec.gear_height_m,
            SpawnMode::Air if aw.absolute => g.height.max(ground_h + 150.0),
            SpawnMode::Air => ground_h + aw.agl_m,
        };
        self.pos = geodetic_to_ecef(g.lat, g.lon, target);
        self.awaiting = None;
        self.update_derived();
        if std::mem::take(&mut self.ap_resume) {
            self.engage_autopilot();
        }
    }

    fn reset_dynamic_state(&mut self) {
        self.omega = DVec3::ZERO;
        self.crashed = false;
        self.stall = false;
        self.tailstrike = false;
        self.spoilers_cmd = false;
        self.spoilers = 0.0;
        self.parking_brake = false;
        self.surfaces = DVec3::ZERO;
        self.reverser = 0.0;
        self.spec_force = DVec3::Z;
        self.weather.reset_gusts();
        self.autopilot.reset();
        self.ap_out = ApOutput::default();
        self.ap_resume = false;
        self.terrain_ahead = None;
        self.gamma_ref = None;
        self.bank_ref = None;
        self.ground = None;
        self.generation = self.generation.wrapping_add(1);
        self.events.push(SimEvent::Spawned { generation: self.generation });
    }

    /// Trimmed angle of attack and throttle lever for steady flight.
    fn trim(&self, tas: f64, gamma: f64, height_msl: f64) -> (f64, f64) {
        let s = self.spec;
        let air = isa(height_msl);
        let q = 0.5 * air.density * tas * tas;
        let w = s.mass_kg * G0;
        let cl = w * gamma.cos() / (q * s.wing_area_m2).max(1.0);
        let alpha = (cl - s.cl0 - s.flap_cl * self.flaps) / s.cl_alpha;
        let cd = s.cd0 + s.induced_k() * cl * cl + s.flap_cd * self.flaps + s.gear_cd * self.gear;
        let mach = tas / air.speed_of_sound;
        let cd = cd + engine::wave_drag(s.wave_drag_cd, s.drag_rise_mach, mach);
        let t_req = q * s.wing_area_m2 * cd + w * gamma.sin();
        // Thrust rises monotonically with the lever, so bisect for the setting.
        let thrust = |lever: f64| self.thrust_at(lever, tas, air.density, mach, height_msl);
        let (mut lo, mut hi) = (0.0, 1.0);
        if thrust(hi) <= t_req {
            lo = 1.0;
        } else if thrust(lo) < t_req {
            for _ in 0..40 {
                let mid = 0.5 * (lo + hi);
                if thrust(mid) < t_req { lo = mid } else { hi = mid }
            }
        }
        (alpha.clamp(-0.05, 0.2), lo)
    }

    /// Total thrust (N) for an engine state 0..1 at an altitude (m MSL) and Mach number.
    fn thrust_at(&self, engine: f64, tas: f64, rho: f64, mach: f64, alt_msl: f64) -> f64 {
        let s = self.spec;
        if s.afterburner_thrust_n > 0.0 {
            return engine::afterburning_thrust(s.max_thrust_n, s.afterburner_thrust_n, s.idle_thrust, s.afterburner_detent, engine, alt_msl, mach);
        }
        let frac = s.idle_thrust + (1.0 - s.idle_thrust) * engine;
        let sigma = rho / RHO_SL;
        match s.engine {
            EngineKind::Jet => s.max_thrust_n * frac * sigma.powf(0.75) * (1.0 - 0.22 * mach.min(1.0)),
            EngineKind::Propeller => frac * s.max_thrust_n.min(s.prop_power_w / tas.max(1.0)) * sigma,
        }
    }

    /// Afterburner stage 0..1 for the current engine state (0 when not lit).
    fn afterburner_stage(&self) -> f64 {
        let d = self.spec.afterburner_detent;
        if self.spec.afterburner_thrust_n <= 0.0 || self.engine <= d || self.reverser > 0.0 {
            return 0.0;
        }
        ((self.engine - d) / (1.0 - d)).clamp(0.0, 1.0)
    }

    #[allow(clippy::too_many_arguments)]
    fn place(&mut self, lat_deg: f64, lon_deg: f64, height: f64, heading_deg: f64, mode: SpawnMode, ias_kt: f64, gamma: f64) {
        let lat = lat_deg.to_radians();
        let lon = lon_deg.to_radians();
        let enu = EnuFrame::at(lat, lon);
        let hdg = heading_deg.to_radians();
        self.pos = geodetic_to_ecef(lat, lon, height);
        self.reset_dynamic_state();
        match mode {
            SpawnMode::Ground => {
                self.vel = DVec3::ZERO;
                self.att = attitude_from_hpr(&enu, hdg, self.spec.rest_pitch_deg.to_radians(), 0.0);
                self.on_ground = true;
                self.gear_cmd_down = true;
                self.gear = 1.0;
                self.lever = 0.0;
                self.engine = 0.0;
                // Jets whose idle thrust would roll them away (fighters) start
                // holding the brakes, as their pilots do.
                let idle = self.thrust_at(0.0, 0.0, RHO_SL, 0.0, 0.0);
                self.parking_brake = idle > 0.02 * self.spec.mass_kg * G0;
            }
            SpawnMode::Air => {
                let msl = height - world::geoid_undulation(lat_deg, lon_deg);
                let rho = isa(msl).density;
                let tas = ias_kt * KT_TO_MS / (rho / RHO_SL).sqrt();
                // `heading` and `gamma` describe the path over the ground (e.g. an ILS
                // glideslope). Find the air-relative path that produces it in this wind:
                // crab into the crosswind and steepen/shallow for head/tailwind.
                let agl = (height - self.ground_fallback).max(0.0);
                let wind = self.weather.wind_enu(agl);
                let (sh, ch) = hdg.sin_cos();
                let w_along = wind.x * sh + wind.y * ch;
                let w_cross = wind.x * ch - wind.y * sh;
                let mut gamma_air = gamma;
                for _ in 0..4 {
                    gamma_air = (gamma.tan() * (gamma_air.cos() + w_along / tas)).clamp(-0.5, 0.5).asin();
                }
                let crab = -(w_cross / (tas * gamma_air.cos())).clamp(-0.5, 0.5).asin();
                let hdg_air = hdg + crab;
                let (alpha, lever) = self.trim(tas, gamma_air, msl);
                self.alpha_trim = alpha;
                let dir = enu.to_ecef(DVec3::new(hdg_air.sin() * gamma_air.cos(), hdg_air.cos() * gamma_air.cos(), gamma_air.sin()));
                // Fly with the air mass: ground velocity = air velocity + wind.
                self.vel = dir * tas + enu.to_ecef(wind);
                self.att = attitude_from_hpr(&enu, hdg_air, gamma_air + alpha, 0.0);
                self.on_ground = false;
                self.lever = lever;
                self.engine = lever;
            }
        }
        self.update_derived();
    }

    fn spawn(&mut self, req: &SpawnRequest) {
        let resume = req.keep_autopilot && self.autopilot.engaged;
        self.autopilot.set_spawn_target(None);
        let lat = req.lat.clamp(-89.9, 89.9);
        let lon = geo::wrap_deg_180(req.lon);
        let fallback = match req.ground_elevation_ft {
            Some(ft) => world::msl_ft_to_ellipsoid_m(lat, lon, ft),
            None => world::geoid_undulation(lat, lon),
        };
        self.ground_fallback = fallback;
        let s = self.spec;
        match req.mode {
            SpawnMode::Ground => {
                self.flaps_index = s.takeoff_flaps();
                self.flaps = self.flaps_index as f64 / (s.flap_detents.len() - 1) as f64;
                self.place(lat, lon, fallback + s.gear_height_m, req.heading, SpawnMode::Ground, 0.0, 0.0);
                self.awaiting = Some(AwaitGround { deadline: self.time + 15.0, mode: SpawnMode::Ground, agl_m: 0.0, absolute: false });
            }
            SpawnMode::Air => {
                let agl_m = req.agl_ft.unwrap_or(3000.0).max(200.0) * FT_TO_M;
                let ias = req.speed_kt.unwrap_or(s.v_cruise_kt.min(250.0) * 0.85).max(s.v_approach_kt);
                self.flaps_index = 0;
                self.flaps = 0.0;
                self.gear_cmd_down = !s.retractable_gear;
                self.gear = if s.retractable_gear { 0.0 } else { 1.0 };
                self.place(lat, lon, fallback + agl_m, req.heading, SpawnMode::Air, ias, 0.0);
                self.gear_cmd_down = !s.retractable_gear;
                self.gear = if s.retractable_gear { 0.0 } else { 1.0 };
                self.awaiting = Some(AwaitGround { deadline: self.time + 8.0, mode: SpawnMode::Air, agl_m, absolute: false });
            }
        }
        self.ap_resume = resume;
    }

    fn spawn_runway(&mut self, ident: &str, runway: Option<&str>, kind: RunwaySpawnKind) -> bool {
        let db = world::db();
        let Some(ap) = db.airport(ident) else { return false };
        let Some((rw, i)) = db.runway_end(ap, runway) else { return false };
        let end = &rw.ends[i];
        let elev_ft = end.elevation_ft.unwrap_or(ap.elevation_ft);
        let field_h = world::msl_ft_to_ellipsoid_m(end.lat, end.lon, elev_ft);
        self.ground_fallback = field_h;
        let hdg = end.heading_deg;
        let s = self.spec;
        let (lat, lon) = (end.lat.to_radians(), end.lon.to_radians());
        let approach_target = match kind {
            RunwaySpawnKind::Approach => NavTarget::lookup(&ap.ident, Some(end.ident.clone())),
            RunwaySpawnKind::Takeoff => None,
        };
        match kind {
            RunwaySpawnKind::Takeoff => {
                let (la, lo) = geo::destination(lat, lon, hdg.to_radians(), 30.0);
                self.flaps_index = s.takeoff_flaps();
                self.flaps = self.flaps_index as f64 / (s.flap_detents.len() - 1) as f64;
                self.place(la.to_degrees(), lo.to_degrees(), field_h + s.gear_height_m, hdg, SpawnMode::Ground, 0.0, 0.0);
                self.awaiting = Some(AwaitGround { deadline: self.time + 15.0, mode: SpawnMode::Ground, agl_m: 0.0, absolute: false });
                self.message(format!("{} runway {} — ready for takeoff", ap.ident, end.ident));
            }
            RunwaySpawnKind::Approach => {
                let dist = 6.0 * 1852.0;
                let aim = end.displaced_threshold_ft * FT_TO_M + 300.0;
                let (ta, to) = geo::destination(lat, lon, hdg.to_radians(), aim);
                let (la, lo) = geo::destination(ta, to, (hdg + 180.0).to_radians(), dist);
                let gamma = -3f64.to_radians();
                let h = field_h + dist * 3f64.to_radians().tan() + s.gear_height_m;
                self.flaps_index = s.flap_detents.len() - 1;
                self.flaps = 1.0;
                self.gear_cmd_down = true;
                self.gear = 1.0;
                self.place(la.to_degrees(), lo.to_degrees(), h, hdg, SpawnMode::Air, s.v_approach_kt, gamma);
                self.gear_cmd_down = true;
                self.gear = 1.0;
                self.awaiting = Some(AwaitGround { deadline: self.time + 8.0, mode: SpawnMode::Air, agl_m: 0.0, absolute: true });
                self.message(format!("Final approach, {} runway {} — 6 nm", ap.ident, end.ident));
            }
        }
        self.autopilot.set_spawn_target(approach_target);
        true
    }

    // -----------------------------------------------------------------------
    // Stepping
    // -----------------------------------------------------------------------

    /// Advances the simulation by `dt` seconds of wall time.
    pub fn step(&mut self, dt: f64) {
        self.time += dt;
        if let Some(aw) = self.awaiting {
            if self.time >= aw.deadline {
                let h = self.ground_fallback;
                self.finish_await(aw, h);
                self.message("Scenery elevation unavailable — using database elevation");
            } else {
                return;
            }
        }
        if self.paused || self.crashed {
            return;
        }
        let total = dt * self.time_scale;
        let n = self.time_scale.ceil().max(1.0) as usize;
        let v0 = self.vel;
        for i in 0..n {
            self.integrate(total / n as f64);
            if self.crashed {
                break;
            }
            // Fresh flight values for the autopilot and air mass on the next sub-step.
            if i + 1 < n {
                self.update_derived();
            }
        }
        self.update_derived();
        self.update_specific_force(v0, total);
        self.drain_autopilot();
    }

    /// Specific force (what an accelerometer / the pilot's inner ear feels) in body axes.
    fn update_specific_force(&mut self, v0: DVec3, dt: f64) {
        if self.crashed || dt <= 0.0 {
            return;
        }
        let up = geo::EnuFrame::at(self.d.lat.to_radians(), self.d.lon.to_radians()).up;
        let f = (self.vel - v0) / dt + up * G0;
        let body = self.att.conjugate() * f / G0;
        // Light smoothing removes single-step spikes from ground snapping.
        let k = (dt / 0.05).min(1.0);
        self.spec_force += (body - self.spec_force) * k;
    }

    fn ground_height_at(&self, lat_deg: f64, lon_deg: f64) -> f64 {
        match self.ground {
            Some(g)
                if geo::haversine_m(g.lat.to_radians(), g.lon.to_radians(), lat_deg.to_radians(), lon_deg.to_radians())
                    < GROUND_SAMPLE_RANGE_M =>
            {
                g.height
            }
            // Stale or missing sample: fall back to mean sea level (never higher
            // than the last known ground), which avoids false collisions.
            Some(g) => world::geoid_undulation(lat_deg, lon_deg).min(g.height),
            None => self.ground_fallback,
        }
    }

    fn contact_height(&self) -> f64 {
        if self.gear > 0.95 { self.spec.gear_height_m } else { self.spec.belly_height_m }
    }

    /// Terrain-ahead report if it is recent and from near here.
    fn terrain_ahead_height(&self) -> Option<f64> {
        let t = self.terrain_ahead?;
        let fresh = self.time - t.time < 4.0;
        let near = geo::haversine_m(t.lat.to_radians(), t.lon.to_radians(), self.d.lat.to_radians(), self.d.lon.to_radians()) < 3_000.0;
        (fresh && near).then_some(t.height)
    }

    fn ap_inputs(&self) -> ApInputs {
        let s = self.spec;
        let d = &self.d;
        let air = isa(d.height - d.geoid);
        let q = 0.5 * air.density * d.tas * d.tas;
        let contact = self.contact_height();
        ApInputs {
            lat: d.lat,
            lon: d.lon,
            height: d.height,
            geoid: d.geoid,
            contact_h: contact,
            ground_h: d.ground_height,
            terrain_ahead: self.terrain_ahead_height(),
            alt_msl_ft: (d.height - d.geoid - contact) * M_TO_FT,
            agl_ft: d.agl.max(0.0) * M_TO_FT,
            heading: d.heading.to_degrees().rem_euclid(360.0),
            track: d.track.to_degrees().rem_euclid(360.0),
            pitch_deg: d.pitch.to_degrees(),
            roll_deg: d.roll.to_degrees(),
            alpha_deg: d.alpha.to_degrees(),
            ias_kt: d.ias_kt,
            tas_ms: d.tas,
            gs_ms: d.gs,
            speed_ms: d.vel_enu.length(),
            vs_fpm: d.vs * MS_TO_FPM,
            gamma: d.fpa,
            sigma: air.density / RHO_SL,
            speed_of_sound: air.speed_of_sound,
            roll_rate_max: s.max_roll_rate.to_radians(),
            pitch_rate_max: s.max_pitch_rate.to_radians(),
            control_eff: (q / s.full_authority_q).clamp(0.05, 1.0),
            on_ground: self.on_ground,
            gear: self.gear,
            gear_down_cmd: self.gear_cmd_down,
            flaps_index: self.flaps_index,
            speedbrake_cmd: self.spoilers_cmd,
            lever: self.lever,
            reverser: self.reverser,
            parking_brake: self.parking_brake,
            wind_from_deg: self.weather.settings.wind_from_deg,
            wind_kt: self.weather.settings.wind_speed_ms * MS_TO_KT,
            turbulence: self.weather.settings.turbulence,
            nz: self.spec_force.z,
            gust_ms: self.weather.gust_intensity(10.0),
        }
    }

    /// Applies the autopilot's configuration requests through the same rules
    /// as the pilot's controls.
    fn apply_autopilot_config(&mut self, ap: &ApOutput) {
        let s = self.spec;
        if let Some(down) = ap.gear_down {
            if s.retractable_gear && (down || !self.on_ground) {
                self.gear_cmd_down = down;
            }
        }
        if let Some(i) = ap.flaps_index {
            if !s.auto_flaps {
                self.flaps_index = i.min(s.flap_detents.len() - 1);
            }
        }
        if let Some(b) = ap.speedbrake {
            if s.spoiler_cd > 0.0 {
                self.spoilers_cmd = b;
            }
        }
        if let Some(b) = ap.parking_brake {
            self.parking_brake = b;
        }
    }

    /// Wheel brake in use: the parking brake, the pilot's pedals or the autobrake.
    fn wheel_brake(&self) -> f64 {
        if self.parking_brake { 1.0 } else { self.input.brake.max(self.ap_out.brake.unwrap_or(0.0)) }
    }

    fn update_systems(&mut self, dt: f64, ap_throttle: Option<f64>) {
        let s = self.spec;
        match ap_throttle {
            // The autothrottle works in the dry range; afterburner is the pilot's call.
            Some(t) if s.afterburner_detent > 0.0 => self.lever = t.min(s.afterburner_detent),
            Some(t) => self.lever = t,
            None => self.lever = (self.lever + self.input.throttle_rate * 0.6 * dt).clamp(0.0, 1.0),
        }
        // Thrust reversers (jets): deploy on the ground with the levers at idle while
        // reverse is held; the engines only spool up once the sleeves are open, and
        // the sleeves only stow once the engines are back near idle.
        let reverse = self.ap_out.reverse.unwrap_or(self.input.reverse);
        let want_rev = s.engine == EngineKind::Jet && s.thrust_reversers && self.on_ground && reverse > 0.5 && self.lever < 0.05;
        let rev_target = if want_rev {
            1.0
        } else if self.engine > 0.12 {
            // Hold the sleeves where they are until the engines spool down.
            self.reverser
        } else {
            0.0
        };
        self.reverser = approach(self.reverser, rev_target, dt / 1.6);
        let n1_target = if want_rev && self.reverser > 0.95 {
            0.72
        } else if self.reverser > 0.0 {
            0.0
        } else {
            self.lever
        };
        // Turbofans accelerate slowly from idle and quickly near the top of the range.
        let spool_tau = (s.spool_time_s / 3.0).max(0.05);
        let tau = if n1_target > self.engine { spool_tau * (1.5 - self.engine) } else { spool_tau * 0.8 };
        self.engine += (n1_target - self.engine) * (dt / tau).min(1.0);

        if s.retractable_gear {
            self.gear = approach(self.gear, if self.gear_cmd_down { 1.0 } else { 0.0 }, dt / 6.0);
        } else {
            self.gear = 1.0;
        }
        if s.auto_flaps {
            self.flaps_index = if self.gear_cmd_down { s.flap_detents.len() - 1 } else { 0 };
        }
        let flap_target = self.flaps_index as f64 / (s.flap_detents.len() - 1).max(1) as f64;
        // Fighter flaperons are fast-acting hydraulic surfaces.
        self.flaps = approach(self.flaps, flap_target, dt * if s.auto_flaps { 0.5 } else { 0.12 });

        let ground_spoilers = self.on_ground && self.lever < 0.08 && self.d.gs > 30.0 * KT_TO_MS && s.spoiler_cd > 0.0;
        let sp_target = if self.spoilers_cmd || ground_spoilers { 1.0 } else { 0.0 };
        self.spoilers = approach(self.spoilers, sp_target, dt * 1.5);
    }

    fn integrate(&mut self, dt: f64) {
        let s = self.spec;
        let geo0 = ecef_to_geodetic(self.pos);
        let enu = EnuFrame::at(geo0.lat, geo0.lon);
        let up = enu.up;
        let geoid = world::geoid_undulation(geo0.lat_deg(), geo0.lon_deg());
        let air = isa(geo0.height - geoid);
        let rho = air.density;
        let mass = s.mass_kg;
        let area = s.wing_area_m2;

        // ---- Air mass ----------------------------------------------------
        // Aerodynamics see the velocity relative to the (moving, gusty) air.
        let h_above_ground = (geo0.height - self.ground_height_at(geo0.lat_deg(), geo0.lon_deg())).max(0.0);
        self.weather.step(dt, self.d.tas, h_above_ground, s.wingspan_m);
        let wind = enu.to_ecef(self.weather.wind_enu(h_above_ground));
        let v = self.vel - wind;
        let speed = v.length();
        let (xb, yb, zb) = (self.att * DVec3::X, self.att * DVec3::Y, self.att * DVec3::Z);
        let vb = self.att.conjugate() * v;
        let (alpha, beta) = if speed > 0.5 { ((-vb.z).atan2(vb.x), (vb.y / speed).clamp(-1.0, 1.0)) } else { (0.0, 0.0) };
        let qbar = 0.5 * rho * speed * speed;
        let eff = (qbar / s.full_authority_q).clamp(0.0, 1.0);
        let mach = speed / air.speed_of_sound;
        let (_heading, pitch, roll) = hpr_from_attitude(&enu, self.att);
        let airborne = !self.on_ground;

        // ---- Autopilot ---------------------------------------------------
        // The autopilot reads the same flight values a pilot sees and makes the
        // same demands (stick, throttle, brakes, steering, gear, flaps).
        if let Some(why) = self.autopilot.pilot_override(&self.input, self.on_ground) {
            self.autopilot.disengage(Some(why));
        }
        let ap_inp = self.ap_inputs();
        let ap = self.autopilot.update(&ap_inp, s, dt);
        self.apply_autopilot_config(&ap);
        self.ap_out = ap;
        self.update_systems(dt, ap.throttle);

        // Control surfaces follow inputs with a short lag (also drives animation).
        let roll_in = ap.roll_stick.unwrap_or(self.input.roll);
        let pitch_in = ap.pitch_stick.unwrap_or(self.input.pitch);
        let target = DVec3::new(roll_in, pitch_in, self.input.yaw);
        self.surfaces += (target - self.surfaces) * (dt * 7.0).min(1.0);

        // ---- Aerodynamics ------------------------------------------------
        let flap = self.flaps;
        let spoil = self.spoilers;
        // Ground effect (McCormick): within about one span of the surface the
        // wingtip vortices are suppressed, cutting induced drag and adding lift.
        let wing_h = (h_above_ground - self.contact_height() * 0.6).max(0.05);
        let r = 16.0 * wing_h / s.wingspan_m;
        let phi = (r * r) / (1.0 + r * r);
        self.ground_effect = 1.0 - phi;
        let cl_alpha = s.cl_alpha * (1.0 + 0.12 * self.ground_effect);
        let alpha_stall = s.alpha_stall_deg.to_radians() - flap * 2f64.to_radians();
        let cl_base = s.cl0 + s.flap_cl * flap + s.spoiler_cl * spoil;
        let cl_lin = |a: f64| cl_base + cl_alpha * a;
        let (cl, post_stall) = if alpha > alpha_stall {
            let x = (alpha - alpha_stall) / 0.15;
            (cl_lin(alpha_stall) * (1.0 - 0.45 * smoothstep(x)), alpha - alpha_stall)
        } else if alpha < -alpha_stall {
            let x = (-alpha - alpha_stall) / 0.15;
            (cl_lin(-alpha_stall) * (1.0 - 0.45 * smoothstep(x)), -alpha - alpha_stall)
        } else {
            (cl_lin(alpha), 0.0)
        };
        let k_induced = if s.wave_drag_cd > 0.0 { s.induced_k() * engine::induced_drag_factor(mach) } else { s.induced_k() };
        let cd = s.cd0
            + engine::wave_drag(s.wave_drag_cd, s.drag_rise_mach, mach)
            + k_induced * phi * cl * cl
            + s.gear_cd * self.gear
            + s.flap_cd * flap
            + s.spoiler_cd * spoil
            + post_stall * 1.2;
        let vhat = if speed > 0.5 { v / speed } else { xb };
        let lift_dir = vhat.cross(yb).try_normalize().unwrap_or(zb);
        let mut force = (lift_dir * cl - vhat * cd) * (qbar * area);
        force -= yb * (beta * qbar * area * 0.9);
        // Reversers redirect the fan stream forward (about 45 % of forward thrust).
        let thrust = self.thrust_at(self.engine, speed, rho, mach, geo0.height - geoid) * (1.0 - 1.45 * self.reverser);
        force += xb * thrust;
        let accel_aero = force / mass;
        let accel = accel_aero - up * G0;

        let was_stalled = self.stall;
        self.stall = airborne && speed > 15.0 && alpha > alpha_stall;
        if self.stall && !was_stalled {
            self.events.push(SimEvent::Stall);
        }

        // ---- Control law: desired body rates ---------------------------
        let p_max = s.max_roll_rate.to_radians();
        let q_max = s.max_pitch_rate.to_radians();
        let r_max = s.max_yaw_rate.to_radians();
        let tau = s.response_time_s;
        let assisted = self.assist || self.autopilot.engaged;
        let q_path = if speed > 5.0 { accel.dot(lift_dir) / speed } else { 0.0 };
        let flying_speed = speed > 0.55 * s.v_rotate_kt * KT_TO_MS;

        // Roll
        let mut p_des = self.surfaces.x * p_max * eff;
        // Full-envelope fly-by-wire (fighters): the stick commands roll rate and
        // neutral stick holds whatever bank the pilot left, upright or inverted.
        if assisted && airborne && !self.autopilot.engaged && !s.aerobatic {
            let bank_hold = 35f64.to_radians();
            let bank_max = 67f64.to_radians();
            if self.input.roll.abs() < 0.05 {
                if roll.abs() > bank_hold {
                    p_des = -(roll - bank_hold.copysign(roll)) * 0.6;
                } else if roll.abs() < 4f64.to_radians() {
                    p_des = -roll * 0.5;
                }
            }
            if roll > bank_max && p_des > 0.0 || roll < -bank_max && p_des < 0.0 {
                p_des = -(roll - bank_max.copysign(roll)) * 2.0;
            }
        }
        if assisted && airborne && !self.autopilot.engaged && s.aerobatic {
            // Attitude hold: with the stick centred, keep the bank the pilot set
            // (including inverted). Bank is meaningless near the vertical, so the
            // hold only engages once the nose is within 60° of the horizon.
            if self.input.roll.abs() >= 0.05 || pitch.abs() > 60f64.to_radians() {
                self.bank_ref = None;
            } else if self.bank_ref.is_none() && self.surfaces.x.abs() < 0.05 && self.omega.x.abs() < 0.35 {
                self.bank_ref = Some(roll);
            }
            if let Some(br) = self.bank_ref {
                let err = (roll - br + std::f64::consts::PI).rem_euclid(std::f64::consts::TAU) - std::f64::consts::PI;
                p_des = (-err * 1.5).clamp(-0.5, 0.5);
            }
        } else {
            self.bank_ref = None;
        }
        if !assisted && airborne {
            // Dihedral effect: sideslip toward the low wing rolls the aircraft level.
            p_des += -beta * 1.5 * eff;
        }
        if self.stall && !assisted {
            p_des += (self.time * 2.3).sin() * 0.25;
        }

        // Pitch
        let q_des = if airborne && flying_speed {
            // Path hold uses the inertial flight path so gusts don't drag the reference around.
            let gamma = self.vel.try_normalize().map_or(0.0, |vi| vi.dot(up).clamp(-1.0, 1.0).asin());
            if assisted {
                // Load factor that holds the flight path at this bank: 1/cos(bank).
                // Airliners stay within ±67° of bank; aerobatic aircraft may be
                // inverted (negative g holds the path) and fade to zero g through
                // knife-edge, where the wing cannot hold the path at all.
                let bank_gain = if s.aerobatic {
                    let c = roll.cos();
                    c / (c * c).max(0.35 * 0.35)
                } else {
                    1.0 / roll.cos().max(0.35)
                };
                let stick = self.surfaces.y;
                let stick_active = self.input.pitch.abs() >= 0.05;
                // Flight-path hold: remember the path angle when the stick is released.
                if stick_active || ap.load_factor.is_some() {
                    self.gamma_ref = None;
                } else if self.gamma_ref.is_none() && stick.abs() < 0.05 {
                    self.gamma_ref = Some(gamma);
                }
                let mut n_neutral = gamma.cos() * bank_gain;
                if let Some(gr) = self.gamma_ref {
                    let corr = ((gr - gamma) * speed / G0 * 0.35).clamp(-0.3, 0.3);
                    n_neutral += if s.aerobatic { corr * bank_gain.clamp(-1.5, 1.5) } else { corr };
                }
                let n_neutral = n_neutral.clamp(s.min_load_factor, s.max_load_factor);
                let n_cmd = match ap.load_factor {
                    Some(n) if !stick_active => n,
                    _ => {
                        if stick >= 0.0 {
                            n_neutral + stick * (s.max_load_factor - n_neutral).max(0.0)
                        } else {
                            n_neutral + stick * (n_neutral - s.min_load_factor).max(0.0)
                        }
                    }
                };
                // Lift needed, net of the thrust component normal to the flight path.
                let lift_needed = n_cmd * mass * G0 - thrust * alpha.sin();
                let cl_needed = lift_needed / (qbar * area).max(1.0);
                let alpha_min = if s.aerobatic { -12f64 } else { -6f64 }.to_radians();
                let alpha_cmd = ((cl_needed - cl_base) / s.cl_alpha).clamp(alpha_min, alpha_stall - 3f64.to_radians());
                self.alpha_trim = alpha;
                (q_path + (alpha_cmd - alpha) * (1.6 / tau)).clamp(-q_max * 1.5, q_max * 1.5)
            } else {
                // Auto-trim slowly toward the angle of attack the pilot is holding.
                let st = self.surfaces.y;
                if st.abs() > 0.05 {
                    self.alpha_trim += (alpha - self.alpha_trim) * (dt * 0.15).min(1.0);
                }
                let alpha_cmd = if st >= 0.0 {
                    self.alpha_trim + st * (alpha_stall + 4f64.to_radians() - self.alpha_trim)
                } else {
                    self.alpha_trim + st * (self.alpha_trim + 8f64.to_radians())
                };
                let mut q = q_path * 0.9 + (alpha_cmd - alpha) * (1.2 / tau) * eff.max(0.3);
                if self.stall {
                    q -= post_stall * 3.0;
                }
                q.clamp(-q_max * 1.5, q_max * 1.5)
            }
        } else if airborne {
            self.surfaces.y * q_max * eff + q_path * 0.8
        } else {
            // On the ground: elevator authority vs. weight on the nose gear.
            let lift_ratio = ((accel_aero.dot(up)) / G0).clamp(0.0, 1.0);
            let settle = -(pitch - s.rest_pitch_deg.to_radians()) * 0.8 * (1.0 - lift_ratio) * (1.0 - self.surfaces.y.abs());
            self.surfaces.y * q_max * eff * 1.4 + settle
        };

        // Yaw: rudder + weathervane stability + automatic turn coordination.
        let mut r_des = self.surfaces.z * r_max * eff - beta * 2.5 * eff.max(0.2);
        if assisted && airborne && speed > 20.0 {
            if s.aerobatic {
                // Cancel the sideways pull of gravity at any attitude.
                r_des += G0 * roll.sin() * pitch.cos() / speed;
            } else {
                let turn_rate = G0 * roll.clamp(-1.3, 1.3).tan() / speed;
                r_des += turn_rate * roll.cos();
            }
        }

        let omega_des = DVec3::new(p_des, -q_des, -r_des);
        self.omega += (omega_des - self.omega) * (dt / tau).min(1.0);
        if airborne {
            // Rotational gusts nudge the airframe; the control law then works against them.
            let g = self.weather.rotational_gust();
            self.omega += DVec3::new(g.x, -g.y, -g.z) * (dt / tau).min(1.0);
        }

        // ---- Integrate ---------------------------------------------------
        self.vel += accel * dt;
        self.pos += self.vel * dt;
        self.att = (self.att * DQuat::from_scaled_axis(self.omega * dt)).normalize();

        self.resolve_ground(dt, accel, mass);
    }

    fn resolve_ground(&mut self, dt: f64, accel: DVec3, mass: f64) {
        let s = self.spec;
        let g = ecef_to_geodetic(self.pos);
        let enu = EnuFrame::at(g.lat, g.lon);
        let up = enu.up;
        let ground_h = self.ground_height_at(g.lat_deg(), g.lon_deg());
        let contact_h = self.contact_height();
        let clearance = g.height - ground_h - contact_h;
        let v_up = self.vel.dot(up);
        let speed = self.vel.length();

        // While rolling on the ground and the wings are not yet carrying the
        // weight, follow the terrain down (e.g. when streamed scenery refines
        // to a slightly lower surface) instead of dropping onto it.
        let lift_ratio = (accel.dot(up) + G0) / G0;
        let sticky = self.on_ground && lift_ratio < 0.95 && v_up < 1.0;
        let touching = clearance <= 0.0 || (self.on_ground && clearance < 0.5 && v_up < 1.0) || (sticky && clearance < 60.0);
        if !touching {
            if self.on_ground && clearance > 0.3 {
                self.on_ground = false;
                self.events.push(SimEvent::Liftoff);
            }
            return;
        }

        let (heading, pitch, roll) = hpr_from_attitude(&enu, self.att);
        if !self.on_ground {
            let fpm = v_up * MS_TO_FPM;
            let crash_reason = if clearance < -12.0 && speed > 15.0 {
                Some("Collided with terrain or a structure")
            } else if v_up < -7.6 {
                Some("Impact was too hard")
            } else if roll.abs() > 25f64.to_radians() {
                Some("Wingtip struck the ground")
            } else if pitch < -10f64.to_radians() {
                Some("Nose-first impact")
            } else if self.gear < 0.95 && v_up < -3.0 {
                Some("Gear-up impact")
            } else {
                None
            };
            if let Some(reason) = crash_reason {
                self.crashed = true;
                self.vel = DVec3::ZERO;
                self.omega = DVec3::ZERO;
                self.pos += up * (-clearance.max(-50.0));
                self.autopilot.disengage(None);
                self.events.push(SimEvent::Crashed { reason: reason.into() });
                return;
            }
            self.last_touchdown_fpm = fpm;
            let rating = match -fpm {
                x if x < 120.0 => "Butter!",
                x if x < 300.0 => "Smooth",
                x if x < 600.0 => "Firm",
                _ => "Hard",
            };
            self.events.push(SimEvent::Touchdown { vertical_speed_fpm: fpm, rating: rating.into() });
            if self.gear < 0.95 {
                self.message("Belly landing!");
            }
            self.autopilot.on_touchdown();
        }
        self.on_ground = true;

        // Snap to the surface and remove downward velocity.
        self.pos += up * (-clearance);
        if v_up < 0.0 {
            self.vel -= up * v_up;
        }

        // Wheel / belly friction.
        let normal_acc = (-(accel.dot(up))).max(0.0);
        let normal_force = mass * normal_acc;
        let xb = self.att * DVec3::X;
        let fwd_h = (xb - up * xb.dot(up)).try_normalize().unwrap_or(enu.north);
        let side_h = up.cross(fwd_h);
        let vh = self.vel - up * self.vel.dot(up);
        let mut vf = vh.dot(fwd_h);
        let mut vs = vh.dot(side_h);
        if self.gear > 0.95 {
            let brake = self.wheel_brake();
            // Rolling resistance plus anti-skid braking (max ~0.4 g on a dry runway).
            let mu = 0.015 + 0.42 * brake;
            vf = approach(vf, 0.0, mu * normal_force / mass * dt);
            vs *= (-dt * 10.0).exp();
        } else {
            let decel = 0.45 * normal_force / mass * dt;
            vf = approach(vf, 0.0, decel);
            vs = approach(vs, 0.0, decel);
        }
        self.vel = fwd_h * vf + side_h * vs + up * self.vel.dot(up).max(0.0);

        // Steering, wheels-level roll and pitch limits.
        let steer_in = match self.ap_out.steer {
            Some(steer) => steer,
            None if self.input.yaw.abs() > 0.05 => self.input.yaw,
            None => self.input.roll * 0.6,
        };
        let max_steer = nosewheel_limit(vf);
        let steer_rate = if self.gear > 0.95 { vf * (steer_in * max_steer).tan() / s.wheelbase_m } else { 0.0 };
        let new_heading = heading + steer_rate * dt;
        let new_roll = roll * (-dt * 8.0).exp();
        let rest = s.rest_pitch_deg.to_radians();
        let strike = s.tailstrike_pitch_deg.to_radians();
        self.tailstrike = pitch > strike;
        let new_pitch = pitch.clamp(rest.min(pitch.max(rest - 0.02)), strike);
        let new_pitch = new_pitch.max(rest);
        self.att = attitude_from_hpr(&enu, new_heading, new_pitch, new_roll);
        self.omega.x = 0.0;
        self.omega.z = -steer_rate;
        if new_pitch <= rest && self.omega.y > 0.0 {
            self.omega.y = 0.0;
        }
    }

    fn update_derived(&mut self) {
        let g = ecef_to_geodetic(self.pos);
        let enu = EnuFrame::at(g.lat, g.lon);
        let (heading, pitch, roll) = hpr_from_attitude(&enu, self.att);
        let geoid = world::geoid_undulation(g.lat_deg(), g.lon_deg());
        let air = isa(g.height - geoid);
        let vel_enu = enu.to_local(self.vel);
        let gs = (vel_enu.x * vel_enu.x + vel_enu.y * vel_enu.y).sqrt();
        let ground_h = self.ground_height_at(g.lat_deg(), g.lon_deg());
        let wind_enu = self.weather.wind_enu((g.height - ground_h).max(0.0));
        let air_vel = self.vel - enu.to_ecef(wind_enu);
        let tas = air_vel.length();
        let vb = self.att.conjugate() * air_vel;
        let alpha = if tas > 1.0 { (-vb.z).atan2(vb.x) } else { 0.0 };
        let g_load = self.spec_force.z.clamp(-6.0, 12.0);
        self.d = Derived {
            lat: g.lat_deg(),
            lon: g.lon_deg(),
            height: g.height,
            geoid,
            heading,
            pitch,
            roll,
            tas,
            ias_kt: tas * (air.density / RHO_SL).sqrt() * MS_TO_KT,
            gs,
            vs: vel_enu.z,
            mach: tas / air.speed_of_sound,
            alpha,
            g_load,
            agl: g.height - ground_h - self.contact_height(),
            track: vel_enu.x.atan2(vel_enu.y),
            fpa: {
                let v = vel_enu.length();
                if v > 1.0 { (vel_enu.z / v).clamp(-1.0, 1.0).asin() } else { 0.0 }
            },
            vel_enu,
            wind_enu,
            ground_height: ground_h,
        };
    }

    /// Writes the current state into `out` (length [`snap::LEN`]).
    pub fn write_snapshot(&self, out: &mut [f64]) {
        use snap::*;
        let d = &self.d;
        let s = self.spec;
        out[TIME] = self.time;
        out[ECEF_X] = self.pos.x;
        out[ECEF_Y] = self.pos.y;
        out[ECEF_Z] = self.pos.z;
        out[QX] = self.att.x;
        out[QY] = self.att.y;
        out[QZ] = self.att.z;
        out[QW] = self.att.w;
        out[LAT] = d.lat;
        out[LON] = d.lon;
        out[HEIGHT] = d.height;
        out[ALT_MSL_FT] = (d.height - d.geoid - self.contact_height()) * M_TO_FT;
        out[AGL_FT] = d.agl.max(0.0) * M_TO_FT;
        out[HEADING] = geo::wrap_deg_360(d.heading.to_degrees());
        out[PITCH] = d.pitch.to_degrees();
        out[ROLL] = d.roll.to_degrees();
        out[IAS_KT] = d.ias_kt;
        out[TAS_KT] = d.tas * MS_TO_KT;
        out[GS_KT] = d.gs * MS_TO_KT;
        out[VS_FPM] = d.vs * MS_TO_FPM;
        out[MACH] = d.mach;
        out[THROTTLE] = self.lever;
        out[ENGINE] = self.engine;
        out[GEAR] = self.gear;
        out[FLAPS] = self.flaps;
        out[FLAPS_INDEX] = self.flaps_index as f64;
        out[SPOILERS] = self.spoilers;
        out[BRAKE] = self.wheel_brake();
        out[ALPHA] = d.alpha.to_degrees();
        out[G_LOAD] = d.g_load;
        let mut f = 0u32;
        if self.on_ground { f |= flags::ON_GROUND; }
        if self.paused { f |= flags::PAUSED; }
        if self.crashed { f |= flags::CRASHED; }
        if self.stall { f |= flags::STALL; }
        if self.awaiting.is_some() { f |= flags::AWAITING_GROUND; }
        if self.parking_brake { f |= flags::PARKING_BRAKE; }
        if self.assist { f |= flags::ASSIST; }
        if self.autopilot.engaged { f |= flags::AP_ENGAGED; }
        if d.ias_kt > s.v_max_kt { f |= flags::OVERSPEED; }
        if self.tailstrike { f |= flags::TAILSTRIKE; }
        out[FLAGS] = f as f64;
        out[AILERON] = self.surfaces.x;
        out[ELEVATOR] = self.surfaces.y;
        out[RUDDER] = self.surfaces.z;
        let ap = &self.autopilot;
        out[AP_HEADING] = ap.target_heading;
        out[AP_ALT_FT] = ap.target_altitude_ft;
        out[AP_SPEED_KT] = ap.target_speed_kt;
        out[AP_VS_FPM] = ap.vertical_speed_fpm;
        let mut m = 0u32;
        if ap.heading_hold { m |= ap_modes::HEADING; }
        if ap.altitude_hold { m |= ap_modes::ALTITUDE; }
        if ap.autothrottle { m |= ap_modes::AUTOTHROTTLE; }
        if ap.is_managed() { m |= ap_modes::MANAGED; }
        out[AP_MODES] = m as f64;
        out[AIRCRAFT_INDEX] = self.aircraft_index as f64;
        out[TOUCHDOWN_FPM] = self.last_touchdown_fpm;
        out[GROUND_HEIGHT] = d.ground_height;
        out[TRACK] = geo::wrap_deg_360(d.track.to_degrees());
        out[GENERATION] = self.generation as f64;
        out[FPA] = d.fpa.to_degrees();
        out[VEL_E] = d.vel_enu.x;
        out[VEL_N] = d.vel_enu.y;
        out[VEL_U] = d.vel_enu.z;
        out[TIME_SCALE] = self.time_scale;
        out[NX] = self.spec_force.x;
        out[NY] = -self.spec_force.y;
        out[NZ] = self.spec_force.z;
        out[WIND_E] = d.wind_enu.x;
        out[WIND_N] = d.wind_enu.y;
        out[WIND_U] = d.wind_enu.z;
        out[REVERSER] = self.reverser;
        out[GROUND_EFFECT] = self.ground_effect;
        out[AFTERBURNER] = self.afterburner_stage();
        out[AP_PHASE] = if ap.engaged { ap.phase.code() as f64 } else { 0.0 };
        out[AP_LATERAL] = if ap.engaged { ap.lateral as u8 as f64 } else { 0.0 };
        out[AP_DIST_NM] = ap.dist_to_go_nm.unwrap_or(-1.0);
    }

    pub fn snapshot(&self) -> Vec<f64> {
        let mut v = vec![0.0; snap::LEN];
        self.write_snapshot(&mut v);
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(sim: &Simulation, idx: usize) -> f64 {
        sim.snapshot()[idx]
    }

    fn settle(sim: &mut Simulation) {
        // Provide the ground sample the renderer would normally send.
        let s = sim.snapshot();
        let h = sim.ground_fallback;
        sim.command(SimCommand::Ground { lat: s[snap::LAT], lon: s[snap::LON], height: Some(h) });
    }

    #[test]
    fn hpr_roundtrip() {
        let enu = EnuFrame::at(0.6, -1.2);
        for &(h, p, r) in &[(0.3, 0.1, -0.2), (3.0, -0.4, 0.9), (-1.5, 0.0, 0.0)] {
            let q = attitude_from_hpr(&enu, h, p, r);
            let (h2, p2, r2) = hpr_from_attitude(&enu, q);
            assert!((geo::wrap_deg_180((h2 - h).to_degrees())).abs() < 1e-6);
            assert!((p2 - p).abs() < 1e-9 && (r2 - r).abs() < 1e-9);
        }
    }

    #[test]
    fn takeoff_roll_and_climb_737() {
        let mut sim = Simulation::new();
        settle(&mut sim);
        assert_eq!(read(&sim, snap::FLAGS) as u32 & snap::flags::AWAITING_GROUND, 0);
        sim.command(SimCommand::SetThrottle { value: 1.0 });
        let dt = 1.0 / 120.0;
        let mut rotated_at = None;
        for i in 0..(120 * 90) {
            let ias = read(&sim, snap::IAS_KT);
            let mut input = ControlInput::default();
            if ias > sim.spec().v_rotate_kt {
                rotated_at.get_or_insert(i);
                input.pitch = if read(&sim, snap::PITCH) < 12.0 { 0.6 } else { 0.0 };
            }
            sim.set_input(input);
            sim.step(dt);
            let lat = read(&sim, snap::LAT);
            let lon = read(&sim, snap::LON);
            let h = sim.ground_fallback;
            sim.command(SimCommand::Ground { lat, lon, height: Some(h) });
        }
        let flags = read(&sim, snap::FLAGS) as u32;
        assert_eq!(flags & snap::flags::CRASHED, 0, "crashed");
        assert_eq!(flags & snap::flags::ON_GROUND, 0, "never lifted off");
        let agl = read(&sim, snap::AGL_FT);
        assert!(agl > 1500.0, "agl after 90 s = {agl}");
        let rot_s = rotated_at.unwrap() as f64 / 120.0;
        assert!((20.0..60.0).contains(&rot_s), "rotate at {rot_s}s");
    }

    #[test]
    fn cruise_is_stable_hands_off() {
        for ac in ["b737", "a320", "bizjet", "longitude", "c172", "f16"] {
            let mut sim = Simulation::new();
            sim.command(SimCommand::SetAircraft { id: ac.into() });
            sim.command(SimCommand::Spawn(SpawnRequest {
                lat: 41.88,
                lon: -87.63,
                heading: 90.0,
                mode: SpawnMode::Air,
                agl_ft: Some(5000.0),
                speed_kt: None,
                ground_elevation_ft: Some(600.0),
                keep_autopilot: false,
            }));
            settle(&mut sim);
            let alt0 = read(&sim, snap::ALT_MSL_FT);
            for _ in 0..(120 * 60) {
                sim.step(1.0 / 120.0);
            }
            let alt1 = read(&sim, snap::ALT_MSL_FT);
            let roll = read(&sim, snap::ROLL);
            let hdg = read(&sim, snap::HEADING);
            assert!((alt1 - alt0).abs() < 600.0, "{ac}: alt drift {alt0} -> {alt1}");
            assert!(roll.abs() < 2.0, "{ac}: roll {roll}");
            assert!((hdg - 90.0).abs() < 5.0, "{ac}: hdg {hdg}");
        }
    }

    #[test]
    fn autopilot_turns_and_climbs() {
        let mut sim = Simulation::new();
        sim.command(SimCommand::Spawn(SpawnRequest {
            lat: 41.88,
            lon: -87.63,
            heading: 0.0,
            mode: SpawnMode::Air,
            agl_ft: Some(6000.0),
            speed_kt: Some(250.0),
            ground_elevation_ft: Some(600.0),
            keep_autopilot: false,
        }));
        settle(&mut sim);
        sim.step(0.1);
        sim.command(SimCommand::ToggleAutopilot);
        sim.command(SimCommand::Autopilot(crate::protocol::AutopilotCommand {
            heading: Some(90.0),
            altitude_ft: Some(9000.0),
            ..Default::default()
        }));
        for _ in 0..(120 * 180) {
            sim.step(1.0 / 120.0);
        }
        let hdg = read(&sim, snap::HEADING);
        let alt = read(&sim, snap::ALT_MSL_FT);
        let ias = read(&sim, snap::IAS_KT);
        assert!((hdg - 90.0).abs() < 3.0, "hdg {hdg}");
        assert!((alt - 9000.0).abs() < 150.0, "alt {alt}");
        assert!((ias - 250.0).abs() < 15.0, "ias {ias}");
    }

    #[test]
    fn approach_spawn_and_landing() {
        let mut sim = Simulation::new();
        sim.command(SimCommand::SetAircraft { id: "c172".into() });
        sim.command(SimCommand::SpawnRunway { airport: "KORD".into(), runway: Some("28R".into()), kind: RunwaySpawnKind::Approach });
        let field = sim.ground_fallback;
        let s = sim.snapshot();
        sim.command(SimCommand::Ground { lat: s[snap::LAT], lon: s[snap::LON], height: Some(field) });
        let mut landed = false;
        for _ in 0..(120 * 400) {
            // Hold a gentle descent: pull slightly in the flare.
            let agl = read(&sim, snap::AGL_FT);
            let mut input = ControlInput::default();
            if agl < 30.0 {
                input.pitch = 0.25;
                input.throttle_rate = -1.0;
            }
            sim.set_input(input);
            sim.step(1.0 / 120.0);
            let s = sim.snapshot();
            sim.command(SimCommand::Ground { lat: s[snap::LAT], lon: s[snap::LON], height: Some(field) });
            let ev = sim.take_events();
            if ev.iter().any(|e| matches!(e, SimEvent::Touchdown { .. })) {
                landed = true;
                break;
            }
            assert!(!ev.iter().any(|e| matches!(e, SimEvent::Crashed { .. })), "crashed: {ev:?}");
        }
        assert!(landed, "never touched down");
    }

    fn air_spawn(sim: &mut Simulation, ac: &str, agl_ft: f64, heading: f64) {
        sim.command(SimCommand::SetAircraft { id: ac.into() });
        sim.command(SimCommand::Spawn(SpawnRequest {
            lat: 41.88,
            lon: -87.63,
            heading,
            mode: SpawnMode::Air,
            agl_ft: Some(agl_ft),
            speed_kt: None,
            ground_elevation_ft: Some(600.0),
            keep_autopilot: false,
        }));
        settle(sim);
    }

    /// Rolls a landing 737 at `ias` knots on the runway and returns the stopping distance (m).
    fn stopping_distance(reverse: bool) -> f64 {
        let mut sim = Simulation::new();
        settle(&mut sim);
        // Accelerate to 120 kt, then brake.
        sim.command(SimCommand::SetThrottle { value: 1.0 });
        let dt = 1.0 / 120.0;
        while read(&sim, snap::GS_KT) < 120.0 {
            sim.step(dt);
            let s = sim.snapshot();
            sim.command(SimCommand::Ground { lat: s[snap::LAT], lon: s[snap::LON], height: Some(sim.ground_fallback) });
        }
        sim.command(SimCommand::SetThrottle { value: 0.0 });
        let start = sim.pos;
        for _ in 0..(120 * 120) {
            sim.set_input(ControlInput { brake: 0.6, reverse: if reverse { 1.0 } else { 0.0 }, ..Default::default() });
            sim.step(dt);
            let s = sim.snapshot();
            sim.command(SimCommand::Ground { lat: s[snap::LAT], lon: s[snap::LON], height: Some(sim.ground_fallback) });
            if s[snap::GS_KT] < 1.0 {
                break;
            }
        }
        (sim.pos - start).length()
    }

    #[test]
    fn thrust_reversers_shorten_the_landing_roll() {
        let plain = stopping_distance(false);
        let rev = stopping_distance(true);
        assert!(rev < plain * 0.9, "reverse {rev:.0} m vs brakes only {plain:.0} m");
    }

    #[test]
    fn headwind_reduces_groundspeed_not_airspeed() {
        let mut sim = Simulation::new();
        sim.command(SimCommand::SetWeather(crate::protocol::WeatherRequest { wind_from_deg: 90.0, wind_speed_kt: 30.0, turbulence: 0.0 }));
        air_spawn(&mut sim, "b737", 5000.0, 90.0);
        for _ in 0..(120 * 20) {
            sim.step(1.0 / 120.0);
        }
        let ias = read(&sim, snap::TAS_KT);
        let gs = read(&sim, snap::GS_KT);
        assert!(ias - gs > 35.0, "tas {ias:.0} gs {gs:.0}");
        let wind_e = read(&sim, snap::WIND_E);
        assert!(wind_e < -15.0, "wind blows west: {wind_e}");
    }

    #[test]
    fn crosswind_makes_the_track_drift_from_the_heading() {
        let mut sim = Simulation::new();
        sim.command(SimCommand::SetWeather(crate::protocol::WeatherRequest { wind_from_deg: 180.0, wind_speed_kt: 25.0, turbulence: 0.0 }));
        air_spawn(&mut sim, "c172", 3000.0, 90.0);
        for _ in 0..(120 * 20) {
            sim.step(1.0 / 120.0);
        }
        let hdg = read(&sim, snap::HEADING);
        let trk = read(&sim, snap::TRACK);
        // South wind pushes the aircraft north: track left of heading.
        assert!(hdg - trk > 8.0, "hdg {hdg:.1} trk {trk:.1}");
    }

    #[test]
    fn turbulence_is_survivable_hands_off() {
        for ac in ["b737", "c172"] {
            let mut sim = Simulation::new();
            sim.command(SimCommand::SetWeather(crate::protocol::WeatherRequest { wind_from_deg: 300.0, wind_speed_kt: 20.0, turbulence: 0.7 }));
            air_spawn(&mut sim, ac, 4000.0, 0.0);
            let alt0 = read(&sim, snap::ALT_MSL_FT);
            let mut max_g: f64 = 1.0;
            let mut min_g: f64 = 1.0;
            for _ in 0..(120 * 90) {
                sim.step(1.0 / 120.0);
                max_g = max_g.max(read(&sim, snap::NZ));
                min_g = min_g.min(read(&sim, snap::NZ));
            }
            let flags = read(&sim, snap::FLAGS) as u32;
            assert_eq!(flags & snap::flags::CRASHED, 0, "{ac} crashed");
            let alt1 = read(&sim, snap::ALT_MSL_FT);
            assert!((alt1 - alt0).abs() < 900.0, "{ac}: alt {alt0} -> {alt1}");
            assert!(read(&sim, snap::ROLL).abs() < 30.0, "{ac}: roll {}", read(&sim, snap::ROLL));
            // Bumps should be felt, but stay within the structural envelope.
            assert!(max_g > 1.1 && min_g < 0.9, "{ac}: g {min_g:.2}..{max_g:.2}");
            assert!(max_g < 2.5 && min_g > -0.5, "{ac}: g {min_g:.2}..{max_g:.2}");
        }
    }

    #[test]
    fn specific_force_reads_one_g_at_rest_and_in_level_flight() {
        let mut sim = Simulation::new();
        settle(&mut sim);
        for _ in 0..240 {
            sim.step(1.0 / 120.0);
        }
        assert!((read(&sim, snap::NZ) - 1.0).abs() < 0.05, "ground nz {}", read(&sim, snap::NZ));
        air_spawn(&mut sim, "a320", 5000.0, 0.0);
        for _ in 0..(120 * 10) {
            sim.step(1.0 / 120.0);
        }
        assert!((read(&sim, snap::NZ) - 1.0).abs() < 0.08, "air nz {}", read(&sim, snap::NZ));
    }

    #[test]
    fn ground_effect_builds_near_the_runway() {
        let mut sim = Simulation::new();
        settle(&mut sim);
        sim.step(1.0 / 120.0);
        assert!(read(&sim, snap::GROUND_EFFECT) > 0.5);
        air_spawn(&mut sim, "b737", 3000.0, 0.0);
        sim.step(1.0 / 120.0);
        assert!(read(&sim, snap::GROUND_EFFECT) < 0.01);
    }

    #[test]
    fn approach_spawn_crabs_onto_a_three_degree_ground_path() {
        let mut sim = Simulation::new();
        sim.command(SimCommand::SetWeather(crate::protocol::WeatherRequest { wind_from_deg: 220.0, wind_speed_kt: 15.0, turbulence: 0.0 }));
        sim.command(SimCommand::SpawnRunway { airport: "KORD".into(), runway: Some("28R".into()), kind: RunwaySpawnKind::Approach });
        let rwy = read(&sim, snap::HEADING);
        let s = sim.snapshot();
        sim.command(SimCommand::Ground { lat: s[snap::LAT], lon: s[snap::LON], height: Some(sim.ground_fallback) });
        sim.step(1.0 / 120.0);
        let track = read(&sim, snap::TRACK);
        let fpa = read(&sim, snap::FPA);
        let hdg = read(&sim, snap::HEADING);
        // Track follows the runway (~270°) while the nose points into the wind (left).
        assert!((geo::wrap_deg_180(track - 270.0)).abs() < 3.0, "track {track} (rwy hdg at spawn {rwy})");
        assert!(geo::wrap_deg_180(hdg - track) < -2.0, "crab hdg {hdg} trk {track}");
        assert!((fpa + 3.0).abs() < 0.3, "fpa {fpa}");
    }

    #[test]
    fn approach_attitudes_are_realistic() {
        // Stabilised on a 3° glideslope at Vref with landing flaps.
        // Fighters fly the approach on angle of attack (~11-13°), so the nose sits high.
        for (ac, lo, hi) in [("b737", 1.0, 4.5), ("a320", 1.0, 4.5), ("bizjet", 0.5, 5.0), ("longitude", 0.5, 5.0), ("c172", -4.0, 1.5), ("f16", 6.0, 11.0)] {
            let mut sim = Simulation::new();
            sim.command(SimCommand::SetAircraft { id: ac.into() });
            sim.command(SimCommand::SpawnRunway { airport: "KORD".into(), runway: Some("28R".into()), kind: RunwaySpawnKind::Approach });
            let s = sim.snapshot();
            sim.command(SimCommand::Ground { lat: s[snap::LAT], lon: s[snap::LON], height: Some(sim.ground_fallback) });
            for _ in 0..(120 * 10) {
                sim.step(1.0 / 120.0);
            }
            let pitch = read(&sim, snap::PITCH);
            assert!((lo..hi).contains(&pitch), "{ac}: approach pitch {pitch:.1}°");
        }
    }

    // ---- Fighter (F-16 class) performance against published figures -------

    fn fighter_at(alt_ft: f64, ias_kt: f64) -> Simulation {
        let mut sim = Simulation::new();
        sim.command(SimCommand::SetAircraft { id: "f16".into() });
        sim.command(SimCommand::Spawn(SpawnRequest {
            lat: 41.88,
            lon: -87.63,
            heading: 90.0,
            mode: SpawnMode::Air,
            agl_ft: Some(alt_ft - 600.0),
            speed_kt: Some(ias_kt),
            ground_elevation_ft: Some(600.0),
            keep_autopilot: false,
        }));
        settle(&mut sim);
        sim
    }

    /// Full afterburner in level flight (altitude held by the autopilot's pitch
    /// channel) for `secs`; returns the final Mach number and IAS.
    fn fighter_dash(alt_ft: f64, secs: f64) -> (f64, f64) {
        let mut sim = fighter_at(alt_ft, 400.0);
        sim.step(0.01);
        sim.command(SimCommand::ToggleAutopilot);
        sim.command(SimCommand::SetThrottle { value: 1.0 });
        for _ in 0..(secs * 60.0) as usize {
            sim.step(1.0 / 60.0);
        }
        let flags = read(&sim, snap::FLAGS) as u32;
        assert_eq!(flags & snap::flags::CRASHED, 0);
        let alt = read(&sim, snap::ALT_MSL_FT);
        assert!((alt - alt_ft).abs() < 1500.0, "dash at {alt_ft} ft drifted to {alt}");
        (read(&sim, snap::MACH), read(&sim, snap::IAS_KT))
    }

    #[test]
    fn fighter_afterburner_takeoff_is_short() {
        let mut sim = Simulation::new();
        sim.command(SimCommand::SetAircraft { id: "f16".into() });
        settle(&mut sim);
        // The fighter's idle thrust would creep it forward, so it spawns on the brakes.
        assert!(read(&sim, snap::FLAGS) as u32 & snap::flags::PARKING_BRAKE != 0);
        for _ in 0..240 {
            sim.step(1.0 / 120.0);
        }
        assert!(read(&sim, snap::GS_KT) < 0.5);
        sim.command(SimCommand::ToggleParkingBrake);
        sim.command(SimCommand::SetThrottle { value: 1.0 });
        let start = sim.pos;
        let dt = 1.0 / 120.0;
        let mut liftoff = None;
        for i in 0..(120 * 40) {
            let mut input = ControlInput::default();
            if read(&sim, snap::IAS_KT) > sim.spec().v_rotate_kt {
                input.pitch = if read(&sim, snap::PITCH) < 10.0 { 0.5 } else { 0.0 };
            }
            sim.set_input(input);
            sim.step(dt);
            let s = sim.snapshot();
            sim.command(SimCommand::Ground { lat: s[snap::LAT], lon: s[snap::LON], height: Some(sim.ground_fallback) });
            if liftoff.is_none() && read(&sim, snap::FLAGS) as u32 & snap::flags::ON_GROUND == 0 {
                liftoff = Some((i as f64 * dt, (sim.pos - start).length()));
            }
        }
        let (t, dist) = liftoff.expect("never lifted off");
        // F-16C in max afterburner: roughly 1,200-2,000 ft of runway, ~10-15 s.
        assert!((7.0..20.0).contains(&t), "liftoff after {t:.1} s");
        assert!((300.0..800.0).contains(&dist), "takeoff roll {dist:.0} m");
        assert!(read(&sim, snap::AGL_FT) > 2_000.0, "climb after 40 s: {} ft", read(&sim, snap::AGL_FT));
    }

    #[test]
    fn fighter_pulls_nine_g_and_no_more() {
        let mut sim = fighter_at(10_000.0, 450.0);
        let mut max_g: f64 = 0.0;
        for _ in 0..(120 * 4) {
            sim.set_input(ControlInput { pitch: 1.0, ..Default::default() });
            sim.step(1.0 / 120.0);
            max_g = max_g.max(read(&sim, snap::NZ));
        }
        assert!((8.5..9.6).contains(&max_g), "max g {max_g:.2}");
        assert_eq!(read(&sim, snap::FLAGS) as u32 & snap::flags::STALL, 0);
    }

    #[test]
    fn fighter_rolls_fast_and_holds_inverted() {
        let mut sim = fighter_at(15_000.0, 400.0);
        // Full-stick aileron roll: a full 360° in well under two seconds.
        let mut turned = 0.0;
        let mut prev = read(&sim, snap::ROLL);
        let mut steps = 0;
        while turned < 360.0 && steps < 120 * 4 {
            sim.set_input(ControlInput { roll: 1.0, ..Default::default() });
            sim.step(1.0 / 120.0);
            let r = read(&sim, snap::ROLL);
            turned += geo::wrap_deg_180(r - prev);
            prev = r;
            steps += 1;
        }
        let t = steps as f64 / 120.0;
        assert!(t < 2.0, "360° roll took {t:.2} s");
        sim.set_input(ControlInput::default());
        for _ in 0..(120 * 2) {
            sim.step(1.0 / 120.0);
        }
        // Let the roll stop, then ease into inverted (as a pilot would), release the stick and fly upside down hands-off.
        while read(&sim, snap::ROLL).abs() < 178.0 {
            let left = 180.0 - read(&sim, snap::ROLL).abs();
            sim.set_input(ControlInput { roll: (left / 300.0).clamp(0.06, 0.3), ..Default::default() });
            sim.step(1.0 / 120.0);
        }
        let alt0 = read(&sim, snap::ALT_MSL_FT);
        sim.set_input(ControlInput::default());
        for _ in 0..(120 * 15) {
            sim.step(1.0 / 120.0);
        }
        assert!(read(&sim, snap::ROLL).abs() > 172.0, "stayed inverted: roll {}", read(&sim, snap::ROLL));
        let nz = read(&sim, snap::NZ);
        assert!((-1.3..-0.7).contains(&nz), "inverted level flight is -1 g: {nz:.2}");
        let alt1 = read(&sim, snap::ALT_MSL_FT);
        assert!((alt1 - alt0).abs() < 600.0, "inverted alt {alt0:.0} -> {alt1:.0}");
    }

    #[test]
    fn fighter_top_speed_matches_the_real_envelope() {
        // About Mach 2 at 40,000 ft in full afterburner...
        let (mach, _) = fighter_dash(40_000.0, 360.0);
        assert!((1.85..2.25).contains(&mach), "Mach {mach:.2} at FL400");
        // ...but only around Mach 1.2 (the 800 KCAS region) on the deck.
        let (mach, ias) = fighter_dash(2_000.0, 120.0);
        assert!((1.05..1.35).contains(&mach), "Mach {mach:.2} at 2,000 ft");
        assert!(ias < 900.0, "{ias:.0} KIAS at 2,000 ft");
    }

    #[test]
    fn fighter_supercruises_only_marginally() {
        // Dry (military) power at 30,000 ft: about Mach 1.0-1.1, no further.
        let mut sim = fighter_at(30_000.0, 350.0);
        sim.step(0.01);
        sim.command(SimCommand::ToggleAutopilot);
        sim.command(SimCommand::SetThrottle { value: sim.spec().afterburner_detent });
        for _ in 0..(60 * 300) {
            sim.step(1.0 / 60.0);
        }
        let mach = read(&sim, snap::MACH);
        assert_eq!(read(&sim, snap::AFTERBURNER), 0.0);
        assert!((0.9..1.2).contains(&mach), "MIL power Mach {mach:.2} at FL300");
    }
}
