//! Wind and atmospheric turbulence.
//!
//! * **Wind** is a steady flow given at the 10 m reference height (how airports
//!   report it) and scaled with height above the ground by the 1/7 power law,
//!   so it is weaker in the flare than at pattern altitude.
//! * **Turbulence** follows a simplified Dryden model (MIL-F-8785C): each gust
//!   component is first-order filtered white noise whose length scale and
//!   intensity depend on height. Rotational gusts come from the gust gradients
//!   over the airframe (roll: vertical gust across the span; pitch and yaw:
//!   vertical and side gusts along the flight path). Their RMS matches the
//!   Dryden rotary spectra, with length scales not taken below the wingspan
//!   (eddies smaller than the airframe partly cancel across it).
//!
//! Everything is deterministic for a given seed so tests are repeatable.

use std::f64::consts::PI;

use glam::DVec3;

use crate::geo::FT_TO_M;

/// Height (m) of the reported surface wind.
const REF_HEIGHT_M: f64 = 10.0;
/// Wind profile exponent (neutral boundary layer over open terrain).
const PROFILE_EXP: f64 = 1.0 / 7.0;
/// Cap on the profile factor (reached ~270 m above ground).
const PROFILE_MAX: f64 = 1.6;

/// Small, fast PRNG (xorshift64*) with Gaussian sampling.
#[derive(Debug, Clone)]
struct Rng {
    state: u64,
    spare: Option<f64>,
}

impl Rng {
    const fn new(seed: u64) -> Self {
        Self { state: seed | 1, spare: None }
    }

    #[inline]
    fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.state = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    /// Uniform in (0, 1].
    #[inline]
    fn uniform(&mut self) -> f64 {
        ((self.next_u64() >> 11) as f64 + 1.0) * (1.0 / (1u64 << 53) as f64)
    }

    /// Standard normal (Box-Muller, caching the second value).
    fn gaussian(&mut self) -> f64 {
        if let Some(v) = self.spare.take() {
            return v;
        }
        let r = (-2.0 * self.uniform().ln()).sqrt();
        let (s, c) = (std::f64::consts::TAU * self.uniform()).sin_cos();
        self.spare = Some(r * s);
        r * c
    }
}

/// User-facing weather settings.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WeatherSettings {
    /// Direction the wind blows *from*, degrees true.
    pub wind_from_deg: f64,
    /// Surface wind speed at 10 m (m/s).
    pub wind_speed_ms: f64,
    /// Turbulence intensity, 0 (calm) to 1 (severe).
    pub turbulence: f64,
}

impl Default for WeatherSettings {
    fn default() -> Self {
        Self { wind_from_deg: 270.0, wind_speed_ms: 0.0, turbulence: 0.0 }
    }
}

/// Dryden turbulence scales at one height (MIL-F-8785C).
#[derive(Debug, Clone, Copy)]
struct Scales {
    /// Horizontal (u and v) length scale, m.
    l_u: f64,
    /// Vertical (w) length scale, m.
    l_w: f64,
    /// RMS horizontal (u and v) gust, m/s.
    sigma_u: f64,
    /// RMS vertical gust, m/s.
    sigma_w: f64,
}

/// RMS rotational gusts (roll, pitch, yaw rates in rad/s) for wingspan `b`,
/// variance-matched to the MIL-F-8785C / MIL-HDBK-1797 Dryden rotary spectra
///
/// ```text
/// Φp(ω) = σw² / (Lw V) · 0.8 (π Lw / 4b)^⅓ / (1 + (4bω / πV)²)
/// Φq(ω) = (ω/V)² / (1 + (4bω / πV)²) · Φw(ω)
/// Φr(ω) = (ω/V)² / (1 + (3bω / πV)²) · Φv(ω)
/// ```
///
/// where Φw, Φv are the Dryden vertical and lateral spectra
/// (σ² L / πV · (1 + 3(Lω/V)²) / (1 + (Lω/V)²)²). Integrated over ω ≥ 0 they
/// give, independent of airspeed,
///
/// ```text
/// σp = σw · π √(0.1 / (Lw b)) · (π Lw / 4b)^⅙
/// σq = σw · √(π (2k + 3) / (8 b Lw)) / (1 + k),   k = 4b / (π Lw)
/// σr = σv · √(π (2k + 3) / (6 b Lv)) / (1 + k),   k = 3b / (π Lv)
/// ```
///
/// Gust penetration: the rotary spectra assume eddies at least as large as
/// the airframe. Near the ground Lw = h is much shorter than a jet's span, and
/// eddies that small partly cancel across it rather than rolling it harder (σp
/// would otherwise grow as Lw^-⅓ toward the runway), so neither length scale is
/// taken below the span.
fn rotary_sigma(s: &Scales, b: f64) -> DVec3 {
    let lw = s.l_w.max(b);
    let lv = s.l_u.max(b);
    let p = s.sigma_w * PI * (0.1 / (lw * b)).sqrt() * (PI * lw / (4.0 * b)).powf(1.0 / 6.0);
    let kq = 4.0 * b / (PI * lw);
    let q = s.sigma_w * (PI * (2.0 * kq + 3.0) / (8.0 * b * lw)).sqrt() / (1.0 + kq);
    let kr = 3.0 * b / (PI * lv);
    let r = s.sigma_u * (PI * (2.0 * kr + 3.0) / (6.0 * b * lv)).sqrt() / (1.0 + kr);
    DVec3::new(p, q, r)
}

/// Wind field state around the aircraft.
#[derive(Debug, Clone)]
pub struct Weather {
    pub settings: WeatherSettings,
    /// Linear gust velocity in the local frame (along-wind, cross-wind, up), m/s.
    gust: DVec3,
    /// Rotational gust rates (roll, pitch, yaw), rad/s, body axes.
    rot: DVec3,
    rng: Rng,
}

impl Default for Weather {
    fn default() -> Self {
        Self { settings: WeatherSettings::default(), gust: DVec3::ZERO, rot: DVec3::ZERO, rng: Rng::new(0x9e37_79b9_7f4a_7c15) }
    }
}

impl Weather {
    pub fn set(&mut self, settings: WeatherSettings) {
        self.settings = WeatherSettings {
            wind_from_deg: if settings.wind_from_deg.is_finite() { settings.wind_from_deg.rem_euclid(360.0) } else { 0.0 },
            wind_speed_ms: if settings.wind_speed_ms.is_finite() { settings.wind_speed_ms.clamp(0.0, 60.0) } else { 0.0 },
            turbulence: if settings.turbulence.is_finite() { settings.turbulence.clamp(0.0, 1.0) } else { 0.0 },
        };
    }

    /// Clears gusts (on spawn) so a new flight doesn't start mid-gust.
    pub fn reset_gusts(&mut self) {
        self.gust = DVec3::ZERO;
        self.rot = DVec3::ZERO;
    }

    /// Unit vector (east, north) the wind blows *toward*.
    #[inline]
    fn downwind(&self) -> (f64, f64) {
        let (s, c) = self.settings.wind_from_deg.to_radians().sin_cos();
        (-s, -c)
    }

    /// Steady wind speed (m/s) at a height above ground.
    #[inline]
    pub fn steady_speed(&self, agl_m: f64) -> f64 {
        let f = (agl_m.max(0.5) / REF_HEIGHT_M).powf(PROFILE_EXP).min(PROFILE_MAX);
        self.settings.wind_speed_ms * f
    }

    /// RMS vertical gust intensity (m/s) at a height, combining the
    /// requested turbulence with mechanical turbulence from surface wind.
    fn sigma_w(&self, agl_m: f64) -> f64 {
        let s = &self.settings;
        // Light ~0.25, moderate ~0.5, severe ~1.0 of the 20 ft wind scale.
        let convective = s.turbulence * s.turbulence * 6.0 + s.turbulence * 1.2;
        // Mechanical turbulence fades out above ~2000 ft.
        let mech_fade = (1.0 - agl_m / (2000.0 * FT_TO_M)).clamp(0.0, 1.0);
        let mechanical = 0.1 * s.wind_speed_ms * 1.3 * mech_fade;
        (convective + mechanical).max(0.0)
    }

    /// RMS vertical gust (m/s) at a height above ground: the gust intensity a
    /// pilot would read from a weather report (light ≈ 0.8, moderate ≈ 1.5+).
    pub fn gust_intensity(&self, agl_m: f64) -> f64 {
        self.sigma_w(agl_m)
    }

    /// Wind velocity (m/s) in local ENU at a height above ground, including gusts.
    pub fn wind_enu(&self, agl_m: f64) -> DVec3 {
        let (de, dn) = self.downwind();
        let v = self.steady_speed(agl_m) + self.gust.x;
        // Cross-wind gust is perpendicular to the mean wind (to its right).
        let (ce, cn) = (dn, -de);
        DVec3::new(de * v + ce * self.gust.y, dn * v + cn * self.gust.y, self.gust.z)
    }

    /// Rotational turbulence (body roll, pitch, yaw rates in rad/s).
    #[inline]
    pub fn rotational_gust(&self) -> DVec3 {
        self.rot
    }

    /// MIL-F-8785C length scales and intensities at a height: low-altitude
    /// scales below 1000 ft, medium-altitude (isotropic) above.
    fn scales(&self, agl_m: f64) -> Scales {
        let sigma_w = self.sigma_w(agl_m);
        let h_ft = (agl_m / FT_TO_M).max(10.0);
        if h_ft < 1000.0 {
            let d = 0.177 + 0.000_823 * h_ft;
            Scales { l_u: h_ft / d.powf(1.2) * FT_TO_M, l_w: h_ft * FT_TO_M, sigma_u: sigma_w / d.powf(0.4), sigma_w }
        } else {
            let l = 1750.0 * FT_TO_M;
            Scales { l_u: l, l_w: l, sigma_u: sigma_w, sigma_w }
        }
    }

    /// Advances the gust filters by `dt` for an aircraft flying at `airspeed`
    /// with wingspan `span_m` at `agl_m` above the ground.
    pub fn step(&mut self, dt: f64, airspeed: f64, agl_m: f64, span_m: f64) {
        let sc = self.scales(agl_m);
        if sc.sigma_w < 1e-4 {
            // Let any residual gust decay smoothly to calm air.
            let k = (-dt * 2.0).exp();
            self.gust *= k;
            self.rot *= k;
            return;
        }
        let v = airspeed.max(5.0);
        let mut markov = |x: f64, sigma: f64, l: f64| {
            let a = v / l.max(1.0);
            let decay = (-a * dt).exp();
            x * decay + sigma * (1.0 - decay * decay).sqrt() * self.rng.gaussian()
        };
        self.gust.x = markov(self.gust.x, sc.sigma_u, sc.l_u);
        self.gust.y = markov(self.gust.y, sc.sigma_u, sc.l_u);
        self.gust.z = markov(self.gust.z, sc.sigma_w, sc.l_w);
        // Rotational gusts: first-order processes with the Dryden RMS and the
        // span filter's corner (πV/4b for roll and pitch, πV/3b for yaw).
        let b = span_m.max(5.0);
        let sigma = rotary_sigma(&sc, b);
        self.rot.x = markov(self.rot.x, sigma.x, 4.0 * b / PI);
        self.rot.y = markov(self.rot.y, sigma.y, 4.0 * b / PI);
        self.rot.z = markov(self.rot.z, sigma.z, 3.0 * b / PI);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wind_blows_from_the_given_direction() {
        let mut w = Weather::default();
        w.set(WeatherSettings { wind_from_deg: 270.0, wind_speed_ms: 10.0, turbulence: 0.0 });
        let v = w.wind_enu(10.0);
        // A west wind blows toward the east.
        assert!(v.x > 9.9 && v.y.abs() < 1e-9, "{v:?}");
    }

    #[test]
    fn wind_profile_grows_with_height() {
        let mut w = Weather::default();
        w.set(WeatherSettings { wind_from_deg: 0.0, wind_speed_ms: 10.0, turbulence: 0.0 });
        assert!(w.steady_speed(2.0) < w.steady_speed(10.0));
        assert!((w.steady_speed(10.0) - 10.0).abs() < 1e-9);
        assert!((w.steady_speed(5000.0) - 16.0).abs() < 1e-9);
    }

    #[test]
    fn turbulence_has_the_requested_intensity() {
        let mut w = Weather::default();
        w.set(WeatherSettings { wind_from_deg: 0.0, wind_speed_ms: 0.0, turbulence: 0.5 });
        let (dt, n) = (1.0 / 120.0, 120 * 600);
        let mut sum2 = 0.0;
        for _ in 0..n {
            w.step(dt, 120.0, 1500.0, 35.0);
            sum2 += w.gust.z * w.gust.z;
        }
        let rms = (sum2 / n as f64).sqrt();
        let expected = w.sigma_w(1500.0);
        assert!((rms - expected).abs() < expected * 0.35, "rms {rms} vs {expected}");
    }

    /// Integrates a one-sided spectrum over ω in (0, ∞) on a log grid.
    fn integrate(f: impl Fn(f64) -> f64) -> f64 {
        let (lo, hi, n) = (1e-6_f64.ln(), 1e6_f64.ln(), 40_000);
        let h = (hi - lo) / n as f64;
        let g = |i: usize| {
            let w = (lo + i as f64 * h).exp();
            f(w) * w
        };
        (0..n).map(|i| 0.5 * (g(i) + g(i + 1)) * h).sum()
    }

    /// RMS roll, pitch and yaw rates of the MIL-F-8785C Dryden rotary spectra
    /// at airspeed `v`, by numerical integration, with the length scales held
    /// at no less than the span `b` (gust penetration).
    fn dryden_rotary_rms(s: &Scales, b: f64, v: f64) -> [f64; 3] {
        let (lw, lv) = (s.l_w.max(b), s.l_u.max(b));
        let dryden = |sigma: f64, l: f64, w: f64| {
            let x = l * w / v;
            sigma * sigma * l / (PI * v) * (1.0 + 3.0 * x * x) / (1.0 + x * x).powi(2)
        };
        let span = |c: f64, w: f64| 1.0 / (1.0 + (c * b * w / (PI * v)).powi(2));
        let p = integrate(|w| s.sigma_w.powi(2) / (lw * v) * 0.8 * (PI * lw / (4.0 * b)).cbrt() * span(4.0, w));
        let q = integrate(|w| (w / v).powi(2) * span(4.0, w) * dryden(s.sigma_w, lw, w));
        let r = integrate(|w| (w / v).powi(2) * span(3.0, w) * dryden(s.sigma_u, lv, w));
        [p.sqrt(), q.sqrt(), r.sqrt()]
    }

    #[test]
    fn rotary_gusts_match_the_dryden_spectra() {
        // Moderate turbulence and a 15 kt wind. (span, airspeed, height):
        // 737-size and C172-size in the flare (Lw = 20 ft, shorter than either
        // span), and C172-size at 300 ft (Lw longer than the span).
        let cases = [(35.8, 70.0, 20.0), (11.0, 33.0, 20.0), (11.0, 33.0, 300.0)];
        for (b, v, h_ft) in cases {
            let h = h_ft * FT_TO_M;
            let mut w = Weather::default();
            w.set(WeatherSettings { wind_from_deg: 250.0, wind_speed_ms: 7.7, turbulence: 0.45 });
            let expected = dryden_rotary_rms(&w.scales(h), b, v);
            let closed = rotary_sigma(&w.scales(h), b).to_array();
            for i in 0..3 {
                let err = closed[i] / expected[i] - 1.0;
                assert!(err.abs() < 0.01, "span {b} at {h_ft} ft, axis {i}: closed form {} vs spectrum {}", closed[i], expected[i]);
            }
            let (dt, n) = (1.0 / 120.0, 120 * 1200);
            let mut sum2 = DVec3::ZERO;
            for _ in 0..n {
                w.step(dt, v, h, b);
                sum2 += w.rot * w.rot;
            }
            let rms = (sum2 / n as f64).to_array().map(f64::sqrt);
            for i in 0..3 {
                let err = rms[i] / expected[i] - 1.0;
                assert!(err.abs() < 0.1, "span {b} at {h_ft} ft, axis {i}: simulated rms {:.4} vs spectrum {:.4} rad/s", rms[i], expected[i]);
            }
        }
    }

    #[test]
    fn calm_air_stays_calm() {
        let mut w = Weather::default();
        for _ in 0..1000 {
            w.step(1.0 / 120.0, 100.0, 300.0, 30.0);
        }
        assert_eq!(w.wind_enu(300.0), DVec3::ZERO);
        assert_eq!(w.rotational_gust(), DVec3::ZERO);
    }
}
