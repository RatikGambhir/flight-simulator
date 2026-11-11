//! Fixed-timestep driver shared by the native and WASM hosts.

use crate::sim::Simulation;

/// Physics rate in Hz.
pub const SIM_HZ: f64 = 120.0;

/// Accumulates wall time and advances the simulation in fixed steps so the
/// flight model behaves identically regardless of frame rate.
pub struct FixedStepper {
    pub step: f64,
    accumulator: f64,
}

impl Default for FixedStepper {
    fn default() -> Self {
        Self { step: 1.0 / SIM_HZ, accumulator: 0.0 }
    }
}

impl FixedStepper {
    /// Advances by `elapsed` seconds of wall time; returns the number of steps taken.
    /// Long stalls (e.g. the app was suspended) are clamped to avoid a spiral of death.
    pub fn advance(&mut self, sim: &mut Simulation, elapsed: f64) -> usize {
        self.accumulator += elapsed.clamp(0.0, 0.25);
        let mut n = 0;
        while self.accumulator >= self.step {
            sim.step(self.step);
            self.accumulator -= self.step;
            n += 1;
        }
        n
    }

    /// Seconds of wall time until the next fixed step is due.
    #[inline]
    pub fn time_to_next_step(&self) -> f64 {
        (self.step - self.accumulator).max(0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_are_fixed_and_remainder_is_kept() {
        let mut sim = Simulation::new();
        let mut st = FixedStepper::default();
        assert_eq!(st.advance(&mut sim, 2.5 / SIM_HZ), 2);
        assert!((st.time_to_next_step() - 0.5 / SIM_HZ).abs() < 1e-12);
        // Long stalls are clamped.
        assert_eq!(st.advance(&mut sim, 10.0), (0.25 * SIM_HZ) as usize);
    }
}
