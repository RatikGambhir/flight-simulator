//! Operating speeds, limits and distances the autopilot derives from an
//! [`AircraftSpec`]. Nothing here is aircraft-specific code: every number is
//! computed from the spec, so a new aircraft in the catalog gets a working
//! autopilot without changes here.

use crate::aircraft::{AircraftSpec, EngineKind};
use crate::atmosphere::{G0, RHO_SL};
use crate::geo::{FT_TO_M, KT_TO_MS};

/// Final approach path angle (degrees).
pub const GLIDESLOPE_DEG: f64 = 3.0;

#[derive(Debug, Clone)]
pub struct Perf {
    pub jet: bool,
    pub aerobatic: bool,
    pub retractable_gear: bool,
    pub auto_flaps: bool,
    pub reversers: bool,
    pub speedbrakes: bool,
    /// Number of flap detents (including "up").
    pub flap_count: usize,
    pub takeoff_flaps: usize,

    /// Reference landing speed with full flaps (KIAS).
    pub v_ref: f64,
    /// Final approach speed (KIAS): Vref plus a small additive.
    pub v_app: f64,
    pub v_rotate: f64,
    /// Initial climb speed after liftoff (KIAS).
    pub v2: f64,
    /// Minimum clean (flaps up) manoeuvring speed (KIAS).
    pub v_clean: f64,
    /// Climb speed below 10,000 ft and above (KIAS).
    pub v_climb_low: f64,
    pub v_climb_high: f64,
    pub v_cruise: f64,
    pub v_descent: f64,
    /// Highest speed the autopilot will ever target (KIAS).
    pub v_limit: f64,
    /// Cruise Mach limit for transport-category jets.
    pub mach_cap: Option<f64>,

    pub vs_climb_fpm: f64,
    pub vs_descent_fpm: f64,
    pub vs_initial_climb_fpm: f64,
    pub bank_limit_deg: f64,
    /// How fast the commanded bank may change (deg/s).
    pub bank_rate_dps: f64,
    pub pitch_max_deg: f64,
    pub rotate_pitch_deg: f64,
    pub rotate_rate_dps: f64,
    /// Highest pitch allowed with the wheels near the ground (tail strike margin).
    pub flare_pitch_max_deg: f64,

    /// Flare: time constant of the exponential sink-rate decay (s).
    pub flare_tau_s: f64,
    /// Sink rate aimed for at touchdown (fpm, positive down).
    pub touchdown_sink_fpm: f64,
    /// Height above the runway at which the approach must be stable (ft).
    pub stabilize_agl_ft: f64,
    /// Minimum traffic pattern height above the runway (ft).
    pub pattern_agl_ft: f64,
    /// Height the initial climb continues to before accelerating (ft AGL).
    pub acceleration_agl_ft: f64,
    /// Default climb-out height when there is no destination (ft AGL).
    pub default_hold_agl_ft: f64,
    /// Distance of the final approach fix from the runway threshold (m).
    pub faf_m: f64,
    /// Highest sink rate that counts as a stable approach (fpm).
    pub max_stable_sink_fpm: f64,

    pub taxi_speed_kt: f64,
    /// Autobrake deceleration target (m/s²).
    pub autobrake_ms2: f64,
    /// Highest throttle lever the autothrottle uses (dry power for afterburning jets).
    pub lever_max: f64,
    pub required_takeoff_m: f64,
    pub required_landing_m: f64,
    pub hard_surface_only: bool,
    pub crosswind_limit_kt: f64,
    pub tailwind_limit_kt: f64,
    pub cruise_alt_ft: f64,
    pub max_alt_ft: f64,
    /// Feet of cruise altitude per nautical mile of trip (short trips stay low).
    pub alt_per_nm: f64,
    pub wingspan_m: f64,
    pub wheelbase_m: f64,
    pub rest_pitch_deg: f64,
    /// Strongest reported gusts (RMS vertical, m/s) the autopilot will land in.
    pub max_gust_ms: f64,
    /// Roll-attitude loop gain (1/s), scaled to how quickly the type responds.
    pub roll_gain: f64,
}

impl Perf {
    pub fn from_spec(s: &AircraftSpec) -> Self {
        let jet = s.engine == EngineKind::Jet;
        let flap_count = s.flap_detents.len().max(1);
        let v_ref = s.v_approach_kt;
        let v_clean = if jet { v_ref * 1.3 + 10.0 } else { v_ref * 1.25 };
        let v_app = v_ref + if jet { 5.0 } else { 0.0 };
        let v2 = (s.v_rotate_kt + if jet { 15.0 } else { 12.0 }).max(v_ref + 8.0).min(v_clean);
        let v_limit = s.v_max_kt - 10.0;
        let v_cruise = s.v_cruise_kt.min(v_limit);
        let (v_climb_low, v_climb_high) = if jet { (250f64.min(v_cruise).max(v_clean + 10.0), v_cruise) } else { (v_clean, v_clean) };
        let v_descent = if jet { v_cruise.min(290.0) } else { v_cruise };

        // Thrust-to-weight sets the climb performance the autopilot asks for.
        // Dry thrust-to-weight (afterburner is never used by the autopilot).
        let tw = s.max_thrust_n / (s.mass_kg * G0);
        let (vs_climb, vs_initial, vs_descent) = if !jet {
            (700.0, 900.0, 600.0)
        } else if s.aerobatic {
            (6000.0, 9000.0, 4000.0)
        } else if tw > 0.42 {
            (3500.0, 5000.0, 2500.0)
        } else {
            (2500.0, 4000.0, 2200.0)
        };

        let tail = s.tailstrike_pitch_deg;
        let rotate_pitch = if jet { (tail - 2.5).min(if s.aerobatic { 10.0 } else { 9.0 }) } else { (tail - 4.0).min(8.0) };
        let v_app_ms = v_app * KT_TO_MS;
        // About two minutes on final for airliners, a shorter final for light aircraft.
        let faf_m = (v_app_ms * 130.0).clamp(4_500.0, 11_000.0);

        let autobrake = if jet { 2.3 } else { 1.8 };
        let td = v_app_ms;
        let air = if jet { 450.0 } else { 200.0 };
        let required_landing_m = (air + td * td / (2.0 * autobrake)) * 1.15;
        // Takeoff roll from the static thrust-to-weight ratio.
        let accel = (if jet { tw } else { s.max_thrust_n * 0.8 / (s.mass_kg * G0) } * 0.85 - 0.02) * G0;
        let vr = s.v_rotate_kt * KT_TO_MS;
        let required_takeoff_m = (vr * vr / (2.0 * accel.max(0.5)) + if jet { 300.0 } else { 100.0 }) * 1.15;

        Self {
            jet,
            aerobatic: s.aerobatic,
            retractable_gear: s.retractable_gear,
            auto_flaps: s.auto_flaps,
            reversers: jet && s.thrust_reversers,
            speedbrakes: s.spoiler_cd > 0.0,
            flap_count,
            takeoff_flaps: s.takeoff_flaps(),
            v_ref,
            v_app,
            v_rotate: s.v_rotate_kt,
            v2,
            v_clean,
            v_climb_low,
            v_climb_high,
            v_cruise,
            v_descent,
            v_limit,
            mach_cap: if jet && !s.aerobatic { Some(0.80) } else { None },
            vs_climb_fpm: vs_climb,
            vs_descent_fpm: vs_descent,
            vs_initial_climb_fpm: vs_initial,
            bank_limit_deg: if s.aerobatic { 30.0 } else { 25.0 },
            bank_rate_dps: (s.max_roll_rate * 0.25).clamp(3.0, 10.0),
            pitch_max_deg: if s.aerobatic { 25.0 } else if jet { 17.0 } else { 13.0 },
            rotate_pitch_deg: rotate_pitch,
            rotate_rate_dps: if jet && !s.aerobatic { 2.5 } else { 4.0 },
            flare_pitch_max_deg: tail - 2.0,
            flare_tau_s: if jet { 3.0 } else { 2.2 },
            touchdown_sink_fpm: if jet { 140.0 } else { 80.0 },
            stabilize_agl_ft: if jet { 1000.0 } else { 500.0 },
            pattern_agl_ft: if jet { 1500.0 } else { 1000.0 },
            acceleration_agl_ft: if jet { 1000.0 } else { 500.0 },
            default_hold_agl_ft: if jet { 5000.0 } else { 3000.0 },
            faf_m,
            max_stable_sink_fpm: if s.aerobatic { 1800.0 } else if jet { 1400.0 } else { 1000.0 },
            taxi_speed_kt: if jet { 14.0 } else { 10.0 },
            autobrake_ms2: autobrake,
            lever_max: if s.afterburner_detent > 0.0 { s.afterburner_detent } else { 1.0 },
            required_takeoff_m,
            required_landing_m,
            hard_surface_only: jet,
            crosswind_limit_kt: if jet { 30.0 } else { 15.0 },
            tailwind_limit_kt: if jet { 10.0 } else { 5.0 },
            cruise_alt_ft: s.cruise_alt_ft.min(s.max_alt_ft),
            max_alt_ft: s.max_alt_ft,
            alt_per_nm: if jet { 150.0 } else { 60.0 },
            wingspan_m: s.wingspan_m,
            wheelbase_m: s.wheelbase_m,
            rest_pitch_deg: s.rest_pitch_deg,
            max_gust_ms: if s.aerobatic { 3.2 } else if jet { 2.2 } else { 2.0 },
            roll_gain: (0.75 / s.response_time_s).clamp(1.0, 4.5),
        }
    }

    /// Minimum manoeuvring speed (KIAS) with flap detent `index` set.
    pub fn min_speed_for_flaps(&self, index: usize) -> f64 {
        let n = self.flap_count.saturating_sub(1).max(1) as f64;
        let i = index.min(self.flap_count - 1) as f64;
        self.v_ref + (self.v_clean - self.v_ref) * (n - i) / n
    }

    /// Flap detent to fly a target speed with: the least flap whose minimum
    /// manoeuvring speed is at or below the target.
    pub fn flaps_for_speed(&self, target_kt: f64) -> usize {
        (0..self.flap_count).find(|&i| self.min_speed_for_flaps(i) <= target_kt + 0.5).unwrap_or(self.flap_count - 1)
    }

    /// Highest speed (KIAS) at which detent `index` may be extended.
    pub fn flap_extend_limit(&self, index: usize) -> f64 {
        if index == 0 { self.v_limit } else { self.min_speed_for_flaps(index) + if self.jet { 40.0 } else { 25.0 } }
    }

    /// Level-turn radius (m) at a true airspeed and bank angle.
    pub fn turn_radius_m(tas_ms: f64, bank_deg: f64) -> f64 {
        tas_ms * tas_ms / (G0 * bank_deg.to_radians().tan().max(0.05))
    }

    /// True airspeed (m/s) for an indicated airspeed at an altitude MSL (m), ISA.
    pub fn tas_ms(ias_kt: f64, alt_msl_m: f64) -> f64 {
        let rho = crate::atmosphere::isa(alt_msl_m).density;
        ias_kt * KT_TO_MS / (rho / RHO_SL).sqrt()
    }

    /// Pattern / glideslope-intercept height above the threshold (m).
    pub fn pattern_height_m(&self) -> f64 {
        (self.faf_m * GLIDESLOPE_DEG.to_radians().tan()).max(self.pattern_agl_ft * FT_TO_M)
    }

    /// Distance from the threshold where the glideslope meets the pattern height (m).
    pub fn glideslope_intercept_m(&self) -> f64 {
        self.pattern_height_m() / GLIDESLOPE_DEG.to_radians().tan()
    }

    /// Level distance (m) to slow from the low-altitude descent speed to the
    /// final approach speed at idle, configuring as the speed allows.
    pub fn decel_distance_m(&self) -> f64 {
        let from = (if self.jet { 250f64.min(self.v_descent) } else { self.v_descent }) * KT_TO_MS;
        let to = self.v_app * KT_TO_MS;
        let decel = if self.jet { 0.45 } else { 0.6 };
        ((from * from - to * to) / (2.0 * decel)).max(1_000.0)
    }

    /// Approach speeds by leg (KIAS): downwind (clean), base/intercept, localizer, final.
    pub fn approach_speeds(&self) -> [f64; 4] {
        let d = self.v_clean - self.v_ref;
        [self.v_clean, self.v_ref + 0.6 * d, self.v_ref + 0.3 * d, self.v_app]
    }

    /// Turn radius (m) flying the downwind/base legs.
    pub fn pattern_turn_radius_m(&self, field_msl_m: f64) -> f64 {
        let tas = Self::tas_ms(self.v_clean, field_msl_m + self.pattern_height_m());
        Self::turn_radius_m(tas, self.bank_limit_deg)
    }

    /// Cruise altitude (ft MSL) for a trip of `dist_nm` between fields whose
    /// higher elevation is `field_ft`: short trips stay low.
    pub fn cruise_altitude_ft(&self, dist_nm: f64, field_ft: f64) -> f64 {
        let floor = field_ft + self.pattern_agl_ft + if self.jet { 1500.0 } else { 1000.0 };
        let alt = field_ft + dist_nm * self.alt_per_nm;
        let alt = alt.clamp(floor, self.cruise_alt_ft.max(floor));
        // Round up so the rounding never takes the level below the clearance floor.
        (alt / 500.0).ceil() * 500.0
    }
}
