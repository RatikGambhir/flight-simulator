//! A simple three-mode autopilot: heading hold, altitude hold (with a
//! vertical-speed limit) and autothrottle. It produces the same kinds of
//! demands a pilot would (roll stick, load factor, throttle lever) so the
//! flight model treats it exactly like a human.

use crate::aircraft::AircraftSpec;
use crate::atmosphere::G0;
use crate::geo::{wrap_deg_180, wrap_deg_360, FT_TO_M};
use crate::protocol::AutopilotCommand;

#[derive(Debug, Clone)]
pub struct Autopilot {
    pub engaged: bool,
    pub heading_hold: bool,
    pub altitude_hold: bool,
    pub autothrottle: bool,
    pub target_heading: f64,
    pub target_altitude_ft: f64,
    pub target_speed_kt: f64,
    /// Max climb/descent rate used when changing altitude.
    pub vertical_speed_fpm: f64,
    prev_ias: Option<f64>,
    ias_rate: f64,
}

impl Default for Autopilot {
    fn default() -> Self {
        Self {
            engaged: false,
            heading_hold: true,
            altitude_hold: true,
            autothrottle: true,
            target_heading: 0.0,
            target_altitude_ft: 5000.0,
            target_speed_kt: 250.0,
            vertical_speed_fpm: 1800.0,
            prev_ias: None,
            ias_rate: 0.0,
        }
    }
}

/// Flight values the autopilot needs.
pub struct ApInputs {
    pub heading: f64,
    pub roll_deg: f64,
    pub alt_msl_ft: f64,
    pub ias_kt: f64,
    pub tas_ms: f64,
    pub gamma: f64,
    pub roll_rate_max: f64,
    pub control_eff: f64,
    pub on_ground: bool,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct ApOutput {
    pub roll_stick: Option<f64>,
    pub load_factor: Option<f64>,
    pub throttle: Option<f64>,
}

impl Autopilot {
    pub fn engage(&mut self, inp: &ApInputs, spec: &AircraftSpec) {
        self.engaged = true;
        self.heading_hold = true;
        self.altitude_hold = true;
        self.autothrottle = true;
        self.target_heading = inp.heading.round();
        self.target_altitude_ft = (inp.alt_msl_ft / 100.0).round() * 100.0;
        self.target_speed_kt = inp.ias_kt.round().clamp(spec.v_approach_kt, spec.v_max_kt - 10.0);
        self.prev_ias = None;
    }

    pub fn apply(&mut self, cmd: &AutopilotCommand, inp: Option<&ApInputs>, spec: &AircraftSpec) {
        if let Some(e) = cmd.engaged {
            match (e, inp) {
                (true, Some(i)) if !self.engaged => self.engage(i, spec),
                (false, _) => self.engaged = false,
                _ => {}
            }
        }
        if let Some(v) = cmd.heading_hold { self.heading_hold = v; }
        if let Some(v) = cmd.altitude_hold { self.altitude_hold = v; }
        if let Some(v) = cmd.autothrottle { self.autothrottle = v; }
        if let Some(v) = cmd.heading { self.target_heading = wrap_deg_360(v); }
        if let Some(v) = cmd.altitude_ft { self.target_altitude_ft = v.clamp(0.0, spec.max_alt_ft); }
        if let Some(v) = cmd.speed_kt { self.target_speed_kt = v.clamp(spec.v_approach_kt * 0.85, spec.v_max_kt); }
        if let Some(v) = cmd.vertical_speed_fpm { self.vertical_speed_fpm = v.abs().clamp(300.0, 6000.0); }
        if let Some(d) = cmd.heading_delta { self.target_heading = wrap_deg_360(self.target_heading + d); }
        if let Some(d) = cmd.altitude_delta_ft {
            self.target_altitude_ft = (self.target_altitude_ft + d).clamp(0.0, spec.max_alt_ft);
        }
        if let Some(d) = cmd.speed_delta_kt {
            self.target_speed_kt = (self.target_speed_kt + d).clamp(spec.v_approach_kt * 0.85, spec.v_max_kt);
        }
    }

    pub fn update(&mut self, inp: &ApInputs, spec: &AircraftSpec, lever: f64, dt: f64) -> ApOutput {
        // Track IAS trend for the autothrottle damping term.
        if let Some(prev) = self.prev_ias {
            let raw = (inp.ias_kt - prev) / dt.max(1e-4);
            self.ias_rate += (raw - self.ias_rate) * (dt * 2.0).min(1.0);
        }
        self.prev_ias = Some(inp.ias_kt);

        if !self.engaged || inp.on_ground {
            return ApOutput::default();
        }
        let mut out = ApOutput::default();

        if self.heading_hold {
            let bank_limit = if spec.max_roll_rate > 45.0 { 20.0 } else { 25.0 };
            let err = wrap_deg_180(self.target_heading - inp.heading);
            let bank_cmd = (err * 1.4).clamp(-bank_limit, bank_limit);
            let p_des = ((bank_cmd - inp.roll_deg) * 0.5).to_radians();
            let auth = (inp.roll_rate_max * inp.control_eff).max(1e-3);
            out.roll_stick = Some((p_des / auth).clamp(-1.0, 1.0));
        } else {
            // Wings level.
            let p_des = (-inp.roll_deg * 0.5).to_radians();
            let auth = (inp.roll_rate_max * inp.control_eff).max(1e-3);
            out.roll_stick = Some((p_des / auth).clamp(-1.0, 1.0));
        }

        let v = inp.tas_ms.max(20.0);
        let vs_cmd_fpm = if self.altitude_hold {
            let err = self.target_altitude_ft - inp.alt_msl_ft;
            (err * 2.5).clamp(-self.vertical_speed_fpm, self.vertical_speed_fpm)
        } else {
            0.0
        };
        let gamma_cmd = ((vs_cmd_fpm * FT_TO_M / 60.0) / v).clamp(-0.25, 0.25).asin();
        let cphi = inp.roll_deg.to_radians().cos().max(0.5);
        let n = inp.gamma.cos() / cphi + (gamma_cmd - inp.gamma) * v / G0 * 0.45;
        out.load_factor = Some(n.clamp(0.6, 1.5));

        if self.autothrottle {
            let err = self.target_speed_kt - inp.ias_kt;
            let rate = (0.018 * err - 0.06 * self.ias_rate).clamp(-0.3, 0.3);
            out.throttle = Some((lever + rate * dt).clamp(0.0, 1.0));
        }
        out
    }

    pub fn target_altitude_m(&self) -> f64 {
        self.target_altitude_ft * FT_TO_M
    }
}
