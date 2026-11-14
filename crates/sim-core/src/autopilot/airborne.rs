//! Airborne autopilot guidance and the control loops that turn it into pilot inputs.

use crate::geo::{wrap_deg_360, KT_TO_MS, MS_TO_KT, M_TO_FT};

use super::control::{
    autothrottle, bank_for_error_k, gamma_for_vs, load_factor_k, lowpass, roll_stick_k, rotation_stick,
    slew, speed_on_pitch_gamma, K_GAMMA,
};
use super::perf::GLIDESLOPE_DEG;
use super::route::{Ctx, Leg};
use super::{ApInputs, ApOutput, Autopilot, Lateral, Perf, Phase};

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

const GA_MAX: u32 = 3;
/// Turbulence intensity (0..1) at and above which the autopilot will not land.
const SEVERE_TURBULENCE: f64 = 0.7;

impl Autopilot {
    pub(super) fn airborne(&mut self, inp: &ApInputs, perf: &Perf, dt: f64) -> ApOutput {
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
    pub(super) fn landing_weather(inp: &ApInputs, perf: &Perf, course: f64) -> Option<String> {
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
    pub(super) fn wind_additive(inp: &ApInputs, perf: &Perf, course: f64) -> f64 {
        let (head, _) = inp.wind().components(course);
        let gust = inp.turbulence.clamp(0.0, 1.0) * if perf.jet { 8.0 } else { 6.0 };
        let half = if perf.jet { 0.5 } else { 0.25 };
        (half * head.max(0.0) + gust).min(if perf.jet { 10.0 } else { 5.0 })
    }

    pub(super) fn go_around(&mut self, inp: &ApInputs, why: &str) {
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
    pub(super) fn flare_height_ft(&self, inp: &ApInputs, perf: &Perf) -> f64 {
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
}
