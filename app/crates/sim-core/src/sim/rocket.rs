//! X-15 climb guidance. The controls fly a powered ascent followed by a
//! ballistic coast, using the same thrust and aerodynamics as manual flight.

use crate::aircraft::EngineKind;
use crate::atmosphere::{isa, G0};
use crate::autopilot::ApOutput;
use crate::engine;
use crate::geo::{EARTH_MEAN_RADIUS, M_TO_FT};

use super::Simulation;

#[derive(Clone, Copy)]
pub(super) struct RocketClimb {
    target_ft: f64,
    coasting: bool,
    predict_after_s: f64,
}

impl Simulation {
    pub(super) fn start_rocket_climb(&mut self, altitude_ft: f64) {
        if self.spec.engine != EngineKind::Rocket {
            return;
        }
        if self.awaiting.is_some() || self.crashed {
            self.message("X-15 climb is available once the aircraft is ready");
            return;
        }
        let altitude = (self.d.height - self.d.geoid - self.contact_height()) * M_TO_FT;
        if !(0.0..=self.spec.max_alt_ft).contains(&altitude_ft) || altitude_ft <= altitude {
            self.message("Choose an altitude above the aircraft");
            return;
        }
        self.rocket_climb = Some(RocketClimb { target_ft: altitude_ft, coasting: false, predict_after_s: 0.0 });
        self.gamma_ref = None;
        self.message(format!("X-15 guiding a climb toward {altitude_ft:.0} ft"));
    }

    pub(super) fn cancel_rocket_climb(&mut self) {
        if self.rocket_climb.take().is_some() {
            self.gamma_ref = None;
            self.message("X-15 climb guidance released");
        }
    }

    pub(super) fn update_rocket_climb(&mut self, dt: f64) -> Option<ApOutput> {
        let mut climb = self.rocket_climb?;
        let input = &self.input;
        if [input.pitch, input.roll, input.yaw, input.throttle_rate, input.brake].iter().any(|v| v.abs() > 0.15) {
            self.cancel_rocket_climb();
            return None;
        }
        if self.on_ground {
            return Some(ApOutput {
                throttle: Some(1.0),
                pitch_stick: Some(if self.d.ias_kt >= self.spec.v_rotate_kt { 1.0 } else { 0.0 }),
                parking_brake: Some(false),
                ..ApOutput::default()
            });
        }

        let altitude = (self.d.height - self.d.geoid - self.contact_height()) * M_TO_FT;
        if !climb.coasting {
            climb.predict_after_s -= dt;
            if climb.predict_after_s <= 0.0 {
                climb.coasting = self.rocket_coast_apogee() >= climb.target_ft;
                climb.predict_after_s = 0.08;
            }
            self.rocket_climb = Some(climb);
        }
        if climb.coasting && self.d.vs <= 0.0 && self.engine < 0.02 {
            self.rocket_climb = None;
            self.gamma_ref = None;
            self.message(format!("X-15 reached an apogee of {altitude:.0} ft. You have control."));
            return None;
        }

        let pitch_target = if climb.coasting {
            self.d.fpa.to_degrees()
        } else {
            // Roll out of the runway climb gradually for nearby targets.
            let remaining = (climb.target_ft - altitude).max(0.0);
            20.0 + 25.0 * (remaining / 40_000.0).clamp(0.0, 1.0)
        };
        self.gamma_ref = None;
        Some(ApOutput {
            throttle: Some(if climb.coasting { 0.0 } else { 1.0 }),
            pitch_stick: Some(((pitch_target - self.d.pitch.to_degrees()) * 0.08).clamp(-1.0, 1.0)),
            roll_stick: Some((-self.d.roll.to_degrees() / 20.0).clamp(-1.0, 1.0)),
            load_factor: climb.coasting.then_some(0.0),
            gear_down: (self.d.agl > 12.0).then_some(false),
            ..ApOutput::default()
        })
    }

    /// Fly a lightweight prediction of the zero-lift coast to find engine cutoff.
    fn rocket_coast_apogee(&self) -> f64 {
        let spec = self.spec;
        let mass = spec.mass_kg;
        let mut height = self.d.height - self.d.geoid;
        // The main simulation decays the engine exponentially after cutoff.
        let spool_s = spec.spool_time_s * (0.8 / 3.0);
        let impulse = spec.max_thrust_n * self.engine * spool_s / mass;
        let (sin_pitch, cos_pitch) = self.d.pitch.sin_cos();
        let mut horizontal_speed = self.d.gs + impulse * cos_pitch;
        let mut up_speed = self.d.vs + impulse * sin_pitch;
        for _ in 0..600 {
            if up_speed <= 0.0 {
                break;
            }
            let air = isa(height);
            let speed = horizontal_speed.hypot(up_speed);
            let cd = spec.cd0 + engine::wave_drag(spec.wave_drag_cd, spec.drag_rise_mach, speed / air.speed_of_sound);
            let drag_per_speed = 0.5 * air.density * speed * spec.wing_area_m2 * cd / mass;
            let gravity = G0 - horizontal_speed.powi(2) / (EARTH_MEAN_RADIUS + height);
            let decel = (gravity + drag_per_speed * up_speed).max(0.1);
            let step = (up_speed / decel).min(0.5);
            height += (up_speed - 0.5 * decel * step) * step;
            horizontal_speed /= 1.0 + drag_per_speed * step;
            if step < 0.5 {
                break;
            }
            up_speed -= decel * step;
        }
        (height - self.contact_height()) * M_TO_FT
    }
}
