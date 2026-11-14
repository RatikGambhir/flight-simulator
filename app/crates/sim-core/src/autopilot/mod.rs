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

mod airborne;
pub mod control;
mod ground;
pub mod nav;
pub mod perf;
mod route;
#[cfg(test)]
mod tests;

use crate::aircraft::AircraftSpec;
use crate::geo::{wrap_deg_180, wrap_deg_360, M_TO_FT};
use crate::protocol::{AutopilotCommand, ControlInput};

use control::{autothrottle, bank_for_heading_error, gamma_for_vs, load_factor, lowpass, roll_stick, slew};
pub use nav::{NavTarget, RunwayGeom, Wind};
use nav::{choose_landing_runway, choose_takeoff_runway, distance_m, established, runway_under, ApproachGeometry};
pub use perf::Perf;
use route::{Ctx, Leg, LEG_HOLD_S};

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
}

impl RunwayGeom {
    /// Threshold elevation in feet MSL.
    pub fn elevation_ft_msl(&self) -> f64 {
        (self.elevation_m - crate::world::geoid_undulation(self.lat, self.lon)) * M_TO_FT
    }
}

