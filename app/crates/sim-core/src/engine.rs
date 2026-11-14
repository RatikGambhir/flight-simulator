//! Afterburning turbofan thrust and transonic drag for fighter-class aircraft.
//!
//! Thrust comes from altitude × Mach tables in the shape of the classic F-16
//! engine deck (Stevens & Lewis, *Aircraft Control and Simulation*, F100
//! idle/military/maximum tables up to Mach 1.0), normalised to sea-level
//! static thrust so any engine can be scaled onto it. Above Mach 1 the
//! tables are extended with the ram-recovery rise at altitude and the
//! inlet-temperature / dynamic-pressure limiting at low level that keep a
//! real F-16 near Mach 1.2 on the deck and about Mach 2.05 at 40,000 ft.

use crate::atmosphere::isa;

/// Table altitudes (m): 0, 10k, 20k, 30k, 40k, 50k ft.
const ALT_M: [f64; 6] = [0.0, 3_048.0, 6_096.0, 9_144.0, 12_192.0, 15_240.0];
/// Table Mach numbers.
const MACH: [f64; 12] = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.2];

/// Military (full dry) power, as a fraction of sea-level static military thrust.
/// Dry thrust stops gaining from ram air past Mach 1, so the jet only just
/// goes supersonic without the afterburner.
#[rustfmt::skip]
const MIL: [[f64; 12]; 6] = [
    [1.000, 1.000, 0.994, 0.997, 0.977, 0.921, 0.85, 0.76, 0.66, 0.56, 0.46, 0.36],
    [0.722, 0.722, 0.734, 0.776, 0.803, 0.777, 0.72, 0.66, 0.60, 0.53, 0.45, 0.37],
    [0.489, 0.498, 0.521, 0.559, 0.611, 0.635, 0.60, 0.58, 0.55, 0.50, 0.44, 0.37],
    [0.312, 0.319, 0.338, 0.368, 0.420, 0.481, 0.45, 0.44, 0.43, 0.41, 0.37, 0.32],
    [0.193, 0.195, 0.205, 0.224, 0.256, 0.300, 0.29, 0.29, 0.29, 0.28, 0.26, 0.23],
    [0.110, 0.110, 0.123, 0.131, 0.152, 0.182, 0.18, 0.18, 0.18, 0.17, 0.16, 0.14],
];

/// Maximum afterburner, as a fraction of sea-level static afterburner thrust.
#[rustfmt::skip]
const MAX: [[f64; 12]; 6] = [
    [1.000, 1.071, 1.135, 1.212, 1.304, 1.444, 1.15, 0.95, 0.80, 0.68, 0.58, 0.50],
    [0.750, 0.785, 0.843, 0.946, 1.054, 1.166, 1.15, 1.08, 0.98, 0.86, 0.74, 0.62],
    [0.540, 0.561, 0.613, 0.688, 0.799, 0.915, 0.99, 1.05, 1.04, 0.96, 0.84, 0.70],
    [0.350, 0.366, 0.408, 0.464, 0.556, 0.674, 0.76, 0.84, 0.88, 0.87, 0.80, 0.68],
    [0.200, 0.222, 0.250, 0.285, 0.343, 0.432, 0.50, 0.56, 0.59, 0.58, 0.52, 0.42],
    [0.125, 0.130, 0.142, 0.161, 0.198, 0.253, 0.30, 0.34, 0.36, 0.36, 0.32, 0.26],
];

/// Thrust with the afterburner lit at its minimum stage, as a fraction of
/// the way from military to maximum.
const MIN_AB: f64 = 0.15;

fn interp_axis(axis: &[f64], x: f64) -> (usize, f64) {
    let x = x.clamp(axis[0], axis[axis.len() - 1]);
    let i = axis.iter().rposition(|&a| a <= x).unwrap_or(0).min(axis.len() - 2);
    (i, (x - axis[i]) / (axis[i + 1] - axis[i]))
}

fn lookup(table: &[[f64; 12]; 6], alt_m: f64, mach: f64) -> f64 {
    let (i, fa) = interp_axis(&ALT_M, alt_m);
    let (j, fm) = interp_axis(&MACH, mach);
    let row = |r: &[f64; 12]| r[j] + (r[j + 1] - r[j]) * fm;
    let v = row(&table[i]) + (row(&table[i + 1]) - row(&table[i])) * fa;
    // Above the table, thrust falls with air density.
    if alt_m > ALT_M[5] { v * isa(alt_m).density / isa(ALT_M[5]).density } else { v }
}

/// Thrust (N) of an afterburning engine for a spool/lever state `engine` in 0..1.
/// Below `detent` the engine runs dry from idle to military power; above it the
/// afterburner adds thrust up to maximum.
pub fn afterburning_thrust(mil_static_n: f64, ab_static_n: f64, idle: f64, detent: f64, engine: f64, alt_m: f64, mach: f64) -> f64 {
    let mil = mil_static_n * lookup(&MIL, alt_m, mach);
    if engine <= detent {
        let x = (engine / detent.max(1e-3)).clamp(0.0, 1.0);
        return mil * (idle + (1.0 - idle) * x);
    }
    let max = ab_static_n * lookup(&MAX, alt_m, mach);
    let x = ((engine - detent) / (1.0 - detent).max(1e-3)).clamp(0.0, 1.0);
    mil + (max - mil).max(0.0) * (MIN_AB + (1.0 - MIN_AB) * x)
}

/// Wave drag as a fraction of its peak: the measured shape of a fighter's
/// zero-lift drag rise (steep through Mach 0.95-1.05, peaking near 1.2 and
/// easing off supersonically), starting at Mach 0.85.
const WAVE: [(f64, f64); 10] = [
    (0.85, 0.0),
    (0.90, 0.04),
    (0.95, 0.27),
    (1.00, 0.58),
    (1.05, 0.81),
    (1.10, 0.92),
    (1.20, 1.0),
    (1.50, 0.92),
    (2.00, 0.75),
    (2.50, 0.62),
];

/// Wave drag coefficient for an aircraft whose drag rise begins at `rise_mach`.
pub fn wave_drag(peak_cd: f64, rise_mach: f64, mach: f64) -> f64 {
    if peak_cd <= 0.0 {
        return 0.0;
    }
    let m = mach - (rise_mach - WAVE[0].0);
    if m <= WAVE[0].0 {
        return 0.0;
    }
    let last = WAVE[WAVE.len() - 1];
    if m >= last.0 {
        return peak_cd * last.1;
    }
    let i = WAVE.iter().rposition(|&(x, _)| x <= m).unwrap_or(0);
    let (x0, y0) = WAVE[i];
    let (x1, y1) = WAVE[i + 1];
    peak_cd * (y0 + (y1 - y0) * (m - x0) / (x1 - x0))
}

/// Growth of the induced-drag factor past the transonic region, where the
/// leading-edge suction is lost (roughly 2.6x subsonic by Mach 2).
pub fn induced_drag_factor(mach: f64) -> f64 {
    1.0 + 1.5 * (mach - 0.9).max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sea_level_static_matches_ratings() {
        let mil = afterburning_thrust(76_300.0, 131_000.0, 0.06, 0.8, 0.8, 0.0, 0.0);
        let max = afterburning_thrust(76_300.0, 131_000.0, 0.06, 0.8, 1.0, 0.0, 0.0);
        assert!((mil - 76_300.0).abs() < 1.0, "{mil}");
        assert!((max - 131_000.0).abs() < 1.0, "{max}");
        // Lighting the afterburner never reduces thrust.
        let min_ab = afterburning_thrust(76_300.0, 131_000.0, 0.06, 0.8, 0.801, 0.0, 0.0);
        assert!(min_ab > mil);
    }

    #[test]
    fn thrust_lapses_with_altitude_and_rises_with_ram() {
        let t = |alt_ft: f64, m: f64| afterburning_thrust(76_300.0, 131_000.0, 0.06, 0.8, 1.0, alt_ft * 0.3048, m);
        assert!(t(40_000.0, 0.0) < 0.25 * t(0.0, 0.0));
        assert!(t(40_000.0, 1.6) > 2.0 * t(40_000.0, 0.4));
        assert!(t(60_000.0, 1.0) < t(50_000.0, 1.0));
    }

    #[test]
    fn wave_drag_shape() {
        assert_eq!(wave_drag(0.026, 0.85, 0.8), 0.0);
        assert!(wave_drag(0.026, 0.85, 1.0) > 0.012);
        assert!((wave_drag(0.026, 0.85, 1.2) - 0.026).abs() < 1e-9);
        assert!(wave_drag(0.026, 0.85, 2.0) < wave_drag(0.026, 0.85, 1.2));
    }
}
