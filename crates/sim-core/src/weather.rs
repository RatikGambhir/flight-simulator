//! Wind and atmospheric turbulence.
//!
//! * **Wind** is a steady flow given at the 10 m reference height (how airports
//!   report it) and scaled with height above the ground by the 1/7 power law,
//!   so it is weaker in the flare than at pattern altitude.
//! * **Turbulence** follows a simplified Dryden model (MIL-F-8785C): each gust
//!   component is first-order filtered white noise whose length scale and
//!   intensity depend on height. Rotational gusts (mostly roll) come from the
//!   vertical gust gradient across the wingspan.
//!
//! Everything is deterministic for a given seed so tests are repeatable.

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

    /// Advances the gust filters by `dt` for an aircraft flying at `airspeed`
    /// with wingspan `span_m` at `agl_m` above the ground.
    pub fn step(&mut self, dt: f64, airspeed: f64, agl_m: f64, span_m: f64) {
        let sigma_w = self.sigma_w(agl_m);
        if sigma_w < 1e-4 {
            // Let any residual gust decay smoothly to calm air.
            let k = (-dt * 2.0).exp();
            self.gust *= k;
            self.rot *= k;
            return;
        }
        let v = airspeed.max(5.0);
        let h_ft = (agl_m / FT_TO_M).max(10.0);
        // MIL-F-8785C low-altitude scales, blending to medium altitude above 2000 ft.
        let (lu, lw, sigma_u) = if h_ft < 1000.0 {
            let lu = h_ft / (0.177 + 0.000_823 * h_ft).powf(1.2) * FT_TO_M;
            let lw = h_ft * FT_TO_M;
            (lu, lw, sigma_w / (0.177 + 0.000_823 * h_ft).powf(0.4))
        } else {
            let l = 1750.0 * FT_TO_M;
            (l, l, sigma_w)
        };
        let mut markov = |x: f64, sigma: f64, l: f64| {
            let a = v / l.max(1.0);
            let decay = (-a * dt).exp();
            x * decay + sigma * (1.0 - decay * decay).sqrt() * self.rng.gaussian()
        };
        self.gust.x = markov(self.gust.x, sigma_u, lu);
        self.gust.y = markov(self.gust.y, sigma_u, lu);
        self.gust.z = markov(self.gust.z, sigma_w, lw);
        // Rotational gusts: roll from the gust gradient across the span (strongest), smaller pitch/yaw.
        let b = span_m.max(5.0);
        let sigma_p = 1.9 * sigma_w / (lw.max(b) * b).sqrt();
        let rot_l = (4.0 * b / std::f64::consts::PI).max(1.0);
        self.rot.x = markov(self.rot.x, sigma_p, rot_l);
        self.rot.y = markov(self.rot.y, sigma_p * 0.45, rot_l);
        self.rot.z = markov(self.rot.z, sigma_p * 0.35, rot_l);
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
