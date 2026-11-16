//! X-15 autopilot for a powered climb and sustained altitude hold.

use crate::aircraft::EngineKind;
use crate::atmosphere::{isa, G0};
use crate::autopilot::ApOutput;
use crate::engine;
use crate::geo::{EARTH_MEAN_RADIUS, FT_TO_M, M_TO_FT};

use super::Simulation;

#[derive(Clone, Copy)]
pub(super) struct RocketGuidance {
    pub(super) target_ft: f64,
    pub(super) holding: bool,
    heading: f64,
}

impl Simulation {
    fn rocket_altitude_ft(&self) -> f64 {
        (self.d.height - self.d.geoid - self.contact_height()) * M_TO_FT
    }

    pub(super) fn start_rocket_climb(&mut self, altitude_ft: f64) {
        if self.spec.engine != EngineKind::Rocket {
            return;
        }
        if self.awaiting.is_some() || self.crashed {
            self.message("X-15 autopilot is available once the aircraft is ready");
            return;
        }
        if !(0.0..=self.spec.max_alt_ft).contains(&altitude_ft) || altitude_ft <= self.rocket_altitude_ft() {
            self.message("Choose an altitude above the aircraft");
            return;
        }
        self.set_rocket_guidance(altitude_ft, false);
        self.message(format!("X-15 climbing to {altitude_ft:.0} ft"));
    }

    pub(super) fn hold_rocket_altitude(&mut self) {
        if self.awaiting.is_some() || self.crashed || self.on_ground {
            self.message("Use Fly climb to start the X-15 autopilot from the runway");
            return;
        }
        let altitude_ft = self.rocket_altitude_ft();
        self.set_rocket_guidance(altitude_ft, true);
        self.message(format!("X-15 holding {altitude_ft:.0} ft"));
    }

    fn set_rocket_guidance(&mut self, target_ft: f64, holding: bool) {
        self.rocket_guidance = Some(RocketGuidance { target_ft, holding, heading: self.d.heading });
        self.gamma_ref = None;
        self.bank_ref = None;
    }

    pub(super) fn cancel_rocket_guidance(&mut self) {
        if self.rocket_guidance.take().is_some() {
            self.gamma_ref = None;
            self.message("X-15 autopilot disengaged");
        }
    }

    pub(super) fn update_rocket_guidance(&mut self) -> Option<ApOutput> {
        let mut guidance = self.rocket_guidance?;
        let input = &self.input;
        if [input.pitch, input.roll, input.yaw, input.throttle_rate, input.brake]
            .iter().any(|v| v.abs() > 0.15)
        {
            self.cancel_rocket_guidance();
            return None;
        }
        if self.on_ground {
            return Some(ApOutput {
                throttle: Some(1.0),
                pitch_stick: Some(if self.d.ias_kt >= self.spec.v_rotate_kt { 1.0 } else { 0.0 }),
                parking_brake: Some(false),
                speedbrake: Some(false),
                ..ApOutput::default()
            });
        }

        let altitude = self.rocket_altitude_ft();
        let remaining = (guidance.target_ft - altitude) * FT_TO_M;
        if !guidance.holding && remaining.abs() < 90.0 && self.d.vs.abs() < 6.0 {
            guidance.holding = true;
            self.rocket_guidance = Some(guidance);
            self.message(format!("X-15 holding {:.0} ft", guidance.target_ft));
        }

        // Schedule airspeed through the climb and cap the flight-path angle.
        // The altitude loop starts reducing vertical speed well before capture.
        let air = isa(self.d.height - self.d.geoid);
        let target_mach = (0.9 + (altitude - 40_000.0).max(0.0) / 58_000.0).min(5.5);
        let path_speed = self.d.gs.hypot(self.d.vs).max(60.0);
        let climb_limit = (path_speed * 0.33).min(210.0);
        // Tighten the loop close to the target to reject steady disturbances.
        let capture_time = 8.0 + 24.0 * (remaining.abs() / 1_800.0).min(1.0);
        let target_vs = (remaining / capture_time).clamp(-climb_limit, climb_limit);
        let target_fpa = (target_vs / path_speed).asin();
        let gravity = G0 - self.d.gs.powi(2) / (EARTH_MEAN_RADIUS + self.d.height);
        let bank = self.d.roll.cos().max(0.65);
        let path_accel = (target_fpa - self.d.fpa) * path_speed / 4.5;
        let normal_g = ((gravity * self.d.fpa.cos() + path_accel) / (G0 * bank))
            .clamp(self.spec.min_load_factor, 2.0);

        let q_area = 0.5 * air.density * self.d.tas.powi(2) * self.spec.wing_area_m2;
        let cl = self.spec.cl0 + self.spec.cl_alpha * self.d.alpha.clamp(-0.28, 0.28);
        let cd = self.spec.cd0
            + engine::wave_drag(self.spec.wave_drag_cd, self.spec.drag_rise_mach, self.d.mach)
            + self.spec.induced_k_at(self.d.mach) * cl * cl + self.spec.gear_cd * self.gear;
        let drag = q_area * cd;
        let speed_error = target_mach * air.speed_of_sound - self.d.tas;
        let thrust = drag + self.spec.mass_kg * (speed_error / 11.0 + gravity * self.d.fpa.sin());
        let heading_error = (guidance.heading - self.d.heading + std::f64::consts::PI)
            .rem_euclid(std::f64::consts::TAU) - std::f64::consts::PI;
        let bank_target = (heading_error * 2.0).clamp(-0.32, 0.32);
        Some(ApOutput {
            throttle: Some((thrust / self.spec.max_thrust_n).clamp(0.0, 1.0)),
            roll_stick: Some(((bank_target - self.d.roll) * 2.9).clamp(-1.0, 1.0)),
            load_factor: Some(normal_g),
            gear_down: (self.d.agl > 12.0).then_some(false),
            speedbrake: Some(false),
            ..ApOutput::default()
        })
    }
}
