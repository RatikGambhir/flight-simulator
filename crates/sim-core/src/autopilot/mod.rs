//! Autopilot and flight management.
//!
//! The autopilot flies the aircraft through every phase of a flight — taxi,
//! line-up, takeoff, climb, cruise, descent, approach, landing and rollout —
//! with a state machine of [`Phase`]s. It never moves the aircraft directly:
//! each phase produces the same demands a pilot makes (roll and pitch stick,
//! load factor through the assisted control law, throttle lever, rudder /
//! nosewheel steering, wheel brakes, reversers, gear, flaps and speed brakes)
//! and the flight model integrates them like any other input. It runs inside
//! the fixed-step physics loop, so it is independent of the display rate.
//!
//! Without a destination it falls back to the classic three-mode autopilot
//! ([`Phase::Hold`]: heading, altitude and speed hold), and on the ground it
//! takes off and climbs out on the runway heading before holding.

pub mod control;
pub mod nav;
pub mod perf;
#[cfg(test)]
mod tests;

use std::f64::consts::PI;

use crate::aircraft::AircraftSpec;
use crate::geo::{wrap_deg_180, wrap_deg_360, KT_TO_MS, MS_TO_KT, M_TO_FT};
use crate::protocol::{AutopilotCommand, ControlInput};

use control::{
    autothrottle, bank_for_error_k, bank_for_heading_error, gamma_for_vs, load_factor, load_factor_k, lowpass, roll_stick, roll_stick_k,
    rotation_stick, slew, speed_on_pitch_gamma, K_GAMMA,
};
pub use nav::{NavTarget, RunwayGeom, Wind};
use nav::{
    angle_diff, bearing_to, choose_landing_runway, choose_takeoff_runway, distance_m, established, line_track, pursuit_steer, runway_under,
    to_body, ApproachGeometry, CHI_DOWNWIND,
};
pub use perf::Perf;
use perf::GLIDESLOPE_DEG;

/// Flight phase the autopilot is executing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum Phase {
    #[default]
    Off = 0,
    /// Classic heading / altitude / speed hold (no destination).
    Hold = 1,
    Taxi = 2,
    LineUp = 3,
    TakeoffRoll = 4,
    Rotate = 5,
    InitialClimb = 6,
    Climb = 7,
    Cruise = 8,
    Descent = 9,
    Approach = 10,
    Final = 11,
    Flare = 12,
    Rollout = 13,
    /// Landed and stopped on the runway.
    Stopped = 14,
    GoAround = 15,
}

impl Phase {
    pub const ALL: [Phase; 16] = [
        Phase::Off,
        Phase::Hold,
        Phase::Taxi,
        Phase::LineUp,
        Phase::TakeoffRoll,
        Phase::Rotate,
        Phase::InitialClimb,
        Phase::Climb,
        Phase::Cruise,
        Phase::Descent,
        Phase::Approach,
        Phase::Final,
        Phase::Flare,
        Phase::Rollout,
        Phase::Stopped,
        Phase::GoAround,
    ];

    pub fn code(self) -> u32 {
        self as u32
    }

    pub fn from_code(code: u32) -> Option<Self> {
        Self::ALL.get(code as usize).copied()
    }

    pub fn label(self) -> &'static str {
        match self {
            Phase::Off => "OFF",
            Phase::Hold => "HDG/ALT HOLD",
            Phase::Taxi => "TAXI",
            Phase::LineUp => "LINE UP",
            Phase::TakeoffRoll => "TAKEOFF",
            Phase::Rotate => "ROTATE",
            Phase::InitialClimb => "INITIAL CLIMB",
            Phase::Climb => "CLIMB",
            Phase::Cruise => "CRUISE",
            Phase::Descent => "DESCENT",
            Phase::Approach => "APPROACH",
            Phase::Final => "FINAL",
            Phase::Flare => "FLARE",
            Phase::Rollout => "ROLLOUT",
            Phase::Stopped => "LANDED",
            Phase::GoAround => "GO-AROUND",
        }
    }

    /// Phases flown with the wheels on the ground.
    pub fn is_ground(self) -> bool {
        matches!(self, Phase::Taxi | Phase::LineUp | Phase::TakeoffRoll | Phase::Rotate | Phase::Rollout | Phase::Stopped)
    }
}

/// Lateral guidance mode (for display).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum Lateral {
    #[default]
    None = 0,
    Heading = 1,
    /// Climbing out on the runway heading.
    RunwayTrack = 2,
    /// Great-circle direct to the approach entry.
    Direct = 3,
    Downwind = 4,
    /// Base / intercept onto the final approach course.
    Intercept = 5,
    /// Established on the final approach course.
    Localizer = 6,
    /// Following the runway centreline on the ground.
    Centreline = 7,
    Taxi = 8,
}

/// Approach leg (internal).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Leg {
    #[default]
    None,
    DirectFinal,
    DirectDownwind,
    Downwind,
    Intercept,
    Localizer,
}

/// Everything the autopilot reads from the aircraft.
#[derive(Debug, Clone, Default)]
pub struct ApInputs {
    pub lat: f64,
    pub lon: f64,
    /// Height of the centre of gravity above the ellipsoid (m).
    pub height: f64,
    pub geoid: f64,
    /// Height of the centre of gravity above the wheels (m).
    pub contact_h: f64,
    /// Ground height under the aircraft (m above the ellipsoid).
    pub ground_h: f64,
    /// Highest terrain reported ahead along the track (m above the ellipsoid).
    pub terrain_ahead: Option<f64>,
    pub alt_msl_ft: f64,
    pub agl_ft: f64,
    /// Degrees true, 0..360.
    pub heading: f64,
    pub track: f64,
    pub pitch_deg: f64,
    pub roll_deg: f64,
    pub alpha_deg: f64,
    pub ias_kt: f64,
    pub tas_ms: f64,
    pub gs_ms: f64,
    /// Inertial speed (m/s).
    pub speed_ms: f64,
    pub vs_fpm: f64,
    /// Inertial flight-path angle (rad).
    pub gamma: f64,
    /// Air density ratio ρ/ρ₀.
    pub sigma: f64,
    pub speed_of_sound: f64,
    /// Max commanded roll rate (rad/s).
    pub roll_rate_max: f64,
    /// Max commanded pitch rate (rad/s).
    pub pitch_rate_max: f64,
    /// Control effectiveness 0..1 (dynamic pressure).
    pub control_eff: f64,
    pub on_ground: bool,
    pub gear: f64,
    pub gear_down_cmd: bool,
    pub flaps_index: usize,
    pub speedbrake_cmd: bool,
    pub lever: f64,
    pub reverser: f64,
    pub parking_brake: bool,
    pub wind_from_deg: f64,
    pub wind_kt: f64,
    /// Reported turbulence intensity 0..1 (for the approach gust additive).
    pub turbulence: f64,
    /// Measured normal load factor (g, accelerometer).
    pub nz: f64,
    /// Reported RMS vertical gust near the ground (m/s).
    pub gust_ms: f64,
}

impl ApInputs {
    fn wind(&self) -> Wind {
        Wind { from_deg: self.wind_from_deg, speed_kt: self.wind_kt }
    }

    /// Wheel height above the ellipsoid (m).
    fn wheels_h(&self) -> f64 {
        self.height - self.contact_h
    }
}

/// Demands the autopilot makes this step. `None` leaves the pilot's input in charge.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct ApOutput {
    pub roll_stick: Option<f64>,
    /// Pitch stick (used on the ground to rotate).
    pub pitch_stick: Option<f64>,
    pub load_factor: Option<f64>,
    pub throttle: Option<f64>,
    /// Nosewheel steering -1..1 (ground).
    pub steer: Option<f64>,
    pub brake: Option<f64>,
    pub reverse: Option<f64>,
    pub gear_down: Option<bool>,
    pub flaps_index: Option<usize>,
    pub speedbrake: Option<bool>,
    pub parking_brake: Option<bool>,
}

#[derive(Debug, Clone, Copy)]
enum Thrust {
    /// Autothrottle holds the commanded speed.
    Speed,
    /// Lever slews to a setting (takeoff/go-around power, idle).
    Fixed { lever: f64, rate: f64 },
}

/// Guidance for one airborne step.
#[derive(Debug, Clone, Copy)]
struct Cmd {
    track: Option<f64>,
    heading: Option<f64>,
    bank_limit: f64,
    vs: f64,
    vs_rate: f64,
    thrust: Thrust,
    speed: f64,
    alt_ft: f64,
    pitch_max: f64,
    n_min: f64,
    n_max: f64,
    /// Flight-path gain (1/s).
    k_gamma: f64,
    /// Bank per degree of track error.
    track_gain: f64,
    /// Roll-attitude gain multiplier (stiffer near the ground).
    roll_boost: f64,
    /// Integrate measured load factor error (precision tracking near the ground).
    n_integral: bool,
    gear: Option<bool>,
    flaps: Option<usize>,
    speedbrake: Option<bool>,
}

/// Approach-relative state for one step (all copies, no borrows).
#[derive(Debug, Clone, Copy)]
struct Ctx {
    along: f64,
    cross: f64,
    dist: f64,
    course: f64,
    trk_err: f64,
    /// Wheels above the threshold (m).
    h_thr: f64,
    /// Glidepath height above the threshold here (m).
    gs_h: f64,
    elev_ft: f64,
    length: f64,
    width: f64,
    aim: f64,
    geo: ApproachGeometry,
    path_total: f64,
    path_to_level: f64,
}

/// Approach legs are re-evaluated with some hysteresis; this many seconds must pass between changes.
const LEG_HOLD_S: f64 = 4.0;
const GA_MAX: u32 = 3;
/// Turbulence intensity (0..1) at and above which the autopilot will not land.
const SEVERE_TURBULENCE: f64 = 0.7;

#[derive(Debug, Clone)]
pub struct Autopilot {
    pub engaged: bool,
    pub phase: Phase,
    pub lateral: Lateral,
    pub heading_hold: bool,
    pub altitude_hold: bool,
    pub autothrottle: bool,
    pub target_heading: f64,
    pub target_altitude_ft: f64,
    pub target_speed_kt: f64,
    /// Hold mode: max climb/descent rate. Managed: the commanded vertical speed.
    pub vertical_speed_fpm: f64,
    /// Remaining distance along the planned path (nm).
    pub dist_to_go_nm: Option<f64>,

    destination: Option<NavTarget>,
    spawn_target: Option<NavTarget>,
    runway: Option<RunwayGeom>,
    geom: Option<ApproachGeometry>,
    runway_locked: bool,
    departure: Option<RunwayGeom>,
    perf: Option<(&'static str, Perf)>,
    leg: Leg,
    leg_time: f64,
    side: f64,
    cruise_alt_ft: f64,
    cruise_speed_kt: Option<f64>,
    climbout_track: f64,
    v_final: f64,

    bank_cmd: f64,
    vs_cmd: f64,
    gamma_cmd: Option<f64>,
    gamma_rate: f64,
    /// Integral of commanded minus measured load factor (g).
    n_int: f64,
    n_last: f64,
    spd_cmd: f64,
    pitch_ramp: f64,
    brake_cmd: f64,
    prev_ias: Option<f64>,
    ias_rate: f64,
    /// Smoothed airspeed, bank and sink rate (turbulence-tolerant checks).
    ias_filt: f64,
    roll_filt: f64,
    sink_filt: f64,
    unstable_time: f64,
    prev_gs: Option<f64>,
    gs_rate: f64,
    phase_time: f64,
    since_engaged: f64,
    flap_timer: f64,
    go_arounds: u32,
    gate_checked: bool,
    /// Circling the field because the weather is beyond the landing limits.
    weather_hold: bool,
    /// Time airborne after a touchdown (bounce detection).
    airborne_time: f64,
    escape_time: f64,
    told_heading: bool,
    messages: Vec<String>,
    runway_event: Option<(String, String)>,
}

impl Default for Autopilot {
    fn default() -> Self {
        Self {
            engaged: false,
            phase: Phase::Off,
            lateral: Lateral::None,
            heading_hold: true,
            altitude_hold: true,
            autothrottle: true,
            target_heading: 0.0,
            target_altitude_ft: 5000.0,
            target_speed_kt: 250.0,
            vertical_speed_fpm: 1800.0,
            dist_to_go_nm: None,
            destination: None,
            spawn_target: None,
            runway: None,
            geom: None,
            runway_locked: false,
            departure: None,
            perf: None,
            leg: Leg::None,
            leg_time: 0.0,
            side: -1.0,
            cruise_alt_ft: 10_000.0,
            cruise_speed_kt: None,
            climbout_track: 0.0,
            v_final: 0.0,
            bank_cmd: 0.0,
            vs_cmd: 0.0,
            gamma_cmd: None,
            gamma_rate: 0.0,
            n_int: 0.0,
            n_last: 1.0,
            spd_cmd: 0.0,
            pitch_ramp: 0.0,
            brake_cmd: 0.0,
            prev_ias: None,
            ias_rate: 0.0,
            ias_filt: 0.0,
            roll_filt: 0.0,
            sink_filt: 0.0,
            unstable_time: 0.0,
            prev_gs: None,
            gs_rate: 0.0,
            phase_time: 0.0,
            since_engaged: 0.0,
            flap_timer: 0.0,
            go_arounds: 0,
            gate_checked: false,
            weather_hold: false,
            airborne_time: 0.0,
            escape_time: 0.0,
            told_heading: false,
            messages: Vec::new(),
            runway_event: None,
        }
    }
}

impl Autopilot {
    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /// True when navigating to a destination (any phase but hold).
    pub fn is_managed(&self) -> bool {
        self.engaged && self.phase != Phase::Hold
    }

    pub fn runway(&self) -> Option<&RunwayGeom> {
        self.runway.as_ref()
    }

    pub fn departure_runway(&self) -> Option<&RunwayGeom> {
        self.departure.as_ref()
    }

    pub fn destination(&self) -> Option<&NavTarget> {
        self.target()
    }

    pub fn cruise_altitude_ft(&self) -> f64 {
        self.cruise_alt_ft
    }

    pub fn go_arounds(&self) -> u32 {
        self.go_arounds
    }

    pub fn take_messages(&mut self) -> Vec<String> {
        std::mem::take(&mut self.messages)
    }

    /// The landing runway the autopilot switched to since the last call (airport, runway).
    pub fn take_runway_event(&mut self) -> Option<(String, String)> {
        self.runway_event.take()
    }

    /// Sets (or clears) the destination chosen by the user. While engaged the
    /// flight is re-planned from the current state.
    pub fn set_destination(&mut self, target: Option<NavTarget>, inp: &ApInputs, spec: &AircraftSpec) {
        self.destination = target;
        self.replan(inp, spec);
    }

    /// Landing target implied by the spawn (a final-approach start), used without a destination.
    pub fn set_spawn_target(&mut self, target: Option<NavTarget>) {
        self.spawn_target = target;
        self.clear_plan();
    }

    /// Clears everything flight-specific (new spawn); keeps the destination.
    pub fn reset(&mut self) {
        self.engaged = false;
        self.phase = Phase::Off;
        self.lateral = Lateral::None;
        self.dist_to_go_nm = None;
        self.departure = None;
        self.clear_plan();
    }

    fn clear_plan(&mut self) {
        self.runway = None;
        self.geom = None;
        self.runway_locked = false;
        self.leg = Leg::None;
    }

    fn replan(&mut self, inp: &ApInputs, spec: &AircraftSpec) {
        self.clear_plan();
        if self.engaged && !inp.on_ground && !matches!(self.phase, Phase::Flare | Phase::Rollout | Phase::Stopped) {
            self.engage(inp, spec);
        }
    }

    /// Engages from the current state. Returns false (with a message) when the
    /// autopilot cannot fly from here.
    pub fn engage(&mut self, inp: &ApInputs, spec: &AircraftSpec) -> bool {
        let perf = self.perf_for(spec).clone();
        self.init_filters(inp);
        self.go_arounds = 0;
        self.gate_checked = false;
        self.escape_time = 0.0;
        self.since_engaged = 0.0;
        self.told_heading = false;
        self.autothrottle = true;
        self.heading_hold = true;
        self.altitude_hold = true;
        self.leg = Leg::None;
        let ok = if inp.on_ground { self.engage_on_ground(inp, &perf) } else { self.engage_airborne(inp, &perf) };
        if ok {
            self.engaged = true;
        }
        ok
    }

    pub fn disengage(&mut self, message: Option<&str>) {
        if self.engaged {
            if let Some(m) = message {
                self.say(m);
            }
        }
        self.engaged = false;
        self.phase = Phase::Off;
        self.lateral = Lateral::None;
        self.dist_to_go_nm = None;
    }

    /// Called by the flight model at touchdown. The classic hold mode
    /// disconnects; a managed landing continues into the rollout.
    pub fn on_touchdown(&mut self) {
        if self.engaged && self.phase == Phase::Hold {
            self.disengage(None);
        }
    }

    /// The pilot moved the thrust levers. Returns true if the autopilot had to
    /// disconnect (thrust is essential to the phase being flown).
    pub fn manual_throttle(&mut self) -> bool {
        if !self.engaged {
            return false;
        }
        if matches!(self.phase, Phase::Taxi | Phase::LineUp | Phase::TakeoffRoll | Phase::Rotate) {
            self.disengage(Some("Autopilot disconnected: manual thrust during takeoff"));
            return true;
        }
        if self.autothrottle {
            self.autothrottle = false;
            self.say("Autothrottle off");
        }
        false
    }

    /// Why a pilot input should disconnect the autopilot, if it should.
    pub fn pilot_override(&self, input: &ControlInput, on_ground: bool) -> Option<&'static str> {
        if !self.engaged {
            return None;
        }
        if input.pitch.abs() > 0.6 || input.roll.abs() > 0.6 {
            return Some("Autopilot disconnected by pilot input");
        }
        if on_ground && input.yaw.abs() > 0.6 {
            return Some("Autopilot disconnected by pilot steering");
        }
        if input.brake > 0.5 && matches!(self.phase, Phase::Taxi | Phase::LineUp | Phase::TakeoffRoll | Phase::Rotate) {
            return Some("Takeoff rejected by the pilot — autopilot disconnected");
        }
        None
    }

    /// Mode-control-panel style commands (target adjustments).
    pub fn apply(&mut self, cmd: &AutopilotCommand, spec: &AircraftSpec) {
        let perf = self.perf_for(spec).clone();
        if let Some(v) = cmd.autothrottle {
            self.autothrottle = v;
        }
        if !self.is_managed() {
            if let Some(v) = cmd.heading_hold {
                self.heading_hold = v;
            }
            if let Some(v) = cmd.altitude_hold {
                self.altitude_hold = v;
            }
            if let Some(v) = cmd.heading {
                self.target_heading = wrap_deg_360(v);
            }
            if let Some(v) = cmd.altitude_ft {
                self.target_altitude_ft = v.clamp(0.0, spec.max_alt_ft);
            }
            if let Some(v) = cmd.speed_kt {
                self.target_speed_kt = v.clamp(spec.v_approach_kt * 0.85, spec.v_max_kt);
            }
            if let Some(v) = cmd.vertical_speed_fpm {
                self.vertical_speed_fpm = v.abs().clamp(300.0, 6000.0);
            }
            if let Some(d) = cmd.heading_delta {
                self.target_heading = wrap_deg_360(self.target_heading + d);
            }
            if let Some(d) = cmd.altitude_delta_ft {
                self.target_altitude_ft = (self.target_altitude_ft + d).clamp(0.0, spec.max_alt_ft);
            }
            if let Some(d) = cmd.speed_delta_kt {
                self.target_speed_kt = (self.target_speed_kt + d).clamp(spec.v_approach_kt * 0.85, spec.v_max_kt);
            }
            return;
        }
        // Managed flight: the route is fixed, but the cruise level and speed can be changed.
        let alt = cmd.altitude_ft.or(cmd.altitude_delta_ft.map(|d| self.cruise_alt_ft + d));
        if let Some(a) = alt {
            if matches!(self.phase, Phase::Climb | Phase::Cruise | Phase::TakeoffRoll | Phase::Rotate | Phase::InitialClimb | Phase::Taxi | Phase::LineUp) {
                let floor = self.runway.as_ref().map_or(1000.0, |r| r.elevation_ft_msl() + perf.pattern_agl_ft + 1000.0);
                self.cruise_alt_ft = a.clamp(floor, perf.max_alt_ft);
                self.say(format!("Cruise altitude {} ft", self.cruise_alt_ft.round()));
                if self.phase == Phase::Cruise {
                    self.set_phase(Phase::Climb, None);
                }
            }
        }
        let spd = cmd.speed_kt.or(cmd.speed_delta_kt.map(|d| self.cruise_speed_kt.unwrap_or(perf.v_cruise) + d));
        if let Some(v) = spd {
            let v = v.clamp(perf.v_clean, perf.v_limit);
            self.cruise_speed_kt = Some(v);
            self.say(format!("Cruise speed {} kt", v.round()));
        }
        if (cmd.heading.is_some() || cmd.heading_delta.is_some()) && !self.told_heading {
            self.told_heading = true;
            self.say("Autopilot is navigating to the destination; heading follows the route");
        }
    }

    /// One fixed physics step.
    pub fn update(&mut self, inp: &ApInputs, spec: &AircraftSpec, dt: f64) -> ApOutput {
        self.track_rates(inp, dt);
        if !self.engaged || dt <= 0.0 {
            return ApOutput::default();
        }
        self.phase_time += dt;
        self.since_engaged += dt;
        self.flap_timer += dt;
        self.leg_time += dt;
        let perf = self.perf_for(spec).clone();
        let out = match self.phase {
            Phase::Off => ApOutput::default(),
            Phase::Hold => self.hold(inp, &perf, dt),
            Phase::Taxi | Phase::LineUp | Phase::TakeoffRoll | Phase::Rotate => self.departure_ground(inp, &perf, dt),
            Phase::Rollout | Phase::Stopped => self.arrival_ground(inp, &perf, dt),
            _ => self.airborne(inp, &perf, dt),
        };
        if self.target().is_some() && self.phase != Phase::Hold {
            if let Some(ctx) = self.ctx(inp, &perf) {
                self.dist_to_go_nm = Some(ctx.path_total.max(0.0) / 1852.0);
            } else if let Some(t) = self.target() {
                self.dist_to_go_nm = Some(distance_m(inp.lat, inp.lon, t.airport.lat, t.airport.lon) / 1852.0);
            }
        } else {
            self.dist_to_go_nm = None;
        }
        out
    }

    // -----------------------------------------------------------------------
    // Engagement
    // -----------------------------------------------------------------------

    fn target(&self) -> Option<&NavTarget> {
        self.destination.as_ref().or(self.spawn_target.as_ref())
    }

    fn perf_for(&mut self, spec: &AircraftSpec) -> &Perf {
        if self.perf.as_ref().is_none_or(|(id, _)| *id != spec.id) {
            self.perf = Some((spec.id, Perf::from_spec(spec)));
            self.clear_plan();
        }
        &self.perf.as_ref().expect("perf just set").1
    }

    fn say(&mut self, text: impl Into<String>) {
        self.messages.push(text.into());
    }

    fn set_phase(&mut self, phase: Phase, message: Option<String>) {
        if phase != self.phase {
            self.phase = phase;
            self.phase_time = 0.0;
            if let Some(m) = message {
                self.say(m);
            }
        }
    }

    fn init_filters(&mut self, inp: &ApInputs) {
        self.bank_cmd = inp.roll_deg;
        self.vs_cmd = inp.vs_fpm;
        self.gamma_cmd = None;
        self.gamma_rate = 0.0;
        self.spd_cmd = inp.ias_kt;
        self.pitch_ramp = inp.pitch_deg;
        self.brake_cmd = 0.0;
        self.flap_timer = 10.0;
        self.leg_time = LEG_HOLD_S;
    }

    fn track_rates(&mut self, inp: &ApInputs, dt: f64) {
        if dt <= 0.0 {
            return;
        }
        if let Some(prev) = self.prev_ias {
            self.ias_rate = lowpass(self.ias_rate, (inp.ias_kt - prev) / dt, 0.5, dt);
            self.ias_filt = lowpass(self.ias_filt, inp.ias_kt, 1.5, dt);
        } else {
            self.ias_filt = inp.ias_kt;
        }
        self.roll_filt = lowpass(self.roll_filt, inp.roll_deg, 1.5, dt);
        self.sink_filt = lowpass(self.sink_filt, -inp.vs_fpm, 2.0, dt);
        self.prev_ias = Some(inp.ias_kt);
        if let Some(prev) = self.prev_gs {
            self.gs_rate = lowpass(self.gs_rate, (inp.gs_ms - prev) / dt, 0.4, dt);
        }
        self.prev_gs = Some(inp.gs_ms);
    }

    fn engage_hold(&mut self, inp: &ApInputs, perf: &Perf) {
        self.target_heading = inp.heading.round();
        self.target_altitude_ft = (inp.alt_msl_ft / 100.0).round() * 100.0;
        self.target_speed_kt = inp.ias_kt.round().clamp(perf.v_ref, perf.v_limit);
        self.vertical_speed_fpm = 1800.0;
        self.phase = Phase::Hold;
        self.phase_time = 0.0;
        self.lateral = Lateral::Heading;
    }

    fn engage_airborne(&mut self, inp: &ApInputs, perf: &Perf) -> bool {
        if self.target().is_none() {
            self.engage_hold(inp, perf);
            self.say("Autopilot engaged: HDG / ALT / SPD hold — choose a destination (M) to fly a full route");
            return true;
        }
        self.plan_runway(inp, perf, true);
        let Some(ctx) = self.ctx(inp, perf) else {
            self.engage_hold(inp, perf);
            self.say("Autopilot engaged: HDG / ALT / SPD hold — no usable runway at the destination");
            return true;
        };
        self.plan_cruise(inp, perf, true);
        let phase = self.assess_airborne(inp, perf, &ctx);
        if phase == Phase::InitialClimb {
            self.climbout_track = inp.track;
        }
        self.phase = Phase::Off;
        self.set_phase(phase, None);
        let rw = self.runway.as_ref().map(|r| format!("{} runway {}", r.airport, r.ident)).unwrap_or_default();
        self.say(format!("Autopilot engaged: {} — landing {}", phase.label(), rw));
        true
    }

    /// The phase that matches the aircraft's current state.
    fn assess_airborne(&mut self, inp: &ApInputs, perf: &Perf, ctx: &Ctx) -> Phase {
        let on_final_course = ctx.along < 0.0 && -ctx.along < ctx.geo.join + 2_000.0 && established(ctx.cross, ctx.trk_err);
        if on_final_course {
            self.leg = Leg::Localizer;
            let flare_ft = self.flare_height_ft(inp, perf);
            if inp.agl_ft < flare_ft + 5.0 && inp.vs_fpm < 0.0 && ctx.along > -600.0 {
                return Phase::Flare;
            }
            if ctx.h_thr <= ctx.gs_h + 45.0 || -ctx.along < perf.faf_m {
                return Phase::Final;
            }
            return Phase::Approach;
        }
        if inp.agl_ft < perf.acceleration_agl_ft && inp.vs_fpm > 200.0 {
            return Phase::InitialClimb;
        }
        if ctx.dist < ctx.geo.terminal {
            return Phase::Approach;
        }
        let prof_ft = self.profile_ft(ctx, perf);
        if inp.alt_msl_ft > prof_ft + 500.0 {
            Phase::Descent
        } else if inp.alt_msl_ft < self.cruise_alt_ft - 300.0 {
            Phase::Climb
        } else {
            Phase::Cruise
        }
    }

    fn engage_on_ground(&mut self, inp: &ApInputs, perf: &Perf) -> bool {
        let wind = inp.wind();
        if inp.gs_ms > 15.0 {
            // Already rolling fast: continue a takeoff, or stop after a landing.
            if let Some((g, _, _)) = runway_under(inp.lat, inp.lon, inp.heading, 20.0) {
                let taking_off = inp.lever > 0.5 && inp.ias_kt < perf.v_rotate + 10.0;
                if taking_off {
                    self.departure = Some(g);
                    self.climbout_track = inp.heading;
                    self.plan_cruise(inp, perf, true);
                    self.phase = Phase::Off;
                    self.set_phase(Phase::TakeoffRoll, Some("Autopilot engaged: continuing the takeoff".into()));
                } else {
                    self.runway = Some(g);
                    self.phase = Phase::Off;
                    self.set_phase(Phase::Rollout, Some("Autopilot engaged: rollout — braking to a stop".into()));
                }
            } else {
                self.climbout_track = inp.heading;
                self.phase = Phase::Off;
                self.set_phase(Phase::Rollout, Some("Autopilot engaged: braking to a stop".into()));
            }
            return true;
        }
        let on_runway = runway_under(inp.lat, inp.lon, inp.heading, 30.0)
            .filter(|(g, a, _)| g.length_m - a >= perf.required_takeoff_m && (!perf.hard_surface_only || g.hard));
        let (rwy, phase) = if let Some((g, _, c)) = on_runway {
            let aligned = wrap_deg_180(inp.heading - g.course_deg()).abs() < 3.0 && c.abs() < 4.0;
            (g, if aligned { Phase::TakeoffRoll } else { Phase::LineUp })
        } else if let Some(g) = choose_takeoff_runway(inp.lat, inp.lon, perf, wind, 5.0) {
            (g, Phase::Taxi)
        } else {
            self.say("Autopilot unavailable: no runway nearby to take off from");
            return false;
        };
        let msg = match phase {
            Phase::Taxi => format!("Autopilot engaged: taxiing to runway {}", rwy.ident),
            Phase::LineUp => format!("Autopilot engaged: lining up on runway {}", rwy.ident),
            _ => format!("Autopilot engaged: takeoff from runway {}", rwy.ident),
        };
        self.climbout_track = rwy.course_deg();
        self.departure = Some(rwy);
        self.plan_cruise(inp, perf, true);
        self.plan_runway(inp, perf, true);
        let dest = self.target().map(|t| t.airport.ident.clone());
        self.phase = Phase::Off;
        self.set_phase(phase, None);
        self.say(match dest {
            Some(d) => format!("{msg} — destination {d}"),
            None => format!("{msg} — no destination: will climb out and hold runway heading"),
        });
        true
    }

    /// Chooses the landing runway (once; again after a go-around or when `force`).
    fn plan_runway(&mut self, inp: &ApInputs, perf: &Perf, force: bool) {
        if self.runway.is_some() && !force {
            return;
        }
        let Some(target) = self.target() else { return };
        let choice = choose_landing_runway(target, perf, inp.wind(), Some((inp.lat, inp.lon)));
        if let Some(rw) = choice {
            let changed = self.runway.as_ref().is_none_or(|r| r.ident != rw.ident || r.airport != rw.airport);
            self.geom = Some(ApproachGeometry::new(perf, &rw));
            if changed {
                self.runway_event = Some((rw.airport.clone(), rw.ident.clone()));
                self.say(format!("Landing runway {} at {}", rw.ident, rw.airport));
                self.leg = Leg::None;
            }
            self.runway = Some(rw);
        }
    }

    /// Cruise altitude for the trip from here (short trips stay low).
    fn plan_cruise(&mut self, inp: &ApInputs, perf: &Perf, keep_current: bool) {
        let here_ft = inp.alt_msl_ft - inp.agl_ft;
        match self.target() {
            Some(t) => {
                let dist_nm = distance_m(inp.lat, inp.lon, t.airport.lat, t.airport.lon) / 1852.0;
                let field = here_ft.max(t.airport.elevation_ft);
                let plan = perf.cruise_altitude_ft(dist_nm, field);
                let current = (inp.alt_msl_ft / 500.0).round() * 500.0;
                self.cruise_alt_ft = if keep_current && !inp.on_ground && current > plan { current.min(perf.max_alt_ft) } else { plan };
            }
            None => self.cruise_alt_ft = ((here_ft + perf.default_hold_agl_ft) / 500.0).round() * 500.0,
        }
    }

    // -----------------------------------------------------------------------
    // Hold (classic autopilot)
    // -----------------------------------------------------------------------

    fn hold(&mut self, inp: &ApInputs, perf: &Perf, dt: f64) -> ApOutput {
        if inp.on_ground {
            return ApOutput::default();
        }
        let mut out = ApOutput::default();
        let limit = if perf.aerobatic { 20.0 } else { 25.0 };
        let bank_target = if self.heading_hold { bank_for_heading_error(self.target_heading - inp.heading, limit) } else { 0.0 };
        self.bank_cmd = slew(self.bank_cmd, bank_target, perf.bank_rate_dps * dt);
        out.roll_stick = Some(roll_stick(self.bank_cmd, inp.roll_deg, inp.roll_rate_max, inp.control_eff));
        let vs_target = if self.altitude_hold {
            ((self.target_altitude_ft - inp.alt_msl_ft) * 2.5).clamp(-self.vertical_speed_fpm, self.vertical_speed_fpm)
        } else {
            0.0
        };
        self.vs_cmd = slew(self.vs_cmd, vs_target, 300.0 * dt);
        let v = inp.tas_ms.max(20.0);
        let gamma_cmd = gamma_for_vs(self.vs_cmd, v).clamp(-0.25, 0.25);
        out.load_factor = Some(load_factor(gamma_cmd, inp.gamma, inp.roll_deg, v, 0.6, 1.5));
        if self.autothrottle {
            out.throttle = Some(autothrottle(inp.lever, self.target_speed_kt, inp.ias_kt, self.ias_rate, 1.0, dt));
        }
        self.lateral = if self.heading_hold { Lateral::Heading } else { Lateral::None };
        out
    }

    // -----------------------------------------------------------------------
    // Departure on the ground
    // -----------------------------------------------------------------------

    fn departure_ground(&mut self, inp: &ApInputs, perf: &Perf, dt: f64) -> ApOutput {
        if !inp.on_ground && matches!(self.phase, Phase::Rotate | Phase::TakeoffRoll) {
            self.vs_cmd = inp.vs_fpm;
            self.bank_cmd = inp.roll_deg;
            self.spd_cmd = inp.ias_kt;
            self.gamma_cmd = None;
            self.set_phase(Phase::InitialClimb, Some("Liftoff — initial climb".into()));
            return self.airborne(inp, perf, dt);
        }
        let Some(rw) = self.departure.as_ref() else {
            self.disengage(Some("Autopilot disconnected: no departure runway"));
            return ApOutput::default();
        };
        let (along, cross) = rw.frame(inp.lat, inp.lon);
        let (course, length, ident) = (rw.course, rw.length_m, rw.ident.clone());
        let rel = angle_diff(inp.heading.to_radians(), course);
        let v = inp.gs_ms;
        let mut out = ApOutput { parking_brake: inp.parking_brake.then_some(false), ..Default::default() };
        let mut speed_target: Option<f64> = None;
        self.lateral = Lateral::Centreline;
        match self.phase {
            Phase::Taxi => {
                self.lateral = Lateral::Taxi;
                let (d_a, d_c) = (40.0 - along, -cross);
                let dist = d_a.hypot(d_c);
                if dist < 30.0 {
                    self.set_phase(Phase::LineUp, Some(format!("Lining up on runway {ident}")));
                }
                let (ahead, right) = to_body(d_a, d_c, rel);
                let off = right.atan2(ahead);
                out.steer = Some(if ahead < 5.0 { right.signum() } else { pursuit_steer(ahead, right, v, perf.wheelbase_m) });
                speed_target = Some(if dist < 150.0 || off.abs() > 0.5 { 6.0 } else { perf.taxi_speed_kt });
            }
            Phase::LineUp => {
                let (ahead, right) = to_body(30.0, -cross, rel);
                out.steer = Some(pursuit_steer(ahead, right, v, perf.wheelbase_m));
                speed_target = Some(5.0);
                if rel.abs() < 3f64.to_radians() && cross.abs() < 3.0 {
                    self.set_phase(Phase::TakeoffRoll, Some(format!("Takeoff power — runway {ident}")));
                }
            }
            Phase::TakeoffRoll | Phase::Rotate => {
                let look = (2.5 * v).clamp(25.0, 250.0);
                let (ahead, right) = to_body(look, -cross, rel);
                out.steer = Some(pursuit_steer(ahead, right, v, perf.wheelbase_m));
                out.brake = Some(0.0);
                if self.autothrottle {
                    out.throttle = Some(slew(inp.lever, perf.lever_max, 0.35 * dt));
                }
                out.speedbrake = inp.speedbrake_cmd.then_some(false);
                if !perf.auto_flaps && inp.flaps_index != perf.takeoff_flaps && v < 10.0 {
                    out.flaps_index = Some(perf.takeoff_flaps);
                }
                if self.phase == Phase::TakeoffRoll {
                    if inp.ias_kt >= perf.v_rotate {
                        self.pitch_ramp = inp.pitch_deg;
                        self.set_phase(Phase::Rotate, Some("Rotate".into()));
                    } else if self.phase_time > 5.0 && inp.ias_kt < perf.v_rotate - 15.0 {
                        // Not enough runway left to reach rotation speed at this acceleration: reject.
                        let vr = perf.v_rotate * KT_TO_MS / inp.sigma.max(0.3).sqrt();
                        let need = (vr * vr - v * v).max(0.0) / (2.0 * self.gs_rate.max(0.3));
                        if along + need > length - 150.0 {
                            self.runway = self.departure.clone();
                            self.set_phase(Phase::Rollout, Some("Takeoff rejected — not enough runway remaining".into()));
                            return self.arrival_ground(inp, perf, dt);
                        }
                    }
                } else {
                    self.pitch_ramp = slew(self.pitch_ramp, perf.rotate_pitch_deg, perf.rotate_rate_dps * dt);
                    out.pitch_stick =
                        Some(rotation_stick(self.pitch_ramp, inp.pitch_deg, perf.rotate_rate_dps, inp.pitch_rate_max, inp.control_eff));
                }
            }
            _ => {}
        }
        if let Some(t) = speed_target {
            self.ground_speed_control(inp, perf, t, dt, &mut out);
        }
        self.target_heading = wrap_deg_360(course.to_degrees());
        self.target_speed_kt = if speed_target.is_some() { speed_target.unwrap_or(0.0) } else { perf.v_rotate };
        self.target_altitude_ft = self.cruise_alt_ft;
        out
    }

    /// Taxi speed: idle-to-light thrust, braking when too fast.
    fn ground_speed_control(&mut self, inp: &ApInputs, perf: &Perf, target_kt: f64, dt: f64, out: &mut ApOutput) {
        let gs_kt = inp.gs_ms * MS_TO_KT;
        let err = target_kt - gs_kt;
        let max_lever = if perf.jet { 0.35 } else { 0.55 };
        if err < -2.0 {
            out.throttle = Some(slew(inp.lever, 0.0, 0.5 * dt));
            out.brake = Some(((-err - 2.0) * 0.12).clamp(0.05, 0.6));
        } else {
            let rate = (0.03 * err - 0.08 * self.gs_rate * MS_TO_KT).clamp(-0.3, 0.3);
            out.throttle = Some((inp.lever + rate * dt).clamp(0.0, max_lever));
            out.brake = Some(0.0);
        }
    }

    // -----------------------------------------------------------------------
    // Landing rollout and stop
    // -----------------------------------------------------------------------

    fn arrival_ground(&mut self, inp: &ApInputs, perf: &Perf, dt: f64) -> ApOutput {
        let mut out = ApOutput::default();
        if self.phase == Phase::Stopped {
            out.parking_brake = (!inp.parking_brake).then_some(true);
            out.throttle = Some(0.0);
            out.brake = Some(0.0);
            out.reverse = Some(0.0);
            self.lateral = Lateral::None;
            return out;
        }
        if !inp.on_ground {
            // A real bounce (high, or long in the air) is a go-around; a skip settles at idle.
            let limit = if perf.jet { 10.0 } else { 8.0 };
            if self.phase == Phase::Rollout && (inp.agl_ft > limit || self.airborne_time > 3.0) && inp.ias_kt > perf.v_ref * 0.85 {
                self.go_around(inp, "bounced landing");
                return self.airborne(inp, perf, dt);
            }
            self.airborne_time += dt;
            let v = inp.speed_ms.max(20.0);
            self.vs_cmd = slew(self.vs_cmd, -perf.touchdown_sink_fpm, 600.0 * dt);
            let g = gamma_for_vs(self.vs_cmd, v).min((perf.flare_pitch_max_deg - inp.alpha_deg).to_radians());
            out.load_factor = Some(load_factor(g, inp.gamma, inp.roll_deg, v, 0.8, 1.3));
            out.roll_stick = Some(roll_stick_k(0.0, inp.roll_deg, inp.roll_rate_max, inp.control_eff, perf.roll_gain));
            out.throttle = Some(0.0);
            out.reverse = Some(0.0);
            out.speedbrake = (perf.speedbrakes && !inp.speedbrake_cmd).then_some(true);
            return out;
        }
        self.airborne_time = 0.0;
        let v = inp.gs_ms;
        let rwy = self.runway.as_ref().map(|r| (r.frame(inp.lat, inp.lon), r.course, r.length_m));
        let remaining = match rwy {
            Some(((along, cross), course, length)) => {
                self.lateral = Lateral::Centreline;
                let rel = angle_diff(inp.heading.to_radians(), course);
                let look = (2.5 * v).clamp(20.0, 220.0);
                let (ahead, right) = to_body(look, -cross, rel);
                out.steer = Some(pursuit_steer(ahead, right, v, perf.wheelbase_m));
                self.target_heading = wrap_deg_360(course.to_degrees());
                length - along
            }
            None => {
                self.lateral = Lateral::Heading;
                let err = wrap_deg_180(self.climbout_track - inp.heading).to_radians();
                out.steer = Some(pursuit_steer(60.0 * err.cos(), 60.0 * err.sin(), v, perf.wheelbase_m));
                1_000.0
            }
        };
        out.throttle = Some(slew(inp.lever, 0.0, 3.0 * dt));
        // Lower the nose wheel gently onto the runway.
        if self.phase_time < 0.05 {
            self.pitch_ramp = inp.pitch_deg;
        }
        let derotate = if perf.jet && !perf.aerobatic { 2.0 } else { 4.0 };
        self.pitch_ramp = slew(self.pitch_ramp, perf.rest_pitch_deg, derotate * dt);
        // Without spoilers to dump lift, raise the flaps so a gust cannot lift the aircraft off again.
        if !perf.speedbrakes && !perf.auto_flaps && inp.flaps_index > 0 {
            out.flaps_index = Some(0);
        }
        out.pitch_stick = Some(if inp.pitch_deg > perf.rest_pitch_deg + 0.3 {
            rotation_stick(self.pitch_ramp, inp.pitch_deg, 3.0, inp.pitch_rate_max, inp.control_eff).min(0.0)
        } else {
            0.0
        });
        let gs_kt = v * MS_TO_KT;
        out.reverse = Some(if perf.reversers && gs_kt > 60.0 && self.phase_time > 0.8 { 1.0 } else { 0.0 });
        // Speed brakes up for the rollout (they also stay out through a bounce).
        let want_sb = perf.speedbrakes && gs_kt > 40.0;
        out.speedbrake = (inp.speedbrake_cmd != want_sb).then_some(want_sb);
        if self.phase_time > 1.2 {
            // Autobrake: hold a deceleration, more if the runway is running out.
            let need = v * v / (2.0 * (remaining - 150.0).max(60.0));
            let target = perf.autobrake_ms2.max(need * 1.15).min(4.0);
            let decel = -self.gs_rate;
            if self.brake_cmd <= 0.0 {
                self.brake_cmd = (target / 4.0).clamp(0.1, 1.0);
            }
            self.brake_cmd = (self.brake_cmd + 0.5 * (target - decel) * dt).clamp(0.05, 1.0);
            if gs_kt < 8.0 {
                self.brake_cmd = self.brake_cmd.max(0.35);
            }
            out.brake = Some(self.brake_cmd);
        } else {
            out.brake = Some(0.0);
        }
        if v < 0.3 {
            let where_ = self.runway.as_ref().map(|r| format!(" on runway {} at {}", r.ident, r.airport)).unwrap_or_default();
            self.set_phase(Phase::Stopped, Some(format!("Landed and stopped{where_}. Press Z to take manual control")));
            out.parking_brake = Some(true);
        }
        self.target_speed_kt = 0.0;
        out
    }

    // -----------------------------------------------------------------------
    // Airborne phases
    // -----------------------------------------------------------------------

    fn airborne(&mut self, inp: &ApInputs, perf: &Perf, dt: f64) -> ApOutput {
        if inp.on_ground {
            match self.phase {
                Phase::Final | Phase::Flare | Phase::Approach => {
                    self.brake_cmd = 0.0;
                    self.set_phase(Phase::Rollout, Some("Touchdown — rollout".into()));
                    return self.arrival_ground(inp, perf, dt);
                }
                Phase::InitialClimb if inp.ias_kt < perf.v2 => {
                    self.set_phase(Phase::Rotate, None);
                    return self.departure_ground(inp, perf, dt);
                }
                _ => {}
            }
        }
        if self.target().is_some() {
            self.plan_runway(inp, perf, false);
        }
        let ctx = self.ctx(inp, perf);
        let cmd = match ctx {
            Some(ctx) => self.managed(inp, perf, &ctx, dt),
            None => self.unmanaged(inp, perf),
        };
        let mut out = self.fly(inp, perf, &cmd, dt);
        if inp.on_ground && matches!(self.phase, Phase::GoAround | Phase::InitialClimb) {
            // Touch-and-go: wheels on the runway with go-around power, rotate to fly away.
            self.pitch_ramp = slew(self.pitch_ramp.max(inp.pitch_deg - 1.0), perf.rotate_pitch_deg, perf.rotate_rate_dps * dt);
            out.pitch_stick = Some(rotation_stick(self.pitch_ramp, inp.pitch_deg, perf.rotate_rate_dps, inp.pitch_rate_max, inp.control_eff));
            out.brake = Some(0.0);
            out.reverse = Some(0.0);
            out.steer = Some(0.0);
        }
        out
    }

    /// Climb-out without a destination: runway heading up to the hold altitude, then hold.
    fn unmanaged(&mut self, inp: &ApInputs, perf: &Perf) -> Cmd {
        self.lateral = Lateral::RunwayTrack;
        let mut cmd = self.base_cmd(inp, perf);
        cmd.track = Some(self.climbout_track);
        let alt_err = self.cruise_alt_ft - inp.alt_msl_ft;
        match self.phase {
            Phase::InitialClimb => {
                self.initial_climb_vertical(inp, perf, &mut cmd);
                if inp.agl_ft >= perf.acceleration_agl_ft {
                    self.set_phase(Phase::Climb, Some("Climbing on runway heading".into()));
                }
            }
            _ => {
                cmd.speed = perf.v_climb_low.min(perf.v_cruise);
                cmd.vs = self.climb_vs(inp, perf, alt_err);
                cmd.flaps = self.retract_flaps(inp, perf);
                cmd.gear = self.gear(inp, perf, false);
                if alt_err.abs() < 150.0 {
                    self.target_heading = self.climbout_track.round();
                    self.target_altitude_ft = self.cruise_alt_ft;
                    self.target_speed_kt = cmd.speed;
                    self.vertical_speed_fpm = 1800.0;
                    self.set_phase(Phase::Hold, Some(format!("Holding runway heading at {} ft", self.cruise_alt_ft.round())));
                }
            }
        }
        cmd.alt_ft = self.cruise_alt_ft;
        cmd
    }

    fn base_cmd(&self, inp: &ApInputs, perf: &Perf) -> Cmd {
        Cmd {
            track: None,
            heading: Some(inp.heading),
            bank_limit: perf.bank_limit_deg,
            vs: 0.0,
            // Gentle vertical changes: about 0.1 g or less.
            vs_rate: 150.0,
            thrust: Thrust::Speed,
            speed: self.spd_cmd,
            alt_ft: self.cruise_alt_ft,
            pitch_max: perf.pitch_max_deg,
            // Passenger-comfort load factor limits; manoeuvres that need more
            // (go-around, terrain escape) widen them.
            n_min: 0.7,
            n_max: 1.3,
            k_gamma: K_GAMMA,
            track_gain: 1.4,
            roll_boost: 1.0,
            n_integral: false,
            gear: None,
            flaps: None,
            speedbrake: None,
        }
    }

    fn managed(&mut self, inp: &ApInputs, perf: &Perf, ctx: &Ctx, dt: f64) -> Cmd {
        let mut cmd = self.base_cmd(inp, perf);
        let alt = inp.alt_msl_ft;
        let pattern_ft = ctx.elev_ft + perf.pattern_height_m() * M_TO_FT;
        let prof_ft = self.profile_ft(ctx, perf).max(pattern_ft);
        let enroute_msa = self.msa_ft(inp, if perf.jet { 1500.0 } else { 1000.0 });

        // Lateral: route legs, except while climbing out and going around.
        let route_track = self.route_track(inp, ctx);
        cmd.track = Some(route_track);

        // Terrain: if the ground ahead comes within the clearance, climb away first.
        let terrain_phase = matches!(self.phase, Phase::Climb | Phase::Cruise | Phase::Descent)
            || (self.phase == Phase::Approach && self.leg != Leg::Localizer);
        if terrain_phase {
            let ahead = inp.terrain_ahead.unwrap_or(f64::MIN).max(inp.ground_h);
            let threat = inp.agl_ft < 400.0 || ahead > inp.wheels_h() - 120.0;
            if threat && self.escape_time <= 0.0 {
                self.say("TERRAIN — autopilot climbing");
            }
            if threat {
                self.escape_time = 12.0;
            }
        }
        if self.escape_time > 0.0 {
            self.escape_time -= dt;
            cmd.vs = perf.vs_climb_fpm;
            cmd.vs_rate = 600.0;
            cmd.n_max = 1.6;
            cmd.speed = perf.v_clean.max(self.spd_cmd.min(perf.v_climb_low));
            cmd.thrust = Thrust::Fixed { lever: perf.lever_max, rate: 0.6 };
            cmd.speedbrake = inp.speedbrake_cmd.then_some(false);
            cmd.bank_limit = 15.0;
            cmd.alt_ft = enroute_msa.max(alt);
            if self.target_altitude_ft < cmd.alt_ft && matches!(self.phase, Phase::Climb | Phase::Cruise | Phase::Descent) {
                self.cruise_alt_ft = self.cruise_alt_ft.max(((enroute_msa + 500.0) / 500.0).ceil() * 500.0);
            }
            return cmd;
        }

        match self.phase {
            Phase::InitialClimb => {
                self.lateral = Lateral::RunwayTrack;
                cmd.track = Some(self.climbout_track);
                self.initial_climb_vertical(inp, perf, &mut cmd);
                cmd.alt_ft = self.cruise_alt_ft;
                if inp.agl_ft >= perf.acceleration_agl_ft {
                    let next = if self.terminal_leg() { Phase::Approach } else { Phase::Climb };
                    self.set_phase(next, Some(format!("Climbing to {} ft", self.cruise_alt_ft.min(prof_ft.max(pattern_ft)).round())));
                }
            }
            Phase::Climb | Phase::Cruise => {
                let target = self.cruise_alt_ft.min(prof_ft).max(enroute_msa).max(pattern_ft);
                cmd.alt_ft = target;
                let high = if alt < 10_000.0 { perf.v_climb_low } else { perf.v_climb_high };
                let cruise_spd = self.cruise_speed_kt.unwrap_or(perf.v_cruise);
                cmd.speed = self.mach_capped(inp, perf, if self.phase == Phase::Cruise { cruise_spd } else { high.min(cruise_spd.max(perf.v_clean)) });
                if alt < 10_000.0 && perf.jet {
                    cmd.speed = cmd.speed.min(250f64.max(perf.v_clean + 10.0));
                }
                cmd.vs = if self.phase == Phase::Climb { self.climb_vs(inp, perf, target - alt) } else { ((target - alt) * 2.5).clamp(-1000.0, 1000.0) };
                cmd.flaps = self.retract_flaps(inp, perf);
                cmd.gear = self.gear(inp, perf, false);
                cmd.speedbrake = inp.speedbrake_cmd.then_some(false);
                if self.terminal_leg() {
                    self.set_phase(Phase::Approach, Some(format!("Approach — runway {}", self.runway_ident())));
                } else if self.phase == Phase::Climb && (alt - self.cruise_alt_ft).abs() < 150.0 {
                    self.set_phase(Phase::Cruise, Some(format!("Cruise at {} ft", self.cruise_alt_ft.round())));
                } else if prof_ft < alt - 500.0 && (self.phase == Phase::Cruise || self.phase_time > 20.0) {
                    self.set_phase(Phase::Descent, Some("Top of descent".into()));
                } else if self.phase == Phase::Cruise && self.cruise_alt_ft > alt + 300.0 && prof_ft > alt + 300.0 {
                    self.set_phase(Phase::Climb, None);
                }
            }
            Phase::Descent => {
                let target = prof_ft.max(enroute_msa).max(pattern_ft);
                cmd.alt_ft = target;
                let gs_fpm = inp.gs_ms * M_TO_FT * 60.0;
                let ff = if ctx.path_to_level > 0.0 && target < alt { -gs_fpm * GLIDESLOPE_DEG.to_radians().tan() } else { 0.0 };
                let mut vs = (ff + 2.5 * (target - alt)).clamp(-perf.vs_descent_fpm * 1.4, perf.vs_climb_fpm * 0.5);
                let mut spd = if alt < 11_000.0 && perf.jet { 250f64.min(perf.v_descent) } else { perf.v_descent };
                // Slow to manoeuvring speed for the approach once down on the profile
                // (without speed brakes there is no descending and slowing at once).
                let on_profile = alt - target < 1_000.0;
                if on_profile && ctx.path_to_level < if perf.jet { 25_000.0 } else { 6_000.0 } {
                    spd = spd.min(perf.v_clean + 10.0);
                }
                cmd.speed = self.mach_capped(inp, perf, spd);
                // Overspeed protection only: shallow the descent when well above the
                // target at idle, but keep coming down.
                let over = inp.ias_kt - (self.spd_cmd + 15.0).min(perf.v_limit - 5.0);
                if vs < 0.0 && over > 0.0 && inp.lever < 0.05 {
                    vs = (vs + 120.0 * over).min(-0.5 * perf.vs_descent_fpm).max(vs);
                }
                cmd.vs = vs;
                // In-flight speed brakes jolt the aircraft in this flight model, so the
                // autopilot manages energy with the descent path instead (and stows any
                // the pilot left out).
                cmd.speedbrake = inp.speedbrake_cmd.then_some(false);
                cmd.flaps = self.retract_flaps(inp, perf);
                if self.terminal_leg() || (ctx.dist < ctx.geo.terminal && ctx.path_to_level < 3_000.0) {
                    self.set_phase(Phase::Approach, Some(format!("Approach — runway {}", self.runway_ident())));
                }
            }
            Phase::Approach => self.approach(inp, perf, ctx, &mut cmd, pattern_ft),
            Phase::Final => self.final_approach(inp, perf, ctx, &mut cmd),
            Phase::Flare => self.flare(inp, perf, ctx, &mut cmd),
            Phase::GoAround => self.go_around_guidance(inp, perf, ctx, &mut cmd, pattern_ft),
            _ => {}
        }
        cmd
    }

    fn approach(&mut self, inp: &ApInputs, perf: &Perf, ctx: &Ctx, cmd: &mut Cmd, pattern_ft: f64) {
        // Weather beyond the landing limits: circle the field above pattern height.
        let weather = Self::landing_weather(inp, perf, ctx.course);
        if weather.is_some() != self.weather_hold {
            self.weather_hold = weather.is_some();
            match &weather {
                Some(why) => self.say(format!("{why} at {} — not landing; circling at {} ft. Take control or wait for better weather", self.runway.as_ref().map_or("", |r| r.airport.as_str()), (pattern_ft + 1000.0).round())),
                None => self.say("Weather within limits — continuing the approach"),
            }
        }
        if self.weather_hold && self.leg == Leg::Localizer && -ctx.along < ctx.geo.join {
            self.set_leg(Leg::Downwind);
            self.side = Self::pick_side(ctx.cross);
        }
        let speeds = perf.approach_speeds();
        let leg_speed = match self.leg {
            _ if self.weather_hold => speeds[0],
            Leg::Intercept => speeds[1],
            Leg::Localizer => speeds[2],
            _ => speeds[0],
        };
        cmd.speed = leg_speed;
        let msa = if self.leg == Leg::Localizer { f64::MIN } else { self.msa_ft(inp, 1000.0) };
        let hold_ft = if self.weather_hold { pattern_ft + 1000.0 } else { pattern_ft };
        let mut target_ft = hold_ft.max(msa);
        if self.leg == Leg::Localizer && ctx.h_thr > ctx.gs_h + 30.0 {
            // High on the approach: come down to the glidepath.
            target_ft = (ctx.elev_ft + ctx.gs_h * M_TO_FT).max(msa);
        }
        cmd.alt_ft = target_ft;
        let alt = inp.alt_msl_ft;
        cmd.vs = (2.5 * (target_ft - alt)).clamp(-perf.vs_descent_fpm, perf.vs_climb_fpm * 0.6);
        cmd.flaps = self.extend_flaps(inp, perf, perf.flaps_for_speed(leg_speed));
        let gs_alive = ctx.gs_h - ctx.h_thr < 60.0 || -ctx.along < ctx.geo.gs_intercept + 1_500.0;
        // Fast and unable to take more flap: the landing gear is the drag left.
        let fast = inp.ias_kt > leg_speed + 15.0 && inp.lever < 0.05 && matches!(self.leg, Leg::Intercept | Leg::Localizer);
        cmd.gear = self.gear(inp, perf, (self.leg == Leg::Localizer && gs_alive) || fast || inp.gear_down_cmd && self.leg == Leg::Localizer);
        if fast && cmd.vs < 0.0 {
            // Slow down before going down: a shallower descent lets the speed bleed off.
            cmd.vs = cmd.vs.max(-500.0);
        }
        cmd.speedbrake = inp.speedbrake_cmd.then_some(false);
        if self.leg == Leg::Localizer && ctx.along < ctx.aim && !self.weather_hold {
            // Capture the glideslope from below near the intercept point (after
            // levelling off to slow down and configure), or regardless inside the FAF.
            let near_intercept = -ctx.along < ctx.geo.gs_intercept + 2_000.0;
            if (ctx.h_thr <= ctx.gs_h + 15.0 && near_intercept) || -ctx.along < perf.faf_m {
                self.gate_checked = false;
                self.v_final = perf.v_app + Self::wind_additive(inp, perf, ctx.course);
                self.unstable_time = 0.0;
                self.set_phase(Phase::Final, Some(format!("Glideslope captured — final approach runway {}", self.runway_ident())));
            } else if -ctx.along < 1_500.0 {
                self.go_around(inp, "not established on the glidepath");
            }
        }
    }

    fn final_approach(&mut self, inp: &ApInputs, perf: &Perf, ctx: &Ctx, cmd: &mut Cmd) {
        if let Some(why) = Self::landing_weather(inp, perf, ctx.course) {
            return self.go_around(inp, &why.to_lowercase());
        }
        let gs_fpm = inp.gs_ms * M_TO_FT * 60.0;
        let ff = -gs_fpm * GLIDESLOPE_DEG.to_radians().tan();
        let corr = (6.0 * (ctx.gs_h - ctx.h_thr) * M_TO_FT).clamp(-800.0, 800.0);
        cmd.vs = (ff + corr).clamp(-perf.max_stable_sink_fpm * 1.1, 500.0);
        cmd.vs_rate = 400.0;
        cmd.alt_ft = ctx.elev_ft;
        self.v_final = perf.v_app + Self::wind_additive(inp, perf, ctx.course);
        cmd.speed = self.v_final;
        cmd.flaps = self.extend_flaps(inp, perf, perf.flap_count - 1);
        cmd.gear = self.gear(inp, perf, true);
        cmd.speedbrake = inp.speedbrake_cmd.then_some(false);
        let h_ref = self.height_ref_ft(inp, ctx);
        cmd.bank_limit = if h_ref < 50.0 { 5.0 } else if h_ref < 200.0 { 10.0 } else { perf.bank_limit_deg };
        cmd.n_min = 0.7;
        cmd.n_max = 1.35;
        cmd.k_gamma = 0.7;
        cmd.track_gain = 2.5;
        cmd.roll_boost = if h_ref < 100.0 { 1.5 } else { 1.0 };
        if h_ref < 500.0 {
            cmd.k_gamma = 0.9;
        }
        self.lateral = Lateral::Localizer;
        // Stabilized-approach criteria, from the stabilization height down to
        // 100 ft: a deviation must persist (not just a gust) to force a go-around.
        let gate = perf.stabilize_agl_ft;
        if h_ref <= gate && h_ref > 100.0 && self.since_engaged > 4.0 {
            self.gate_checked = true;
            let strict = h_ref > gate * 0.5;
            match self.unstable_reason(inp, perf, ctx, strict) {
                Some(why) => {
                    self.unstable_time += 1.0 / 120.0;
                    if self.unstable_time > 4.0 {
                        return self.go_around(inp, &why);
                    }
                }
                None => self.unstable_time = (self.unstable_time - 1.0 / 120.0).max(0.0),
            }
        }
        let misaligned = ctx.cross.abs() > (ctx.width * 0.5).max(15.0) || ctx.trk_err.abs() > 15f64.to_radians();
        if h_ref <= 100.0 && self.since_engaged > 3.0 && misaligned {
            return self.go_around(inp, "not aligned with the runway");
        }
        if h_ref <= 100.0 && inp.roll_deg.abs() > 20.0 {
            return self.go_around(inp, "bank angle near the ground");
        }
        // GPWS-style: a sink rate that would make the landing unsafe, caught while
        // there is still height to recover.
        let flare_ft = self.flare_height_ft(inp, perf);
        let expected_sink = gs_fpm * GLIDESLOPE_DEG.to_radians().tan();
        let excess_sink = -inp.vs_fpm - expected_sink;
        if h_ref < 300.0 && h_ref > flare_ft + 15.0 && excess_sink > 550.0 && self.since_engaged > 2.0 {
            return self.go_around(inp, "sink rate");
        }
        // A jet nose-down and sinking fast this low has no margin left for the flare.
        let nose_low = inp.pitch_deg < perf.rest_pitch_deg - 3.5;
        if perf.jet && h_ref < 200.0 && h_ref > flare_ft && nose_low && excess_sink > 250.0 && self.since_engaged > 2.0 {
            return self.go_around(inp, "sink rate");
        }
        if inp.agl_ft < 150.0 && ctx.along < -2_500.0 {
            return self.go_around(inp, "terrain on the approach path");
        }
        if h_ref <= self.flare_height_ft(inp, perf) && ctx.along > -800.0 {
            self.set_phase(Phase::Flare, Some("Flare".into()));
        }
    }

    fn flare(&mut self, inp: &ApInputs, perf: &Perf, ctx: &Ctx, cmd: &mut Cmd) {
        let h_ref = self.height_ref_ft(inp, ctx).max(0.0);
        let td = Self::touchdown_sink(inp, perf);
        let vs = -(60.0 * h_ref / perf.flare_tau_s + td);
        cmd.vs = vs.min(-0.5 * td);
        cmd.vs_rate = 900.0;
        cmd.alt_ft = ctx.elev_ft;
        cmd.speed = self.spd_cmd;
        // Retard to idle through the flare; in gusty air keep some power until the wheels are on.
        let gusty = inp.turbulence.clamp(0.0, 1.0);
        // Light aircraft close the throttle at the start of the flare and hold off.
        let base = if perf.jet { 0.08 } else { 0.6 };
        cmd.thrust = Thrust::Fixed { lever: 0.0, rate: base * (1.0 - 0.7 * gusty) };
        cmd.pitch_max = perf.flare_pitch_max_deg;
        cmd.bank_limit = 5.0;
        // Never push over hard in the flare: a float is settled gently.
        cmd.n_min = 0.93;
        cmd.n_max = 1.3;
        cmd.k_gamma = 1.0;
        if -inp.vs_fpm > 2.5 * td + 250.0 {
            // Sinking much faster than planned (gust): cushion with pitch and power.
            cmd.n_max = 1.5;
            cmd.thrust = Thrust::Fixed { lever: perf.lever_max * 0.7, rate: 1.0 };
        }
        cmd.track_gain = 2.5;
        cmd.roll_boost = 1.5;
        cmd.speedbrake = inp.speedbrake_cmd.then_some(false);
        self.lateral = Lateral::Localizer;
        // Land in the touchdown zone with room to stop, or go around.
        // In the flare a go-around cannot prevent the touchdown: level the wings.
        cmd.bank_limit = if inp.roll_deg.abs() > 8.0 { 0.0 } else { 5.0 };
        // Touchdown zone: the first third of the runway past the aim point (at least 450 m).
        let td_limit = ctx.aim + ((ctx.length - ctx.aim) / 3.0).max(450.0);
        let v = inp.gs_ms;
        let stop = v * v / (2.0 * perf.autobrake_ms2 * 1.4) + 100.0;
        if h_ref > 3.0 && (ctx.along > td_limit || ctx.length - ctx.along < stop) {
            return self.go_around(inp, "long landing");
        }
        if self.phase_time > 15.0 {
            self.go_around(inp, "floated in the flare");
        }
    }

    /// Why the weather rules out a landing on this runway, if it does.
    fn landing_weather(inp: &ApInputs, perf: &Perf, course: f64) -> Option<String> {
        if inp.turbulence >= SEVERE_TURBULENCE {
            return Some("Severe turbulence".into());
        }
        if inp.gust_ms > perf.max_gust_ms {
            return Some("Gusts too strong for an automatic landing".into());
        }
        let (head, cross) = inp.wind().components(course);
        if cross.abs() > perf.crosswind_limit_kt + 5.0 {
            return Some(format!("Crosswind {} kt", cross.abs().round()));
        }
        if -head > perf.tailwind_limit_kt + 5.0 {
            return Some(format!("Tailwind {} kt", (-head).round()));
        }
        None
    }

    /// Approach speed additive: half the steady headwind plus a gust allowance.
    fn wind_additive(inp: &ApInputs, perf: &Perf, course: f64) -> f64 {
        let (head, _) = inp.wind().components(course);
        let gust = inp.turbulence.clamp(0.0, 1.0) * if perf.jet { 8.0 } else { 6.0 };
        let half = if perf.jet { 0.5 } else { 0.25 };
        (half * head.max(0.0) + gust).min(if perf.jet { 10.0 } else { 5.0 })
    }

    fn go_around(&mut self, inp: &ApInputs, why: &str) {
        let weather = inp.turbulence >= SEVERE_TURBULENCE || ["crosswind", "tailwind", "gusts"].iter().any(|w| why.starts_with(w));
        if !weather {
            self.go_arounds += 1;
        }
        self.escape_time = 0.0;
        self.set_phase(Phase::GoAround, Some(format!("Go-around: {why}")));
    }

    fn go_around_guidance(&mut self, inp: &ApInputs, perf: &Perf, ctx: &Ctx, cmd: &mut Cmd, pattern_ft: f64) {
        let ga_ft = (pattern_ft + 500.0).max(ctx.elev_ft + 1500.0).max(self.msa_ft(inp, 1000.0));
        cmd.alt_ft = ga_ft;
        if self.phase_time < 20.0 || ctx.h_thr < 120.0 {
            cmd.track = Some(wrap_deg_360(ctx.course.to_degrees()));
            self.lateral = Lateral::RunwayTrack;
        }
        let alt = inp.alt_msl_ft;
        let near_level = alt > ga_ft - 300.0;
        cmd.speed = (perf.v_app + 15.0).max(perf.v2);
        if near_level {
            cmd.vs = (2.5 * (ga_ft - alt)).clamp(-500.0, perf.vs_climb_fpm);
            cmd.thrust = Thrust::Speed;
        } else {
            self.initial_climb_vertical(inp, perf, cmd);
            cmd.vs = cmd.vs.max(500.0);
        }
        // Arrest the descent quickly near the ground, then settle into the climb.
        let early = self.phase_time < 6.0;
        cmd.vs_rate = if early { 1500.0 } else { 500.0 };
        if early {
            cmd.n_max = 1.6;
            cmd.k_gamma = 0.8;
            if inp.agl_ft < 100.0 {
                cmd.roll_boost = 1.5;
                cmd.bank_limit = 5.0;
            }
        }
        if !perf.auto_flaps && inp.flaps_index > perf.takeoff_flaps {
            cmd.flaps = Some(perf.takeoff_flaps);
        }
        cmd.gear = self.gear(inp, perf, !(inp.vs_fpm > 300.0 && inp.agl_ft > 100.0));
        cmd.speedbrake = inp.speedbrake_cmd.then_some(false);
        if near_level && self.phase_time > 20.0 {
            if self.go_arounds >= GA_MAX {
                self.target_heading = inp.heading.round();
                self.target_altitude_ft = (ga_ft / 100.0).round() * 100.0;
                self.target_speed_kt = perf.v_clean;
                self.vertical_speed_fpm = 1500.0;
                self.set_phase(Phase::Hold, Some(format!("Unable to land after {GA_MAX} attempts — holding; please take control")));
            } else {
                self.runway_locked = false;
                self.plan_runway(inp, perf, true);
                self.leg = Leg::None;
                self.set_phase(Phase::Approach, Some(format!("Re-entering the approach — runway {}", self.runway_ident())));
            }
        }
    }

    /// Initial climb / go-around: fixed takeoff thrust, pitch holds the climb speed.
    fn initial_climb_vertical(&mut self, inp: &ApInputs, perf: &Perf, cmd: &mut Cmd) {
        let v = inp.speed_ms.max(20.0);
        let target = if self.phase == Phase::GoAround { (perf.v_app + 15.0).max(perf.v2) } else { perf.v2 + 5.0 };
        let sq = inp.sigma.max(0.2).sqrt();
        let accel = self.ias_rate * KT_TO_MS / sq;
        let gamma = speed_on_pitch_gamma(inp.gamma, accel, inp.ias_kt * KT_TO_MS / sq, target * KT_TO_MS / sq);
        let vs_max = if self.phase == Phase::GoAround { perf.vs_climb_fpm } else { perf.vs_initial_climb_fpm };
        let g_max = gamma_for_vs(vs_max, v).min((perf.pitch_max_deg - inp.alpha_deg).to_radians());
        let g = gamma.clamp(1.5f64.to_radians().min(g_max), g_max);
        cmd.vs = v * g.sin() * M_TO_FT * 60.0;
        cmd.vs_rate = 500.0;
        cmd.speed = target;
        // Climb thrust once the climb rate limit leaves energy to spare.
        cmd.thrust = if inp.ias_kt > target + 12.0 && gamma > g_max { Thrust::Speed } else { Thrust::Fixed { lever: perf.lever_max, rate: 0.5 } };
        cmd.gear = self.gear(inp, perf, !(inp.vs_fpm > 200.0 && inp.agl_ft > 30.0));
    }

    fn climb_vs(&self, inp: &ApInputs, perf: &Perf, alt_err: f64) -> f64 {
        let climb = perf.vs_climb_fpm * (1.0 - 0.55 * (inp.alt_msl_ft / perf.max_alt_ft).clamp(0.0, 1.0));
        let mut vs = (alt_err * 2.5).clamp(-perf.vs_descent_fpm, climb);
        // Speed protection: give up climb rate rather than speed.
        let short = self.spd_cmd - 5.0 - inp.ias_kt;
        if short > 0.0 {
            vs -= 150.0 * short;
        }
        if alt_err > 300.0 {
            let floor: f64 = if perf.jet { 500.0 } else { 150.0 };
            vs = vs.max(floor.min(climb));
        }
        vs
    }

    fn mach_capped(&self, inp: &ApInputs, perf: &Perf, kias: f64) -> f64 {
        match perf.mach_cap {
            Some(m) if inp.speed_of_sound > 0.0 => kias.min(m * inp.speed_of_sound * inp.sigma.sqrt() * MS_TO_KT).max(perf.v_clean),
            _ => kias,
        }
    }

    fn retract_flaps(&mut self, inp: &ApInputs, perf: &Perf) -> Option<usize> {
        if perf.auto_flaps || inp.flaps_index == 0 || self.flap_timer < 3.0 {
            return None;
        }
        let next = inp.flaps_index - 1;
        if inp.ias_kt >= perf.min_speed_for_flaps(next) - 2.0 && inp.agl_ft > 400.0 {
            self.flap_timer = 0.0;
            return Some(next);
        }
        None
    }

    fn extend_flaps(&mut self, inp: &ApInputs, perf: &Perf, target: usize) -> Option<usize> {
        if perf.auto_flaps || inp.flaps_index >= target || self.flap_timer < 3.0 {
            return None;
        }
        let next = inp.flaps_index + 1;
        if inp.ias_kt <= perf.flap_extend_limit(next) {
            self.flap_timer = 0.0;
            return Some(next);
        }
        None
    }

    fn gear(&self, inp: &ApInputs, perf: &Perf, down: bool) -> Option<bool> {
        if !perf.retractable_gear || inp.gear_down_cmd == down {
            None
        } else {
            Some(down)
        }
    }

    /// Minimum safe altitude (ft MSL) over the terrain below and ahead.
    fn msa_ft(&self, inp: &ApInputs, clearance_ft: f64) -> f64 {
        let ground = inp.terrain_ahead.map_or(inp.ground_h, |t| t.max(inp.ground_h));
        (ground - inp.geoid) * M_TO_FT + clearance_ft
    }

    /// Touchdown sink rate to aim for (fpm): firmer in gusty air so the aircraft
    /// does not float and get dropped by a gust.
    fn touchdown_sink(inp: &ApInputs, perf: &Perf) -> f64 {
        perf.touchdown_sink_fpm + inp.turbulence.clamp(0.0, 1.0) * if perf.jet { 250.0 } else { 150.0 }
    }

    /// Flare height (ft) for the current sink rate.
    fn flare_height_ft(&self, inp: &ApInputs, perf: &Perf) -> f64 {
        let sink = (-inp.vs_fpm).max(0.0);
        let h = (sink - Self::touchdown_sink(inp, perf)).max(0.0) * perf.flare_tau_s / 60.0;
        if perf.jet { h.clamp(15.0, 60.0) } else { h.clamp(8.0, 25.0) }
    }

    /// Height used for the flare: the radio altimeter over the runway, the
    /// lower of radio and threshold height on short final.
    fn height_ref_ft(&self, inp: &ApInputs, ctx: &Ctx) -> f64 {
        let thr = ctx.h_thr * M_TO_FT;
        if ctx.along > -400.0 { inp.agl_ft } else { inp.agl_ft.min(thr) }
    }

    fn unstable_reason(&self, inp: &ApInputs, perf: &Perf, ctx: &Ctx, strict: bool) -> Option<String> {
        if perf.retractable_gear && inp.gear < 0.99 {
            return Some("gear not down".into());
        }
        if !perf.auto_flaps && inp.flaps_index + 1 < perf.flap_count {
            return Some("not in landing configuration".into());
        }
        let v_tgt = if self.v_final > 0.0 { self.v_final } else { perf.v_app };
        let (fast, slow) = if strict { (20.0, 7.0) } else { (25.0, 12.0) };
        if self.ias_filt > v_tgt + fast {
            return Some("too fast".into());
        }
        if self.ias_filt < v_tgt - slow {
            return Some("too slow".into());
        }
        let gs_dev = ctx.h_thr.atan2((ctx.aim - ctx.along).max(1.0)).to_degrees() - GLIDESLOPE_DEG;
        let gs_lim = if strict { 0.6 } else { 0.8 };
        if gs_dev.abs() > gs_lim && inp.agl_ft > 150.0 {
            return Some(if gs_dev > 0.0 { "high on the glidepath" } else { "low on the glidepath" }.into());
        }
        let loc_dev = ctx.cross.abs().atan2((ctx.length - ctx.along).max(1.0)).to_degrees();
        let loc_lim = if strict { 1.9 } else { 2.5 };
        if loc_dev > loc_lim && ctx.cross.abs() > 25.0 {
            return Some("off the runway centreline".into());
        }
        if self.sink_filt > perf.max_stable_sink_fpm * if strict { 1.0 } else { 1.15 } {
            return Some("sink rate".into());
        }
        if self.roll_filt.abs() > 20.0 {
            return Some("bank angle".into());
        }
        None
    }

    /// Applies a guidance command through the inner loops.
    fn fly(&mut self, inp: &ApInputs, perf: &Perf, cmd: &Cmd, dt: f64) -> ApOutput {
        let mut out = ApOutput::default();
        // Lateral: track (ground path) when moving over the ground, else heading.
        let bank_target = match (cmd.track, cmd.heading) {
            (Some(t), _) if inp.gs_ms > 20.0 => bank_for_error_k(t - inp.track, cmd.track_gain, cmd.bank_limit),
            (Some(t), _) | (None, Some(t)) => bank_for_error_k(t - inp.heading, cmd.track_gain, cmd.bank_limit),
            _ => 0.0,
        };
        let bank_target = bank_target.clamp(-cmd.bank_limit, cmd.bank_limit);
        self.bank_cmd = slew(self.bank_cmd, bank_target, perf.bank_rate_dps * dt);
        let roll_k = (perf.roll_gain * cmd.roll_boost).min(4.5);
        out.roll_stick = Some(roll_stick_k(self.bank_cmd, inp.roll_deg, inp.roll_rate_max, inp.control_eff, roll_k));
        // Vertical: rate-limited vertical speed -> flight path -> load factor.
        self.vs_cmd = slew(self.vs_cmd, cmd.vs, cmd.vs_rate * dt);
        let v = inp.speed_ms.max(20.0);
        let g_max = (cmd.pitch_max - inp.alpha_deg).to_radians();
        let g_min = (-10.0 - inp.alpha_deg).to_radians();
        let gamma_cmd = gamma_for_vs(self.vs_cmd, v).clamp(g_min.min(g_max), g_max);
        // Feed forward how fast the commanded path is changing (smooth flare, captures).
        let raw_rate = self.gamma_cmd.map_or(0.0, |g| (gamma_cmd - g) / dt);
        self.gamma_rate = lowpass(self.gamma_rate, raw_rate.clamp(-0.2, 0.2), 0.3, dt);
        self.gamma_cmd = Some(gamma_cmd);
        let mut n = load_factor_k(gamma_cmd, inp.gamma, self.gamma_rate, inp.roll_deg, v, cmd.n_min, cmd.n_max, cmd.k_gamma);
        if cmd.n_integral {
            // Gusts that knock the angle of attack away are trimmed out against
            // the measured load factor rather than just waited out.
            self.n_int = (self.n_int + (self.n_last - inp.nz) * dt * 1.5).clamp(-0.12, 0.2);
            n = (n + self.n_int).clamp(cmd.n_min, cmd.n_max);
        } else {
            self.n_int = 0.0;
        }
        self.n_last = n;
        out.load_factor = Some(n);
        // Speed target ramps so thrust changes stay gentle. With the thrust set
        // (takeoff, go-around, idle) it follows the actual speed so the
        // autothrottle picks up from there without a jump.
        match cmd.thrust {
            Thrust::Fixed { .. } => self.spd_cmd = inp.ias_kt,
            Thrust::Speed => {
                let rate = if cmd.speed > self.spd_cmd { 1.5 } else { 1.0 };
                self.spd_cmd = slew(self.spd_cmd, cmd.speed.min(perf.v_limit), rate * dt);
            }
        }
        if self.autothrottle {
            out.throttle = Some(match cmd.thrust {
                Thrust::Speed => autothrottle(inp.lever, self.spd_cmd, self.ias_filt, self.ias_rate, perf.lever_max, dt),
                Thrust::Fixed { lever, rate } => slew(inp.lever, lever, rate * dt),
            });
        }
        out.gear_down = cmd.gear;
        out.flaps_index = cmd.flaps;
        out.speedbrake = cmd.speedbrake;
        self.target_heading = wrap_deg_360(cmd.track.or(cmd.heading).unwrap_or(inp.heading));
        self.target_altitude_ft = cmd.alt_ft;
        self.target_speed_kt = self.spd_cmd;
        self.vertical_speed_fpm = self.vs_cmd;
        out
    }

    // -----------------------------------------------------------------------
    // Route geometry
    // -----------------------------------------------------------------------

    fn runway_ident(&self) -> String {
        self.runway.as_ref().map(|r| r.ident.clone()).unwrap_or_default()
    }

    fn terminal_leg(&self) -> bool {
        matches!(self.leg, Leg::Downwind | Leg::Intercept | Leg::Localizer)
    }

    fn ctx(&self, inp: &ApInputs, perf: &Perf) -> Option<Ctx> {
        let rw = self.runway.as_ref()?;
        let geo = self.geom.unwrap_or_else(|| ApproachGeometry::new(perf, rw));
        let (along, cross) = rw.frame(inp.lat, inp.lon);
        let mut ctx = Ctx {
            along,
            cross,
            dist: along.hypot(cross),
            course: rw.course,
            trk_err: angle_diff(inp.track.to_radians(), rw.course),
            h_thr: inp.wheels_h() - rw.elevation_m,
            gs_h: rw.glidepath_height(along),
            elev_ft: rw.elevation_ft_msl(),
            length: rw.length_m,
            width: rw.width_m,
            aim: rw.aim_along(),
            geo,
            path_total: 0.0,
            path_to_level: 0.0,
        };
        let (total, to_level) = self.path_estimate(&ctx, perf);
        ctx.path_total = total;
        ctx.path_to_level = to_level;
        Some(ctx)
    }

    /// Remaining path to the runway and the distance to where the aircraft
    /// should be down at pattern height (both m), for the current leg.
    fn path_estimate(&self, ctx: &Ctx, perf: &Perf) -> (f64, f64) {
        let g = &ctx.geo;
        let (a, c) = (ctx.along, ctx.cross);
        // Level off at pattern height early enough to slow to approach speed at idle.
        let level_before = g.gs_intercept + perf.decel_distance_m();
        let leg = if self.leg == Leg::None { self.initial_leg(ctx) } else { self.leg };
        match leg {
            Leg::Localizer | Leg::Intercept => {
                let total = (-a).max(0.0) + 0.5 * c.abs();
                (total, total - level_before)
            }
            Leg::DirectFinal | Leg::None => {
                let (ea, ec) = g.final_entry();
                let d = (a - ea).hypot(c - ec);
                let dir = (ec - c).atan2(ea - a);
                let total = d + nav::turn_distance(g.radius, dir) + (-ea);
                (total, total - level_before)
            }
            Leg::DirectDownwind => {
                let (ea, ec) = g.downwind_entry(self.side);
                let d = (a - ea).hypot(c - ec);
                let base = -g.base_turn_along();
                (d + base + PI * g.radius + base, d)
            }
            Leg::Downwind => {
                let base = -g.base_turn_along();
                let remaining = (a + base).max(0.0);
                (remaining + (c - self.side * g.downwind_offset).abs() + PI * g.radius + base, 0.0)
            }
        }
    }

    /// Descent profile altitude (ft MSL) at the current path distance.
    fn profile_ft(&self, ctx: &Ctx, perf: &Perf) -> f64 {
        ctx.elev_ft + (perf.pattern_height_m() + ctx.path_to_level.max(0.0) * GLIDESLOPE_DEG.to_radians().tan()) * M_TO_FT
    }

    /// Leg to start with from a position (no history).
    fn initial_leg(&self, ctx: &Ctx) -> Leg {
        let g = &ctx.geo;
        let in_sector = ApproachGeometry::in_straight_in_sector(ctx.along, ctx.cross);
        if ctx.dist > g.terminal {
            if in_sector { Leg::DirectFinal } else { Leg::DirectDownwind }
        } else if g.straight_in_ok(ctx.along, ctx.cross, false) {
            Leg::Intercept
        } else {
            Leg::Downwind
        }
    }

    fn pick_side(cross: f64) -> f64 {
        if cross.abs() > 100.0 { cross.signum() } else { -1.0 }
    }

    fn set_leg(&mut self, leg: Leg) {
        if leg != self.leg {
            self.leg = leg;
            self.leg_time = 0.0;
        }
    }

    /// Updates the approach leg (with hysteresis) and returns the track to fly (degrees).
    fn route_track(&mut self, inp: &ApInputs, ctx: &Ctx) -> f64 {
        let g = ctx.geo;
        let (a, c) = (ctx.along, ctx.cross);
        let in_sector = ApproachGeometry::in_straight_in_sector(a, c);
        // Lock the runway choice once inside the terminal area.
        if !self.runway_locked && ctx.dist < g.terminal {
            self.runway_locked = true;
        }
        let can_change = self.leg_time >= LEG_HOLD_S;
        let next = match self.leg {
            Leg::Localizer => Leg::Localizer,
            Leg::None => {
                let l = self.initial_leg(ctx);
                if matches!(l, Leg::DirectDownwind | Leg::Downwind) {
                    self.side = Self::pick_side(c);
                }
                l
            }
            Leg::DirectFinal => {
                let (ea, ec) = g.final_entry();
                let near_entry = (a - ea).hypot(c - ec) < 2.5 * g.radius;
                if ctx.dist < g.terminal && (g.straight_in_ok(a, c, false) || near_entry) {
                    Leg::Intercept
                } else if ctx.dist > g.terminal + 5_000.0 && !in_sector {
                    self.side = Self::pick_side(c);
                    Leg::DirectDownwind
                } else {
                    Leg::DirectFinal
                }
            }
            Leg::DirectDownwind => {
                if ctx.dist < g.terminal {
                    Leg::Downwind
                } else if in_sector && ctx.dist > g.terminal + 5_000.0 {
                    Leg::DirectFinal
                } else {
                    Leg::DirectDownwind
                }
            }
            Leg::Downwind => {
                if -a >= -g.base_turn_along() {
                    Leg::Intercept
                } else {
                    Leg::Downwind
                }
            }
            Leg::Intercept => {
                let est = c.abs() < 400.0 && ctx.trk_err.abs() < 45f64.to_radians();
                if !g.straight_in_ok(a, c, true) && !est {
                    self.side = Self::pick_side(c);
                    Leg::Downwind
                } else {
                    Leg::Intercept
                }
            }
        };
        if next != self.leg && (can_change || self.leg == Leg::None) {
            self.set_leg(next);
        }
        if self.leg == Leg::Intercept && a < 0.0 && established(c, ctx.trk_err) {
            self.set_leg(Leg::Localizer);
        }

        // Convergence time for the path-following fields: slow enough for the
        // bank-limited turn rate at this speed.
        let v = inp.gs_ms.max(30.0);
        let tight = matches!(self.phase, Phase::Final | Phase::Flare);
        let gain = if tight { 2.5 } else { 1.4 };
        let inner = v / (crate::atmosphere::G0 * gain);
        let tau = (3.0 * inner).max(if tight { 7.0 } else { 15.0 });
        let k = 1.0 / (v * tau);
        let track = match self.leg {
            Leg::DirectFinal | Leg::None => {
                self.lateral = Lateral::Direct;
                let (ea, ec) = g.final_entry();
                let (la, lo) = self.runway.as_ref().map_or((inp.lat, inp.lon), |r| r.point(ea, ec));
                bearing_to(inp.lat, inp.lon, la, lo)
            }
            Leg::DirectDownwind => {
                self.lateral = Lateral::Direct;
                let (ea, ec) = g.downwind_entry(self.side);
                let (la, lo) = self.runway.as_ref().map_or((inp.lat, inp.lon), |r| r.point(ea, ec));
                bearing_to(inp.lat, inp.lon, la, lo)
            }
            Leg::Downwind => {
                self.lateral = Lateral::Downwind;
                let cross_dw = -(c - self.side * g.downwind_offset);
                line_track(ctx.course + PI, cross_dw, k, CHI_DOWNWIND)
            }
            Leg::Intercept => {
                self.lateral = Lateral::Intercept;
                line_track(ctx.course, c, k, 60f64.to_radians())
            }
            Leg::Localizer => {
                self.lateral = Lateral::Localizer;
                line_track(ctx.course, c, k, 30f64.to_radians())
            }
        };
        wrap_deg_360(track.to_degrees())
    }
}

impl RunwayGeom {
    /// Threshold elevation in feet MSL.
    pub fn elevation_ft_msl(&self) -> f64 {
        (self.elevation_m - crate::world::geoid_undulation(self.lat, self.lon)) * M_TO_FT
    }
}

