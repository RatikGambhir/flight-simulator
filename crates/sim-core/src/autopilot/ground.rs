//! Autopilot taxi, takeoff roll, and landing rollout.

use crate::geo::{wrap_deg_180, wrap_deg_360, KT_TO_MS, MS_TO_KT};

use super::control::{gamma_for_vs, load_factor, roll_stick_k, rotation_stick, slew};
use super::nav::{angle_diff, pursuit_steer, to_body};
use super::{ApInputs, ApOutput, Autopilot, Lateral, Perf, Phase};

impl Autopilot {
    /// Taxi, line up, and accelerate until the aircraft lifts off.
    pub(super) fn departure_ground(&mut self, inp: &ApInputs, perf: &Perf, dt: f64) -> ApOutput {
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

    pub(super) fn arrival_ground(&mut self, inp: &ApInputs, perf: &Perf, dt: f64) -> ApOutput {
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
}
