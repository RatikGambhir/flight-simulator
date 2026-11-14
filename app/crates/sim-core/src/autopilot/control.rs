//! Inner-loop control laws. Each turns a guidance target into the same kind
//! of demand a pilot makes (roll stick, load factor, throttle lever, pitch
//! stick on the ground) so the flight model treats the autopilot exactly like
//! a human. All commands are rate limited so engagement and mode changes are
//! smooth.

use crate::atmosphere::G0;
use crate::geo::{wrap_deg_180, FT_TO_M};

/// Moves `current` toward `target` by at most `max_step`.
#[inline]
pub fn slew(current: f64, target: f64, max_step: f64) -> f64 {
    if (target - current).abs() <= max_step { target } else { current + max_step.copysign(target - current) }
}

/// Bank angle (deg) that turns onto a track/heading with a given error (deg).
#[inline]
pub fn bank_for_heading_error(err_deg: f64, limit_deg: f64) -> f64 {
    (wrap_deg_180(err_deg) * 1.4).clamp(-limit_deg, limit_deg)
}

/// Roll stick (-1..1) that drives the bank toward `bank_cmd_deg` (classic hold-mode gain).
#[inline]
pub fn roll_stick(bank_cmd_deg: f64, roll_deg: f64, roll_rate_max: f64, control_eff: f64) -> f64 {
    roll_stick_k(bank_cmd_deg, roll_deg, roll_rate_max, control_eff, 0.5)
}

/// Roll stick with an attitude gain `k` (1/s): a higher gain rejects
/// turbulence better (limited by the aircraft's roll response).
#[inline]
pub fn roll_stick_k(bank_cmd_deg: f64, roll_deg: f64, roll_rate_max: f64, control_eff: f64, k: f64) -> f64 {
    let p_des = ((bank_cmd_deg - roll_deg) * k).to_radians();
    let auth = (roll_rate_max * control_eff).max(1e-3);
    (p_des / auth).clamp(-1.0, 1.0)
}

/// Bank angle (deg) for a track/heading error (deg) with a gain (deg of bank per degree).
#[inline]
pub fn bank_for_error_k(err_deg: f64, gain: f64, limit_deg: f64) -> f64 {
    (wrap_deg_180(err_deg) * gain).clamp(-limit_deg, limit_deg)
}

/// Flight-path angle (rad) for a vertical speed (fpm) at a speed (m/s).
#[inline]
pub fn gamma_for_vs(vs_fpm: f64, speed_ms: f64) -> f64 {
    ((vs_fpm * FT_TO_M / 60.0) / speed_ms.max(20.0)).clamp(-0.45, 0.45).asin()
}

/// Default flight-path gain (1/s): about a two-second path response.
pub const K_GAMMA: f64 = 0.45;

/// Load factor that steers the flight path toward `gamma_cmd` (both rad) at a bank angle.
#[inline]
pub fn load_factor(gamma_cmd: f64, gamma: f64, roll_deg: f64, speed_ms: f64, n_min: f64, n_max: f64) -> f64 {
    load_factor_k(gamma_cmd, gamma, 0.0, roll_deg, speed_ms, n_min, n_max, K_GAMMA)
}

/// [`load_factor`] with a path gain `k` (1/s) and a feed-forward of the
/// commanded path-angle rate `gamma_rate` (rad/s), for tight tracking (flare).
#[inline]
#[allow(clippy::too_many_arguments)]
pub fn load_factor_k(gamma_cmd: f64, gamma: f64, gamma_rate: f64, roll_deg: f64, speed_ms: f64, n_min: f64, n_max: f64, k: f64) -> f64 {
    let cphi = roll_deg.to_radians().cos().max(0.5);
    let v = speed_ms.max(20.0);
    let n = gamma.cos() / cphi + ((gamma_cmd - gamma) * k + gamma_rate) * v / G0;
    n.clamp(n_min, n_max)
}

/// Autothrottle: integrates the lever toward the speed target with rate damping.
#[inline]
pub fn autothrottle(lever: f64, target_kt: f64, ias_kt: f64, ias_rate: f64, lever_max: f64, dt: f64) -> f64 {
    let err = target_kt - ias_kt;
    let rate = (0.018 * err - 0.06 * ias_rate).clamp(-0.3, 0.3);
    (lever + rate * dt).clamp(0.0, lever_max)
}

/// Speed-on-pitch (FLCH): the flight path that holds `target` speed with the
/// thrust currently set. `accel` is the measured along-path acceleration (m/s²).
#[inline]
pub fn speed_on_pitch_gamma(gamma: f64, accel: f64, speed_ms: f64, target_ms: f64) -> f64 {
    let available = gamma + accel / G0;
    available + 0.12 * (speed_ms - target_ms) / G0
}

/// Ground-pitch stick that rotates toward `pitch_target_deg` at no more than `rate_dps`.
#[inline]
pub fn rotation_stick(pitch_target_deg: f64, pitch_deg: f64, rate_dps: f64, q_max: f64, control_eff: f64) -> f64 {
    let q_des = ((pitch_target_deg - pitch_deg) * 1.5).clamp(-2.0, rate_dps + 1.0).to_radians();
    (q_des / (q_max * control_eff.max(0.05) * 1.4).max(1e-3)).clamp(-0.6, 1.0)
}

/// First-order low-pass filter step.
#[inline]
pub fn lowpass(state: f64, input: f64, tau: f64, dt: f64) -> f64 {
    state + (input - state) * (dt / tau.max(1e-3)).min(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slew_limits_the_step() {
        assert_eq!(slew(0.0, 10.0, 3.0), 3.0);
        assert_eq!(slew(0.0, -10.0, 3.0), -3.0);
        assert_eq!(slew(9.0, 10.0, 3.0), 10.0);
    }

    #[test]
    fn bank_command_turns_the_short_way_and_saturates() {
        assert!(bank_for_heading_error(10.0, 25.0) > 0.0);
        assert!(bank_for_heading_error(350.0, 25.0) < 0.0, "350° error is a 10° left turn");
        assert_eq!(bank_for_heading_error(120.0, 25.0), 25.0);
    }

    #[test]
    fn load_factor_holds_level_flight_at_one_g_and_banks() {
        assert!((load_factor(0.0, 0.0, 0.0, 100.0, 0.5, 2.0) - 1.0).abs() < 1e-12);
        let n = load_factor(0.0, 0.0, 30.0, 100.0, 0.5, 2.0);
        assert!((n - 1.0 / 30f64.to_radians().cos()).abs() < 1e-9);
        assert!(load_factor(0.1, 0.0, 0.0, 100.0, 0.5, 1.3) <= 1.3);
    }

    #[test]
    fn autothrottle_moves_toward_the_target_and_stays_in_range() {
        let up = autothrottle(0.5, 250.0, 240.0, 0.0, 1.0, 0.1);
        assert!(up > 0.5);
        let down = autothrottle(0.5, 230.0, 240.0, 0.0, 1.0, 0.1);
        assert!(down < 0.5);
        assert_eq!(autothrottle(0.0, 100.0, 200.0, 0.0, 1.0, 1.0), 0.0);
        assert!(autothrottle(0.79, 900.0, 100.0, 0.0, 0.8, 10.0) <= 0.8);
    }

    #[test]
    fn speed_on_pitch_climbs_when_fast_and_descends_when_slow() {
        let g_fast = speed_on_pitch_gamma(0.05, 0.0, 90.0, 80.0);
        let g_slow = speed_on_pitch_gamma(0.05, 0.0, 70.0, 80.0);
        assert!(g_fast > 0.05 && g_slow < 0.05);
    }
}
