//! International Standard Atmosphere (ISA) up to 20 km.

pub const RHO_SL: f64 = 1.225;
pub const G0: f64 = 9.806_65;
const R_AIR: f64 = 287.052_87;
const T_SL: f64 = 288.15;
const P_SL: f64 = 101_325.0;
const LAPSE: f64 = 0.0065;
const TROPOPAUSE: f64 = 11_000.0;

#[derive(Debug, Clone, Copy)]
pub struct AirState {
    pub temperature_k: f64,
    pub pressure_pa: f64,
    pub density: f64,
    pub speed_of_sound: f64,
}

/// ISA conditions at a geopotential altitude in meters (clamped to -500..20000 m).
pub fn isa(alt_m: f64) -> AirState {
    let h = alt_m.clamp(-500.0, 20_000.0);
    let (t, p) = if h <= TROPOPAUSE {
        let t = T_SL - LAPSE * h;
        (t, P_SL * (t / T_SL).powf(G0 / (LAPSE * R_AIR)))
    } else {
        let t11 = T_SL - LAPSE * TROPOPAUSE;
        let p11 = P_SL * (t11 / T_SL).powf(G0 / (LAPSE * R_AIR));
        (t11, p11 * (-G0 * (h - TROPOPAUSE) / (R_AIR * t11)).exp())
    };
    AirState {
        temperature_k: t,
        pressure_pa: p,
        density: p / (R_AIR * t),
        speed_of_sound: (1.4 * R_AIR * t).sqrt(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sea_level_and_cruise() {
        let sl = isa(0.0);
        assert!((sl.density - 1.225).abs() < 1e-3);
        let fl350 = isa(10_668.0);
        assert!((fl350.density - 0.38).abs() < 0.01, "{}", fl350.density);
        assert!((isa(11_500.0).temperature_k - 216.65).abs() < 1e-6);
    }
}
