//! Tracks approach legs and calculates the path and guidance to the selected runway.

use std::f64::consts::PI;

use crate::geo::{wrap_deg_360, M_TO_FT};

use super::nav::{self, angle_diff, bearing_to, established, line_track, ApproachGeometry, CHI_DOWNWIND};
use super::perf::GLIDESLOPE_DEG;
use super::{ApInputs, Autopilot, Lateral, Perf, Phase};

/// Approach leg (internal).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(super) enum Leg {
    #[default]
    None,
    DirectFinal,
    DirectDownwind,
    Downwind,
    Intercept,
    Localizer,
}

/// Approach-relative state for one step (all copies, no borrows).
#[derive(Debug, Clone, Copy)]
pub(super) struct Ctx {
    pub(super) along: f64,
    pub(super) cross: f64,
    pub(super) dist: f64,
    pub(super) course: f64,
    pub(super) trk_err: f64,
    /// Wheels above the threshold (m).
    pub(super) h_thr: f64,
    /// Glidepath height above the threshold here (m).
    pub(super) gs_h: f64,
    pub(super) elev_ft: f64,
    pub(super) length: f64,
    pub(super) width: f64,
    pub(super) aim: f64,
    pub(super) geo: ApproachGeometry,
    pub(super) path_total: f64,
    pub(super) path_to_level: f64,
}

/// Approach legs are re-evaluated with some hysteresis; this many seconds must pass between changes.
pub(super) const LEG_HOLD_S: f64 = 4.0;

impl Autopilot {
    pub(super) fn runway_ident(&self) -> String {
        self.runway.as_ref().map(|r| r.ident.clone()).unwrap_or_default()
    }

    pub(super) fn terminal_leg(&self) -> bool {
        matches!(self.leg, Leg::Downwind | Leg::Intercept | Leg::Localizer)
    }

    pub(super) fn ctx(&self, inp: &ApInputs, perf: &Perf) -> Option<Ctx> {
        let rw = self.runway.as_ref()?;
        let geo = self.geom.unwrap_or_else(|| ApproachGeometry::new(perf, rw));
        let (along, cross) = rw.frame(inp.lat, inp.lon);
        let mut ctx = Ctx {
            along,
            cross,
            dist: along.hypot(cross),
            course: rw.course,
            trk_err: angle_diff(inp.track.to_radians(), rw.course),
            h_thr: inp.wheels_h() - rw.elevation_m,
            gs_h: rw.glidepath_height(along),
            elev_ft: rw.elevation_ft_msl(),
            length: rw.length_m,
            width: rw.width_m,
            aim: rw.aim_along(),
            geo,
            path_total: 0.0,
            path_to_level: 0.0,
        };
        let (total, to_level) = self.path_estimate(&ctx, perf);
        ctx.path_total = total;
        ctx.path_to_level = to_level;
        Some(ctx)
    }

    /// Remaining path to the runway and the distance to where the aircraft
    /// should be down at pattern height (both m), for the current leg.
    fn path_estimate(&self, ctx: &Ctx, perf: &Perf) -> (f64, f64) {
        let g = &ctx.geo;
        let (a, c) = (ctx.along, ctx.cross);
        // Level off at pattern height early enough to slow to approach speed at idle.
        let level_before = g.gs_intercept + perf.decel_distance_m();
        let leg = if self.leg == Leg::None { self.initial_leg(ctx) } else { self.leg };
        match leg {
            Leg::Localizer | Leg::Intercept => {
                let total = (-a).max(0.0) + 0.5 * c.abs();
                (total, total - level_before)
            }
            Leg::DirectFinal | Leg::None => {
                let (ea, ec) = g.final_entry();
                let d = (a - ea).hypot(c - ec);
                let dir = (ec - c).atan2(ea - a);
                let total = d + nav::turn_distance(g.radius, dir) + (-ea);
                (total, total - level_before)
            }
            Leg::DirectDownwind => {
                let (ea, ec) = g.downwind_entry(self.side);
                let d = (a - ea).hypot(c - ec);
                let base = -g.base_turn_along();
                (d + base + PI * g.radius + base, d)
            }
            Leg::Downwind => {
                let base = -g.base_turn_along();
                let remaining = (a + base).max(0.0);
                (remaining + (c - self.side * g.downwind_offset).abs() + PI * g.radius + base, 0.0)
            }
        }
    }

    /// Descent profile altitude (ft MSL) at the current path distance.
    pub(super) fn profile_ft(&self, ctx: &Ctx, perf: &Perf) -> f64 {
        ctx.elev_ft + (perf.pattern_height_m() + ctx.path_to_level.max(0.0) * GLIDESLOPE_DEG.to_radians().tan()) * M_TO_FT
    }

    /// Leg to start with from a position (no history).
    pub(super) fn initial_leg(&self, ctx: &Ctx) -> Leg {
        let g = &ctx.geo;
        let in_sector = ApproachGeometry::in_straight_in_sector(ctx.along, ctx.cross);
        if ctx.dist > g.terminal {
            if in_sector { Leg::DirectFinal } else { Leg::DirectDownwind }
        } else if g.straight_in_ok(ctx.along, ctx.cross, false) {
            Leg::Intercept
        } else {
            Leg::Downwind
        }
    }

    pub(super) fn pick_side(cross: f64) -> f64 {
        if cross.abs() > 100.0 { cross.signum() } else { -1.0 }
    }

    pub(super) fn set_leg(&mut self, leg: Leg) {
        if leg != self.leg {
            self.leg = leg;
            self.leg_time = 0.0;
        }
    }

    /// Updates the approach leg (with hysteresis) and returns the track to fly (degrees).
    pub(super) fn route_track(&mut self, inp: &ApInputs, ctx: &Ctx) -> f64 {
        let g = ctx.geo;
        let (a, c) = (ctx.along, ctx.cross);
        let in_sector = ApproachGeometry::in_straight_in_sector(a, c);
        // Lock the runway choice once inside the terminal area.
        if !self.runway_locked && ctx.dist < g.terminal {
            self.runway_locked = true;
        }
        let can_change = self.leg_time >= LEG_HOLD_S;
        let next = match self.leg {
            Leg::Localizer => Leg::Localizer,
            Leg::None => {
                let l = self.initial_leg(ctx);
                if matches!(l, Leg::DirectDownwind | Leg::Downwind) {
                    self.side = Self::pick_side(c);
                }
                l
            }
            Leg::DirectFinal => {
                let (ea, ec) = g.final_entry();
                let near_entry = (a - ea).hypot(c - ec) < 2.5 * g.radius;
                if ctx.dist < g.terminal && (g.straight_in_ok(a, c, false) || near_entry) {
                    Leg::Intercept
                } else if ctx.dist > g.terminal + 5_000.0 && !in_sector {
                    self.side = Self::pick_side(c);
                    Leg::DirectDownwind
                } else {
                    Leg::DirectFinal
                }
            }
            Leg::DirectDownwind => {
                if ctx.dist < g.terminal {
                    Leg::Downwind
                } else if in_sector && ctx.dist > g.terminal + 5_000.0 {
                    Leg::DirectFinal
                } else {
                    Leg::DirectDownwind
                }
            }
            Leg::Downwind => {
                if -a >= -g.base_turn_along() {
                    Leg::Intercept
                } else {
                    Leg::Downwind
                }
            }
            Leg::Intercept => {
                let est = c.abs() < 400.0 && ctx.trk_err.abs() < 45f64.to_radians();
                if !g.straight_in_ok(a, c, true) && !est {
                    self.side = Self::pick_side(c);
                    Leg::Downwind
                } else {
                    Leg::Intercept
                }
            }
        };
        if next != self.leg && (can_change || self.leg == Leg::None) {
            self.set_leg(next);
        }
        if self.leg == Leg::Intercept && a < 0.0 && established(c, ctx.trk_err) {
            self.set_leg(Leg::Localizer);
        }

        // Convergence time for the path-following fields: slow enough for the
        // bank-limited turn rate at this speed.
        let v = inp.gs_ms.max(30.0);
        let tight = matches!(self.phase, Phase::Final | Phase::Flare);
        let gain = if tight { 2.5 } else { 1.4 };
        let inner = v / (crate::atmosphere::G0 * gain);
        let tau = (3.0 * inner).max(if tight { 7.0 } else { 15.0 });
        let k = 1.0 / (v * tau);
        let track = match self.leg {
            Leg::DirectFinal | Leg::None => {
                self.lateral = Lateral::Direct;
                let (ea, ec) = g.final_entry();
                let (la, lo) = self.runway.as_ref().map_or((inp.lat, inp.lon), |r| r.point(ea, ec));
                bearing_to(inp.lat, inp.lon, la, lo)
            }
            Leg::DirectDownwind => {
                self.lateral = Lateral::Direct;
                let (ea, ec) = g.downwind_entry(self.side);
                let (la, lo) = self.runway.as_ref().map_or((inp.lat, inp.lon), |r| r.point(ea, ec));
                bearing_to(inp.lat, inp.lon, la, lo)
            }
            Leg::Downwind => {
                self.lateral = Lateral::Downwind;
                let cross_dw = -(c - self.side * g.downwind_offset);
                line_track(ctx.course + PI, cross_dw, k, CHI_DOWNWIND)
            }
            Leg::Intercept => {
                self.lateral = Lateral::Intercept;
                line_track(ctx.course, c, k, 60f64.to_radians())
            }
            Leg::Localizer => {
                self.lateral = Lateral::Localizer;
                line_track(ctx.course, c, k, 30f64.to_radians())
            }
        };
        wrap_deg_360(track.to_degrees())
    }
}
