//! Pilot-selected heading, altitude and speed, including the Blackbird's
//! transition from a climb scheduled in equivalent airspeed to Mach hold.

use crate::aircraft::{AircraftSpec, BLACKBIRD_CRUISE_MACH};
use crate::atmosphere::{isa, G0, RHO_SL};
use crate::engine;
use crate::geo::{wrap_deg_360, EARTH_MEAN_RADIUS, FT_TO_M, KT_TO_MS, MPH_TO_MS, MS_TO_KT, M_TO_FT};
use crate::protocol::{AutopilotCommand, FlightTargets, TargetSpeed};
use crate::weather::wind_profile_factor;

use super::control::{
    autothrottle, bank_for_heading_error, gamma_for_vs, load_factor, roll_stick, slew,
};
use super::{ApInputs, ApOutput, Autopilot, Lateral, Perf, Phase};

const BLACKBIRD_CLIMB_KEAS: f64 = 410.0;

fn mach_limit(spec: &AircraftSpec, perf: &Perf) -> Option<f64> {
    if spec.id == "sr71" {
        Some(BLACKBIRD_CRUISE_MACH)
    } else {
        perf.mach_cap
    }
}

fn validate(
    mut targets: FlightTargets,
    inp: &ApInputs,
    spec: &AircraftSpec,
    perf: &Perf,
) -> Result<FlightTargets, String> {
    if !targets.heading.is_finite() || !targets.altitude_ft.is_finite() {
        return Err("Enter a heading and altitude".into());
    }
    if !(0.0..=spec.max_alt_ft).contains(&targets.altitude_ft) {
        return Err("Selected altitude is outside this aircraft's range".into());
    }
    targets.heading = wrap_deg_360(targets.heading);
    if matches!(targets.speed, TargetSpeed::Mach(m) if spec.id != "sr71" || !(0.1..=BLACKBIRD_CRUISE_MACH).contains(&m))
    {
        return Err("Select a Mach target up to 3.20 in the Blackbird".into());
    }
    if matches!(targets.speed, TargetSpeed::GroundMph(mph) if !mph.is_finite() || mph <= 0.0) {
        return Err("Enter a positive ground speed in MPH".into());
    }
    if spec.id == "sr71" && targets.altitude_ft > spec.cruise_alt_ft {
        // Look for the highest 500-foot level with thrust in reserve. This
        // uses the same clean drag and full-afterburner thrust as the model.
        let mut candidate = targets;
        loop {
            if check_speed(candidate, inp, spec, perf, true).is_ok() {
                return Ok(candidate);
            }
            if candidate.altitude_ft <= spec.cruise_alt_ft {
                if matches!(targets.speed, TargetSpeed::GroundMph(_)) {
                    check_speed(targets, inp, spec, perf, false)?;
                }
                return Err("Blackbird cannot sustain that speed at high altitude".into());
            }
            candidate.altitude_ft = (((candidate.altitude_ft - 1.0) / 500.0).floor() * 500.0)
                .max(spec.cruise_alt_ft);
        }
    }
    check_speed(targets, inp, spec, perf, false)?;
    Ok(targets)
}

fn check_speed(
    targets: FlightTargets,
    inp: &ApInputs,
    spec: &AircraftSpec,
    perf: &Perf,
    check_thrust: bool,
) -> Result<(), String> {
    let altitude_m = targets.altitude_ft * FT_TO_M + spec.belly_height_m;
    let air = isa(altitude_m);
    let equivalent_knots_per_ms = (air.density / RHO_SL).sqrt() * MS_TO_KT;
    let knots_per_mach = air.speed_of_sound * equivalent_knots_per_ms;
    let max_kt = mach_limit(spec, perf).map_or(perf.v_limit, |m| perf.v_limit.min(m * knots_per_mach));
    // Allow half a knot for rounded speed targets.
    let speed_range = (perf.v_clean - 0.5)..=(max_kt + 0.5);
    let speed_kt = match targets.speed {
        TargetSpeed::Knots(kt) => kt,
        TargetSpeed::Mach(m) => m * knots_per_mach,
        TargetSpeed::GroundMph(mph) => {
            let agl = altitude_m + inp.geoid - inp.ground_h;
            let wind = inp.wind_kt * KT_TO_MS * wind_profile_factor(agl);
            let (cross, head) = (inp.wind_from_deg - targets.heading).to_radians().sin_cos();
            let crosswind = wind * cross;
            let headwind = wind * head;
            let forward_ground_ms = |kt: f64| kt / equivalent_knots_per_ms - headwind;
            let altitude = targets.altitude_ft;
            if forward_ground_ms(*speed_range.end()) < 0.0 {
                return Err(format!("No forward ground speed is available at {altitude:.0} ft with this heading and wind."));
            }
            // With heading fixed, a crosswind contributes to ground speed as well as drift.
            let ground_mph = |kt| forward_ground_ms(kt).max(0.0).hypot(crosswind) / MPH_TO_MS;
            let min_mph = ground_mph(*speed_range.start());
            let max_mph = ground_mph(*speed_range.end());
            if mph < min_mph {
                return Err(format!("{mph:.0} MPH is too slow at {altitude:.0} ft. Minimum {:.0} MPH for this heading and wind. Lower the altitude or raise the speed.", min_mph.ceil()));
            }
            if mph > max_mph {
                return Err(format!("{mph:.0} MPH is too fast at {altitude:.0} ft. Maximum {:.0} MPH for this heading and wind.", max_mph.floor()));
            }
            let forward_ground_ms = ((mph * MPH_TO_MS).powi(2) - crosswind.powi(2)).max(0.0).sqrt();
            (forward_ground_ms + headwind) * equivalent_knots_per_ms
        }
    };
    if !matches!(targets.speed, TargetSpeed::GroundMph(_)) && !speed_range.contains(&speed_kt) {
        return Err("Selected speed is outside this aircraft's range at that altitude".into());
    }
    if !check_thrust {
        return Ok(());
    }
    let mach = speed_kt / knots_per_mach;
    let q_area = 0.5 * RHO_SL * (speed_kt * KT_TO_MS).powi(2) * spec.wing_area_m2;
    let required_lift = spec.mass_kg
        * (G0 - (mach * air.speed_of_sound).powi(2) / (EARTH_MEAN_RADIUS + altitude_m));
    let cl = required_lift / q_area;
    let cd = spec.cd0
        + spec.induced_k_at(mach) * cl * cl
        + engine::wave_drag(spec.wave_drag_cd, spec.drag_rise_mach, mach);
    if engine::blackbird_thrust(spec, 1.0, altitude_m, mach) > 1.025 * q_area * cd {
        Ok(())
    } else {
        Err("Blackbird cannot sustain that speed at high altitude".into())
    }
}

impl Autopilot {
    pub fn selected_targets(&self) -> Option<FlightTargets> {
        self.selected
    }

    pub(crate) fn selected_afterburner(&self, spec: &AircraftSpec) -> bool {
        spec.id == "sr71" && self.selected.is_some()
    }

    pub fn engage_selected(&mut self, inp: &ApInputs, spec: &AircraftSpec, targets: FlightTargets) {
        let perf = self.perf_for(spec).clone();
        let requested_altitude = targets.altitude_ft;
        let targets = match validate(targets, inp, spec, &perf) {
            Ok(targets) => targets,
            Err(message) => {
                self.say(message);
                return;
            }
        };
        if inp.on_ground
            && inp.gs_ms > 15.0
            && !(inp.lever > 0.5 && inp.ias_kt < perf.v_rotate + 10.0)
        {
            self.say("Wait until stopped to start a new autopilot takeoff");
            return;
        }

        let continuing_departure = self.engaged
            && matches!(
                self.phase,
                Phase::Taxi
                    | Phase::LineUp
                    | Phase::TakeoffRoll
                    | Phase::Rotate
                    | Phase::InitialClimb
            );
        let previous = self.selected.replace(targets);
        if targets.altitude_ft < requested_altitude {
            self.say(format!(
                "Blackbird power limit at the selected speed: targeting {:.0} ft",
                targets.altitude_ft
            ));
        }
        if continuing_departure || (self.engaged && self.phase == Phase::Hold && previous.is_some())
        {
            return;
        }

        self.init_engagement(inp);
        if inp.on_ground {
            if !self.engage_on_ground(inp, &perf) || self.phase == Phase::Rollout {
                self.selected = previous;
                return;
            }
        } else {
            self.engage_hold(inp, &perf);
            self.say("Autopilot engaged: flying selected targets");
        }
        self.engaged = true;
    }

    pub(super) fn adjust_selected(&mut self, cmd: &AutopilotCommand, inp: &ApInputs, spec: &AircraftSpec) {
        let Some(mut targets) = self.selected else {
            return;
        };
        if cmd.autothrottle == Some(false)
            || cmd.heading_hold == Some(false)
            || cmd.altitude_hold == Some(false)
        {
            self.disengage(Some("Autopilot disengaged"));
            return;
        }
        let perf = self.perf_for(spec);
        targets.heading = cmd.heading.unwrap_or(targets.heading) + cmd.heading_delta.unwrap_or(0.0);
        targets.altitude_ft = (cmd.altitude_ft.unwrap_or(targets.altitude_ft)
            + cmd.altitude_delta_ft.unwrap_or(0.0))
        .clamp(0.0, spec.max_alt_ft);
        if let Some(kt) = cmd.speed_kt {
            targets.speed = TargetSpeed::Knots(kt);
        } else if let Some(delta) = cmd.speed_delta_kt {
            targets.speed = match targets.speed {
                TargetSpeed::Knots(kt) => TargetSpeed::Knots(kt + delta),
                TargetSpeed::Mach(m) => TargetSpeed::Mach(m + delta.signum() * 0.01),
                TargetSpeed::GroundMph(mph) => TargetSpeed::GroundMph(mph + delta * KT_TO_MS / MPH_TO_MS),
            };
        }
        match validate(targets, inp, spec, perf) {
            Ok(targets) => self.selected = Some(targets),
            Err(message) => self.say(message),
        }
    }

    pub(super) fn fly_selected(
        &mut self,
        inp: &ApInputs,
        spec: &AircraftSpec,
        perf: &Perf,
        targets: FlightTargets,
        dt: f64,
    ) -> ApOutput {
        if inp.on_ground {
            return ApOutput::default();
        }
        let mach = inp.tas_ms / inp.speed_of_sound;
        let bank_limit = if mach > 2.0 {
            15.0
        } else {
            perf.bank_limit_deg
        };
        let bank = bank_for_heading_error(targets.heading - inp.heading, bank_limit);
        self.bank_cmd = slew(self.bank_cmd, bank, perf.bank_rate_dps * dt);
        let roll = roll_stick(
            self.bank_cmd,
            inp.roll_deg,
            inp.roll_rate_max,
            inp.control_eff,
        );

        let equivalent_knots_per_ms = inp.sigma.sqrt() * MS_TO_KT;
        let knots_per_mach = inp.speed_of_sound * equivalent_knots_per_ms;
        let speed_limit =
            mach_limit(spec, perf).map_or(perf.v_limit, |m| perf.v_limit.min(m * knots_per_mach));
        let terrain = inp.terrain_ahead.unwrap_or(inp.ground_h).max(inp.ground_h);
        let min_alt = (terrain - inp.geoid) * M_TO_FT + 600.0;
        let altitude_error = targets.altitude_ft.max(min_alt) - inp.alt_msl_ft;
        let mut requested_speed = match targets.speed {
            TargetSpeed::Knots(kt) => kt,
            TargetSpeed::Mach(m) => m * knots_per_mach,
            TargetSpeed::GroundMph(mph) => {
                // Translate the measured ground-speed error to equivalent airspeed.
                // This accounts for the current wind and flight path as they change.
                (inp.tas_ms + (mph * MPH_TO_MS - inp.gs_ms)) * equivalent_knots_per_ms
            }
        };
        if spec.id == "sr71" && matches!(targets.speed, TargetSpeed::Mach(_) | TargetSpeed::GroundMph(_)) {
            let climb_fraction = ((altitude_error - 500.0) / 2_000.0).clamp(0.0, 1.0);
            requested_speed -= (requested_speed - BLACKBIRD_CLIMB_KEAS).max(0.0) * climb_fraction;
        }
        let speed = if inp.alt_msl_ft < 10_000.0 && targets.altitude_ft >= 10_000.0 && perf.jet {
            requested_speed.min(perf.v_climb_low)
        } else {
            requested_speed
        };
        let speed = speed.min(speed_limit).max(perf.v_clean);
        self.spd_cmd = slew(self.spd_cmd.max(perf.v_clean), speed, 6.0 * dt);

        let climb_rate =
            perf.vs_climb_fpm * (1.0 - 0.5 * (inp.alt_msl_ft / perf.max_alt_ft).clamp(0.0, 1.0));
        let mut vs = (altitude_error * 2.2).clamp(-perf.vs_descent_fpm, climb_rate);
        if vs > 0.0 && inp.alt_msl_ft > min_alt + 100.0 {
            // Save the available thrust for acceleration whenever climbing
            // would drag the aircraft below the scheduled climb airspeed.
            let shortage = (self.spd_cmd - self.ias_filt - 1.5).max(0.0);
            vs = (vs - 210.0 * shortage).max(0.0);
        }
        if vs < 0.0 && inp.lever < 0.15 {
            // Give up descent rate when idle power alone cannot slow the aircraft.
            vs = (vs + 160.0 * (self.ias_filt - self.spd_cmd - 2.0).max(0.0)).min(0.0);
        }
        self.vs_cmd = slew(self.vs_cmd, vs, 450.0 * dt);
        let gamma = gamma_for_vs(self.vs_cmd, inp.speed_ms).clamp(-0.25, 0.25);
        let curvature_g = inp.gs_ms.powi(2) / ((EARTH_MEAN_RADIUS + inp.height) * G0);
        let load =
            load_factor(gamma, inp.gamma, inp.roll_deg, inp.speed_ms, 0.65, 1.5) - curvature_g;
        let lever_max = if self.selected_afterburner(spec) {
            1.0
        } else {
            perf.lever_max
        };
        let throttle = autothrottle(
            inp.lever,
            self.spd_cmd,
            inp.ias_kt,
            self.ias_rate,
            lever_max,
            dt,
        );

        self.target_heading = targets.heading;
        self.target_altitude_ft = targets.altitude_ft;
        self.target_speed_kt = self.spd_cmd;
        self.vertical_speed_fpm = self.vs_cmd;
        self.lateral = Lateral::Heading;
        ApOutput {
            roll_stick: Some(roll),
            load_factor: Some(load),
            throttle: Some(throttle),
            gear_down: (perf.retractable_gear && inp.agl_ft > 150.0 && inp.gear_down_cmd)
                .then_some(false),
            flaps_index: self.retract_flaps(inp, perf),
            speedbrake: inp.speedbrake_cmd.then_some(false),
            ..ApOutput::default()
        }
    }
}
