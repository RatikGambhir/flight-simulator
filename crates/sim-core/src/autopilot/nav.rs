//! Navigation geometry for the autopilot: runway frames, runway selection,
//! path-following laws and the approach path estimate.
//!
//! Runway frame: origin at the start of the pavement at the runway end being
//! used, `along` measured in the direction of travel (landing or takeoff) and
//! `cross` to the right of the centreline. It is an azimuthal equidistant
//! projection about the runway end, so distances from the runway are exact
//! at any range and the frame is exact along the centreline.

use std::f64::consts::{FRAC_PI_2, PI};

use crate::geo::{self, wrap_deg_180, FT_TO_M};
use crate::world::{self, Airport, Runway};

use super::perf::{Perf, GLIDESLOPE_DEG};

/// Where the autopilot is flying to.
#[derive(Debug, Clone)]
pub struct NavTarget {
    pub airport: Airport,
    pub runways: Vec<Runway>,
    /// Runway end to use when suitable (e.g. the one a final-approach start lined up with).
    pub preferred_runway: Option<String>,
}

impl NavTarget {
    pub fn lookup(ident: &str, preferred_runway: Option<String>) -> Option<Self> {
        let db = world::db();
        let airport = db.airport(ident)?;
        let runways = db.runways_of(airport).to_vec();
        if runways.is_empty() {
            return None;
        }
        Some(Self { airport: airport.clone(), runways, preferred_runway })
    }
}

/// Surface wind (direction it blows from, speed).
#[derive(Debug, Clone, Copy, Default)]
pub struct Wind {
    pub from_deg: f64,
    pub speed_kt: f64,
}

impl Wind {
    /// (headwind, crosswind from the right) components in knots for a course in radians.
    pub fn components(&self, course: f64) -> (f64, f64) {
        let rel = self.from_deg.to_radians() - course;
        (self.speed_kt * rel.cos(), self.speed_kt * rel.sin())
    }
}

pub fn is_hard_surface(surface: &str) -> bool {
    let s = surface.to_ascii_uppercase();
    ["ASP", "CON", "PEM", "BIT", "PAV", "MAC", "TAR", "TRE", "PSP"].iter().any(|p| s.starts_with(p))
}

/// One usable direction of a runway.
#[derive(Debug, Clone, PartialEq)]
pub struct RunwayGeom {
    pub airport: String,
    pub ident: String,
    /// Start of the pavement at this end (degrees).
    pub lat: f64,
    pub lon: f64,
    /// Direction of travel (radians true).
    pub course: f64,
    pub length_m: f64,
    pub width_m: f64,
    /// Displaced threshold: landing starts this far along.
    pub displaced_m: f64,
    /// Runway surface height at the threshold (m above the ellipsoid).
    pub elevation_m: f64,
    pub hard: bool,
}

impl RunwayGeom {
    pub fn new(airport: &Airport, rw: &Runway, end: usize) -> Self {
        let e = &rw.ends[end];
        let f = &rw.ends[1 - end];
        let (la, lo, fla, flo) = (e.lat.to_radians(), e.lon.to_radians(), f.lat.to_radians(), f.lon.to_radians());
        let geo_len = geo::haversine_m(la, lo, fla, flo);
        let course = if geo_len > 50.0 { geo::initial_bearing(la, lo, fla, flo) } else { e.heading_deg.to_radians() };
        let length_m = if rw.length_ft > 100.0 { rw.length_ft * FT_TO_M } else { geo_len };
        let elev_ft = e.elevation_ft.unwrap_or(airport.elevation_ft);
        Self {
            airport: airport.ident.clone(),
            ident: e.ident.clone(),
            lat: e.lat,
            lon: e.lon,
            course,
            length_m: length_m.max(100.0),
            width_m: (rw.width_ft * FT_TO_M).max(10.0),
            displaced_m: (e.displaced_threshold_ft * FT_TO_M).clamp(0.0, length_m * 0.5),
            elevation_m: world::msl_ft_to_ellipsoid_m(e.lat, e.lon, elev_ft),
            hard: is_hard_surface(&rw.surface),
        }
    }

    pub fn course_deg(&self) -> f64 {
        geo::wrap_deg_360(self.course.to_degrees())
    }

    /// (along, cross) in meters of a point (degrees) in the runway frame.
    pub fn frame(&self, lat: f64, lon: f64) -> (f64, f64) {
        let (la, lo) = (self.lat.to_radians(), self.lon.to_radians());
        let (pa, po) = (lat.to_radians(), lon.to_radians());
        let d = geo::haversine_m(la, lo, pa, po);
        if d < 1e-3 {
            return (0.0, 0.0);
        }
        let b = geo::initial_bearing(la, lo, pa, po) - self.course;
        (d * b.cos(), d * b.sin())
    }

    /// Point (degrees) at a runway-frame position.
    pub fn point(&self, along: f64, cross: f64) -> (f64, f64) {
        let d = along.hypot(cross);
        if d < 1e-3 {
            return (self.lat, self.lon);
        }
        let (la, lo) = geo::destination(self.lat.to_radians(), self.lon.to_radians(), self.course + cross.atan2(along), d);
        (la.to_degrees(), lo.to_degrees())
    }

    pub fn landing_length_m(&self) -> f64 {
        self.length_m - self.displaced_m
    }

    /// Glidepath aim point, measured along the runway.
    pub fn aim_along(&self) -> f64 {
        self.displaced_m + (0.2 * self.landing_length_m()).clamp(60.0, 300.0)
    }

    /// Glidepath height above the threshold elevation at `along` (m).
    pub fn glidepath_height(&self, along: f64) -> f64 {
        (self.aim_along() - along) * GLIDESLOPE_DEG.to_radians().tan()
    }

    /// Whether a runway-frame point lies on the pavement (with a margin in meters).
    pub fn contains(&self, along: f64, cross: f64, margin: f64) -> bool {
        along >= -margin && along <= self.length_m + margin && cross.abs() <= self.width_m * 0.5 + margin
    }
}

/// Scores one runway direction for landing; lower is better.
fn landing_score(g: &RunwayGeom, perf: &Perf, wind: Wind, from: Option<(f64, f64)>, preferred: Option<&str>) -> f64 {
    let mut score = 0.0;
    let avail = g.landing_length_m();
    if avail < perf.required_landing_m {
        score += 1000.0 + (perf.required_landing_m - avail);
    }
    if perf.hard_surface_only && !g.hard {
        score += 600.0;
    }
    let (head, cross) = wind.components(g.course);
    if -head > perf.tailwind_limit_kt {
        score += 300.0 + (-head - perf.tailwind_limit_kt) * 20.0;
    }
    if cross.abs() > perf.crosswind_limit_kt {
        score += 200.0 + (cross.abs() - perf.crosswind_limit_kt) * 10.0;
    }
    score += cross.abs() * 1.5 - head * 3.0;
    if let Some((lat, lon)) = from {
        // Prefer runways we can fly straight in to.
        let (along, crossd) = g.frame(lat, lon);
        let off = crossd.atan2(-along).abs().to_degrees();
        score += off * 0.12;
    }
    score -= (avail / 1000.0).min(4.0) * 2.0;
    if preferred.is_some_and(|p| p.eq_ignore_ascii_case(&g.ident)) {
        score -= 60.0;
    }
    score
}

/// Picks the landing runway direction: long enough, into the wind, then
/// whichever needs the least manoeuvring from where we are.
pub fn choose_landing_runway(target: &NavTarget, perf: &Perf, wind: Wind, from: Option<(f64, f64)>) -> Option<RunwayGeom> {
    let pref = target.preferred_runway.as_deref();
    let mut best: Option<(f64, RunwayGeom)> = None;
    for rw in &target.runways {
        for end in 0..2 {
            let g = RunwayGeom::new(&target.airport, rw, end);
            let s = landing_score(&g, perf, wind, from, pref);
            if best.as_ref().is_none_or(|(b, _)| s < *b) {
                best = Some((s, g));
            }
        }
    }
    best.map(|(_, g)| g)
}

/// The runway the aircraft is sitting on, if any: within the pavement and
/// pointing roughly along it (within `max_heading_err_deg`). Returns the
/// direction matching the heading and the aircraft's (along, cross).
pub fn runway_under(lat: f64, lon: f64, heading_deg: f64, max_heading_err_deg: f64) -> Option<(RunwayGeom, f64, f64)> {
    let db = world::db();
    let mut best: Option<(f64, RunwayGeom, f64, f64)> = None;
    for (_, ap) in db.nearest_airports(lat, lon, 8.0, 6) {
        for rw in db.runways_of(ap) {
            for end in 0..2 {
                let g = RunwayGeom::new(ap, rw, end);
                let (a, c) = g.frame(lat, lon);
                let herr = wrap_deg_180(heading_deg - g.course_deg()).abs();
                if g.contains(a, c, 8.0) && herr <= max_heading_err_deg {
                    let score = herr + c.abs();
                    if best.as_ref().is_none_or(|(b, ..)| score < *b) {
                        best = Some((score, g, a, c));
                    }
                }
            }
        }
    }
    best.map(|(_, g, a, c)| (g, a, c))
}

/// Takeoff runway for an aircraft on the ground near an airport: long enough,
/// into the wind, with a short taxi. Returns `None` when there is no runway
/// within `radius_km`.
pub fn choose_takeoff_runway(lat: f64, lon: f64, perf: &Perf, wind: Wind, radius_km: f64) -> Option<RunwayGeom> {
    let db = world::db();
    let mut best: Option<(f64, RunwayGeom)> = None;
    for (_, ap) in db.nearest_airports(lat, lon, radius_km, 4) {
        for rw in db.runways_of(ap) {
            for end in 0..2 {
                let g = RunwayGeom::new(ap, rw, end);
                let (a, c) = g.frame(lat, lon);
                let taxi = (a - 40.0).hypot(c);
                let mut score = taxi / 40.0;
                if g.length_m < perf.required_takeoff_m {
                    score += 1000.0 + perf.required_takeoff_m - g.length_m;
                }
                if perf.hard_surface_only && !g.hard {
                    score += 600.0;
                }
                let (head, cross) = wind.components(g.course);
                if -head > perf.tailwind_limit_kt {
                    score += 300.0;
                }
                score += cross.abs() - head * 3.0;
                if best.as_ref().is_none_or(|(b, _)| score < *b) {
                    best = Some((score, g));
                }
            }
        }
    }
    best.map(|(_, g)| g)
}

/// Vector-field path following (Nelson et al. 2007): the track to fly to
/// converge onto a straight line with direction `course` (radians) from a
/// cross-track offset `cross` (m, positive right of the line). Far from the
/// line it approaches at `chi_inf`; close in, the commanded intercept angle is
/// `k * cross` radians, so `1 / (k * groundspeed)` is the convergence time.
pub fn line_track(course: f64, cross: f64, k: f64, chi_inf: f64) -> f64 {
    let s = chi_inf * 2.0 / PI;
    course - s * (k * cross / s.max(1e-6)).atan()
}

/// Nosewheel steering angle limit (radians) at a ground speed (m/s); mirrors the flight model.
pub fn nosewheel_limit(speed_ms: f64) -> f64 {
    (55.0 - 52.0 * (speed_ms.abs() / 25.0).min(1.0)).to_radians()
}

/// Pure-pursuit nosewheel command (-1..1) toward a point at `(dx, dy)` meters
/// ahead/right in the aircraft's heading frame.
pub fn pursuit_steer(dx: f64, dy: f64, speed_ms: f64, wheelbase_m: f64) -> f64 {
    let ld2 = dx * dx + dy * dy;
    if ld2 < 1.0 {
        return 0.0;
    }
    // Curvature to reach the point: 2 y / L².
    let kappa = 2.0 * dy / ld2;
    let delta = (kappa * wheelbase_m).atan();
    (delta / nosewheel_limit(speed_ms)).clamp(-1.0, 1.0)
}

/// Rotates runway-frame offsets (along, cross) into the aircraft frame (ahead, right)
/// for an aircraft whose heading is `rel` radians right of the runway course.
pub fn to_body(d_along: f64, d_cross: f64, rel: f64) -> (f64, f64) {
    let (s, c) = rel.sin_cos();
    (d_along * c + d_cross * s, -d_along * s + d_cross * c)
}

/// Approach geometry derived from the aircraft and the runway.
#[derive(Debug, Clone, Copy)]
pub struct ApproachGeometry {
    /// Turn radius flying the pattern (m).
    pub radius: f64,
    /// Downwind offset from the centreline (m).
    pub downwind_offset: f64,
    /// Glideslope intercept distance from the runway start (m).
    pub gs_intercept: f64,
    /// Localizer join distance (m).
    pub join: f64,
    /// Radius of the terminal area where the approach legs take over (m).
    pub terminal: f64,
}

impl ApproachGeometry {
    pub fn new(perf: &Perf, rwy: &RunwayGeom) -> Self {
        let field_msl = rwy.elevation_m - world::geoid_undulation(rwy.lat, rwy.lon);
        let radius = perf.pattern_turn_radius_m(field_msl);
        let gs_intercept = perf.glideslope_intercept_m() + rwy.aim_along();
        let join = gs_intercept + (1.5 * radius).max(3_000.0);
        Self { radius, downwind_offset: 2.5 * radius, gs_intercept, join, terminal: join + (6.0 * radius).max(10_000.0) }
    }

    /// Straight-in entry point on the extended centreline (along, cross).
    pub fn final_entry(&self) -> (f64, f64) {
        (-(self.join + 2.0 * self.radius), 0.0)
    }

    /// Downwind entry point abeam the runway on `side` (+1 right, -1 left).
    pub fn downwind_entry(&self, side: f64) -> (f64, f64) {
        (0.0, side * self.downwind_offset)
    }

    /// Along-track position where the downwind leg turns base.
    pub fn base_turn_along(&self) -> f64 {
        -(self.join + self.downwind_offset + self.radius)
    }

    /// Enough room to turn onto final ahead of the glideslope intercept.
    pub fn straight_in_ok(&self, along: f64, cross: f64, relaxed: bool) -> bool {
        let need = if relaxed {
            0.8 * self.gs_intercept + 0.3 * self.radius + 0.4 * cross.abs()
        } else {
            self.gs_intercept + 0.5 * self.radius + 0.6 * cross.abs()
        };
        -along >= need
    }

    /// Angle (radians) of a position off the extended approach centreline, seen from the runway.
    pub fn sector_angle(along: f64, cross: f64) -> f64 {
        cross.atan2(-along)
    }

    /// True when a position is inside the straight-in sector (within 100° of the approach course).
    pub fn in_straight_in_sector(along: f64, cross: f64) -> bool {
        Self::sector_angle(along, cross).abs() <= 100f64.to_radians()
    }
}

/// Whether a heading error and offset count as established on the centreline.
pub fn established(cross: f64, track_err: f64) -> bool {
    cross.abs() < 250.0 && track_err.abs() < 25f64.to_radians()
}

/// Half-turn helper for distance estimates.
pub fn turn_distance(radius: f64, angle: f64) -> f64 {
    radius * angle.abs().min(PI)
}

/// Signed smallest angle a - b (radians) in (-π, π].
pub fn angle_diff(a: f64, b: f64) -> f64 {
    let mut d = (a - b) % (2.0 * PI);
    if d > PI {
        d -= 2.0 * PI;
    } else if d <= -PI {
        d += 2.0 * PI;
    }
    d
}

/// Track (radians) that flies directly toward a point (great circle).
pub fn bearing_to(lat: f64, lon: f64, to_lat: f64, to_lon: f64) -> f64 {
    geo::initial_bearing(lat.to_radians(), lon.to_radians(), to_lat.to_radians(), to_lon.to_radians())
}

pub fn distance_m(lat: f64, lon: f64, to_lat: f64, to_lon: f64) -> f64 {
    geo::haversine_m(lat.to_radians(), lon.to_radians(), to_lat.to_radians(), to_lon.to_radians())
}

/// Quarter turn, for the downwind field.
pub const CHI_DOWNWIND: f64 = FRAC_PI_2;
