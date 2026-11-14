//! Unit tests for the autopilot's building blocks. Whole-flight behaviour
//! (takeoff to rollout through the real flight model) is covered by the
//! end-to-end tests in `crates/sim-core/tests/autopilot_e2e.rs`.

use super::nav::*;
use super::perf::*;
use super::*;
use crate::aircraft::{self, catalog};
use crate::geo;
use crate::protocol::ControlInput;
use crate::world;

fn spec(id: &str) -> &'static AircraftSpec {
    aircraft::find(id).unwrap()
}

fn rwy(airport: &str, end: &str) -> RunwayGeom {
    let db = world::db();
    let a = db.airport(airport).unwrap();
    let (r, i) = db.runway_end(a, Some(end)).unwrap();
    RunwayGeom::new(a, &r, i)
}

// ---------------------------------------------------------------------------
// Performance model
// ---------------------------------------------------------------------------

#[test]
fn every_aircraft_gets_a_consistent_speed_schedule() {
    for s in catalog() {
        let p = Perf::from_spec(s);
        assert!(p.v_ref < p.v_clean, "{}: vref {} clean {}", s.id, p.v_ref, p.v_clean);
        assert!(p.v_app >= p.v_ref && p.v_app < p.v_clean, "{}", s.id);
        assert!(p.v2 > p.v_rotate || p.v2 >= p.v_ref + 8.0, "{}", s.id);
        assert!(p.v_clean <= p.v_climb_low && p.v_climb_low <= p.v_limit, "{}", s.id);
        assert!(p.v_cruise <= p.v_limit && p.v_descent <= p.v_limit, "{}", s.id);
        assert!(p.rotate_pitch_deg < s.tailstrike_pitch_deg - 1.5, "{}: rotation would strike the tail", s.id);
        assert!(p.flare_pitch_max_deg < s.tailstrike_pitch_deg, "{}", s.id);
        assert!(p.lever_max <= 1.0 && p.lever_max > 0.5, "{}", s.id);
        assert!(p.required_landing_m > 300.0 && p.required_landing_m < 3_000.0, "{}: landing {}", s.id, p.required_landing_m);
        assert!(p.required_takeoff_m > 200.0 && p.required_takeoff_m < 3_000.0, "{}: takeoff {}", s.id, p.required_takeoff_m);
        assert!(p.faf_m >= 4_500.0 && p.faf_m <= 11_000.0, "{}", s.id);
        let sp = p.approach_speeds();
        assert!(sp.windows(2).all(|w| w[0] >= w[1]), "{}: approach speeds must decrease {sp:?}", s.id);
    }
}

#[test]
fn afterburning_fighters_climb_on_dry_power() {
    let p = Perf::from_spec(spec("f16"));
    assert_eq!(p.lever_max, spec("f16").afterburner_detent);
    assert!(p.mach_cap.is_none());
    assert!(Perf::from_spec(spec("b737")).mach_cap.is_some());
}

#[test]
fn flap_schedule_is_monotonic_and_ends_at_vref() {
    for s in catalog().iter().filter(|s| !s.auto_flaps) {
        let p = Perf::from_spec(s);
        let n = p.flap_count;
        assert!((p.min_speed_for_flaps(n - 1) - p.v_ref).abs() < 1e-9, "{}", s.id);
        assert!((p.min_speed_for_flaps(0) - p.v_clean).abs() < 1e-9, "{}", s.id);
        for i in 1..n {
            assert!(p.min_speed_for_flaps(i) < p.min_speed_for_flaps(i - 1), "{}", s.id);
            assert!(p.flap_extend_limit(i) > p.min_speed_for_flaps(i), "{}", s.id);
        }
        assert_eq!(p.flaps_for_speed(p.v_clean + 20.0), 0, "{}", s.id);
        assert_eq!(p.flaps_for_speed(p.v_ref), n - 1, "{}", s.id);
        let mut last = 0;
        for v in (p.v_ref as i32..=(p.v_clean as i32 + 5)).rev() {
            let f = p.flaps_for_speed(v as f64);
            assert!(f >= last, "{}: flaps go up as speed goes down", s.id);
            last = f;
        }
    }
}

#[test]
fn cruise_altitude_grows_with_trip_length_and_respects_the_ceiling() {
    let p = Perf::from_spec(spec("b737"));
    let short = p.cruise_altitude_ft(15.0, 700.0);
    let medium = p.cruise_altitude_ft(60.0, 700.0);
    let long = p.cruise_altitude_ft(1_000.0, 700.0);
    assert!(short < medium && medium < long, "{short} {medium} {long}");
    assert!(short >= 700.0 + p.pattern_agl_ft + 1500.0);
    assert_eq!(long, p.cruise_alt_ft);
    assert_eq!(long % 500.0, 0.0);
    let c = Perf::from_spec(spec("c172"));
    assert!(c.cruise_altitude_ft(500.0, 0.0) <= spec("c172").cruise_alt_ft);
}

// ---------------------------------------------------------------------------
// Runway geometry and selection
// ---------------------------------------------------------------------------

#[test]
fn runway_frame_round_trips_and_follows_the_course() {
    let g = rwy("KORD", "28R");
    assert!((g.course_deg() - 270.0).abs() < 5.0);
    for &(a, c) in &[(0.0, 0.0), (1_200.0, 0.0), (-9_000.0, 35.0), (-40_000.0, -12_000.0), (3_000.0, 2_500.0)] {
        let (la, lo) = g.point(a, c);
        let (a2, c2) = g.frame(la, lo);
        assert!((a2 - a).abs() < 0.5 && (c2 - c).abs() < 0.5, "({a}, {c}) -> ({a2}, {c2})");
    }
    // The far end of the runway lies on the centreline, one runway length along.
    let db = world::db();
    let ap = db.airport("KORD").unwrap();
    let (r, i) = db.runway_end(ap, Some("28R")).unwrap();
    let far = &r.ends[1 - i];
    let (a, c) = g.frame(far.lat, far.lon);
    assert!((a - g.length_m).abs() < 30.0, "along {a} length {}", g.length_m);
    assert!(c.abs() < 5.0, "cross {c}");
    assert!(g.contains(g.length_m * 0.5, 0.0, 0.0));
    assert!(!g.contains(g.length_m * 0.5, g.width_m, 0.0));
}

#[test]
fn glidepath_reaches_the_aim_point_at_three_degrees() {
    let g = rwy("KORD", "28R");
    assert!(g.glidepath_height(g.aim_along()).abs() < 1e-9);
    let h = g.glidepath_height(g.aim_along() - 1852.0);
    assert!((h - 1852.0 * 3f64.to_radians().tan()).abs() < 1e-6);
    assert!(g.aim_along() > g.displaced_m && g.aim_along() < g.length_m * 0.5);
}

#[test]
fn wind_components_split_headwind_and_crosswind() {
    let w = Wind { from_deg: 270.0, speed_kt: 20.0 };
    let (h, c) = w.components(270f64.to_radians());
    assert!((h - 20.0).abs() < 1e-9 && c.abs() < 1e-9);
    let (h, c) = w.components(0.0);
    assert!(h.abs() < 1e-9 && (c + 20.0).abs() < 1e-9, "wind from the left: {c}");
    let (h, _) = w.components(90f64.to_radians());
    assert!((h + 20.0).abs() < 1e-9, "tailwind");
}

#[test]
fn landing_runway_goes_into_the_wind() {
    let t = NavTarget::lookup("KORD", None).unwrap();
    let p = Perf::from_spec(spec("b737"));
    for from in [270.0, 90.0, 180.0, 0.0, 45.0] {
        let g = choose_landing_runway(&t, &p, Wind { from_deg: from, speed_kt: 20.0 }, None).unwrap();
        let off = geo::wrap_deg_180(g.course_deg() - from).abs();
        assert!(off <= 50.0, "wind from {from}: runway {} course {:.0} is {off:.0}° off the wind", g.ident, g.course_deg());
        assert!(g.landing_length_m() >= p.required_landing_m);
    }
}

#[test]
fn calm_wind_prefers_a_straight_in_runway_and_honours_the_preferred_end() {
    let p = Perf::from_spec(spec("b737"));
    let calm = Wind::default();
    let t = NavTarget::lookup("KORD", None).unwrap();
    // Arriving from far to the east: land toward the west.
    let g = choose_landing_runway(&t, &p, calm, Some((41.98, -86.5))).unwrap();
    assert!(geo::wrap_deg_180(g.course_deg() - 270.0).abs() < 50.0, "{} {}", g.ident, g.course_deg());
    let pref = NavTarget::lookup("KORD", Some("10L".into())).unwrap();
    let g = choose_landing_runway(&pref, &p, calm, Some((41.98, -86.5))).unwrap();
    assert_eq!(g.ident, "10L");
}

#[test]
fn jets_avoid_runways_that_are_too_short() {
    let p = Perf::from_spec(spec("b737"));
    let t = NavTarget::lookup("KMDW", None).unwrap();
    let g = choose_landing_runway(&t, &p, Wind::default(), None).unwrap();
    assert!(g.landing_length_m() >= p.required_landing_m, "{} is {} m", g.ident, g.landing_length_m());
    assert!(g.hard);
}

#[test]
fn finds_the_runway_the_aircraft_is_lined_up_on() {
    let g = rwy("KORD", "28R");
    let (la, lo) = g.point(30.0, 0.0);
    let (found, a, c) = runway_under(la, lo, g.course_deg(), 10.0).unwrap();
    assert_eq!((found.airport.as_str(), found.ident.as_str()), ("KORD", "28R"));
    assert!((a - 30.0).abs() < 1.0 && c.abs() < 1.0);
    // Pointing the other way it is the opposite end.
    let (found, ..) = runway_under(la, lo, g.course_deg() + 180.0, 10.0).unwrap();
    assert_eq!(found.ident, "10L");
    // Off the pavement: no runway.
    let (la, lo) = g.point(500.0, 400.0);
    assert!(runway_under(la, lo, g.course_deg(), 10.0).is_none());
}

#[test]
fn chooses_a_nearby_takeoff_runway_and_none_in_the_middle_of_nowhere() {
    let p = Perf::from_spec(spec("c172"));
    let g = choose_takeoff_runway(41.975, -87.905, &p, Wind::default(), 5.0).unwrap();
    assert_eq!(g.airport, "KORD");
    assert!(choose_takeoff_runway(30.0, -150.0, &p, Wind::default(), 5.0).is_none());
}

#[test]
fn surfaces_are_classified() {
    assert!(is_hard_surface("ASP") && is_hard_surface("CONC") && is_hard_surface("asphalt") && is_hard_surface("PEM"));
    assert!(!is_hard_surface("GRS") && !is_hard_surface("TURF") && !is_hard_surface("GVL") && !is_hard_surface("WATER"));
}

// ---------------------------------------------------------------------------
// Guidance laws
// ---------------------------------------------------------------------------

#[test]
fn path_following_turns_toward_the_line_and_saturates() {
    let course = 1.0;
    let k = 1.0 / 1000.0;
    let chi = 60f64.to_radians();
    assert!((line_track(course, 0.0, k, chi) - course).abs() < 1e-12);
    // Right of the line: turn left (smaller track), and vice versa.
    assert!(line_track(course, 200.0, k, chi) < course);
    assert!(line_track(course, -200.0, k, chi) > course);
    // Close in the intercept angle is k * offset.
    assert!(((course - line_track(course, 10.0, k, chi)) - 0.01).abs() < 1e-4);
    // Far away it approaches at the maximum angle, never more.
    let far = course - line_track(course, 1e7, k, chi);
    assert!(far < chi && far > chi * 0.99);
}

#[test]
fn path_following_converges_in_a_kinematic_simulation() {
    // A point mass flying at 70 m/s with a bank-limited turn rate converges
    // onto the line from 3 km away without overshooting by more than 10%.
    let (v, k, chi) = (70.0, 1.0 / (70.0 * 15.0), 60f64.to_radians());
    let (mut y, mut psi) = (3_000.0, std::f64::consts::FRAC_PI_2);
    let max_rate = crate::atmosphere::G0 * 25f64.to_radians().tan() / v;
    let mut min_y: f64 = y;
    for _ in 0..(10 * 300) {
        let cmd = line_track(0.0, y, k, chi);
        let err = angle_diff(cmd, psi);
        psi += (err * 0.5).clamp(-max_rate, max_rate) * 0.1;
        y += v * psi.sin() * 0.1;
        min_y = min_y.min(y);
    }
    assert!(y.abs() < 15.0, "still {y} m off");
    assert!(min_y > -300.0, "overshoot {min_y}");
}

#[test]
fn pursuit_steering_points_the_nosewheel_at_the_target() {
    assert!(pursuit_steer(50.0, 5.0, 10.0, 15.0) > 0.0);
    assert!(pursuit_steer(50.0, -5.0, 10.0, 15.0) < 0.0);
    assert_eq!(pursuit_steer(0.0, 0.0, 10.0, 15.0), 0.0);
    // The same geometry needs a larger fraction of the (smaller) limit at speed.
    assert!(pursuit_steer(200.0, 2.0, 70.0, 15.0).abs() > pursuit_steer(200.0, 2.0, 5.0, 15.0).abs());
    assert!(nosewheel_limit(70.0) < nosewheel_limit(3.0));
}

#[test]
fn body_frame_rotation() {
    // Aircraft pointing 90° right of the runway: a point to the right of the runway is ahead.
    let (ahead, right) = to_body(0.0, 10.0, std::f64::consts::FRAC_PI_2);
    assert!((ahead - 10.0).abs() < 1e-9 && right.abs() < 1e-9);
    let (ahead, right) = to_body(10.0, 0.0, 0.0);
    assert!((ahead - 10.0).abs() < 1e-9 && right.abs() < 1e-9);
}

#[test]
fn approach_geometry_is_ordered() {
    let p = Perf::from_spec(spec("b737"));
    let g = ApproachGeometry::new(&p, &rwy("KORD", "28R"));
    assert!(g.gs_intercept < g.join && g.join < g.terminal);
    assert!(g.downwind_offset > 2.0 * g.radius);
    assert!(-g.base_turn_along() > g.join);
    assert!(g.straight_in_ok(-(g.join + 5_000.0), 0.0, false));
    assert!(!g.straight_in_ok(-1_000.0, 0.0, false));
    assert!(ApproachGeometry::in_straight_in_sector(-10_000.0, 1_000.0));
    assert!(!ApproachGeometry::in_straight_in_sector(10_000.0, 100.0));
    let c = ApproachGeometry::new(&Perf::from_spec(spec("c172")), &rwy("KORD", "28R"));
    assert!(c.terminal < g.terminal && c.radius < g.radius, "light aircraft fly a tighter pattern");
}

// ---------------------------------------------------------------------------
// Phases, legs and engagement rules
// ---------------------------------------------------------------------------

#[test]
fn phase_codes_round_trip_with_distinct_labels() {
    let mut labels = std::collections::HashSet::new();
    for p in Phase::ALL {
        assert_eq!(Phase::from_code(p.code()), Some(p));
        assert!(labels.insert(p.label()), "duplicate label {}", p.label());
    }
    assert_eq!(Phase::from_code(99), None);
    assert!(Phase::Rollout.is_ground() && Phase::TakeoffRoll.is_ground() && !Phase::Final.is_ground());
}

fn ctx_at(ap: &Autopilot, perf: &Perf, along: f64, cross: f64) -> Ctx {
    let rw = rwy("KORD", "28R");
    let (lat, lon) = rw.point(along, cross);
    let inp = ApInputs { lat, lon, height: rw.elevation_m + 600.0, track: 270.0, ..Default::default() };
    let mut ap = ap.clone();
    ap.runway = Some(rw.clone());
    ap.geom = Some(ApproachGeometry::new(perf, &rw));
    ap.ctx(&inp, perf).unwrap()
}

#[test]
fn initial_leg_depends_on_where_the_aircraft_is() {
    let perf = Perf::from_spec(spec("b737"));
    let ap = Autopilot::default();
    let g = ApproachGeometry::new(&perf, &rwy("KORD", "28R"));
    // Far out on the approach side: direct to the final approach entry.
    assert_eq!(ap.initial_leg(&ctx_at(&ap, &perf, -(g.terminal + 30_000.0), 2_000.0)), Leg::DirectFinal);
    // Far beyond the departure end: direct to the downwind entry.
    assert_eq!(ap.initial_leg(&ctx_at(&ap, &perf, g.terminal + 30_000.0, 2_000.0)), Leg::DirectDownwind);
    // In the terminal area with room for a straight-in: intercept.
    assert_eq!(ap.initial_leg(&ctx_at(&ap, &perf, -(g.join + 3_000.0), 1_000.0)), Leg::Intercept);
    // Over the airport: fly the pattern.
    assert_eq!(ap.initial_leg(&ctx_at(&ap, &perf, 1_000.0, 500.0)), Leg::Downwind);
}

#[test]
fn path_estimate_shrinks_toward_the_runway() {
    let perf = Perf::from_spec(spec("b737"));
    let mut ap = Autopilot { leg: Leg::Localizer, ..Default::default() };
    let near = ctx_at(&ap, &perf, -5_000.0, 0.0);
    let far = ctx_at(&ap, &perf, -15_000.0, 0.0);
    assert!(near.path_total < far.path_total);
    assert!((far.path_total - 15_000.0).abs() < 1.0);
    ap.leg = Leg::DirectFinal;
    let a = ctx_at(&ap, &perf, -80_000.0, 10_000.0);
    let b = ctx_at(&ap, &perf, -60_000.0, 8_000.0);
    assert!(b.path_total < a.path_total && a.path_total > 80_000.0);
    // Profile: higher further away, never below pattern height.
    assert!(ap.profile_ft(&a, &perf) > ap.profile_ft(&b, &perf));
    let close = ctx_at(&ap, &perf, -3_000.0, 0.0);
    assert!(ap.profile_ft(&close, &perf) >= close.elev_ft + perf.pattern_height_m() * M_TO_FT - 1.0);
}

fn airborne_inputs() -> ApInputs {
    ApInputs {
        lat: 41.9,
        lon: -87.6,
        height: 1_500.0,
        alt_msl_ft: 4_800.0,
        agl_ft: 4_200.0,
        heading: 90.0,
        track: 90.0,
        ias_kt: 250.0,
        tas_ms: 140.0,
        gs_ms: 140.0,
        speed_ms: 140.0,
        sigma: 0.86,
        speed_of_sound: 330.0,
        roll_rate_max: 0.3,
        pitch_rate_max: 0.1,
        control_eff: 1.0,
        lever: 0.5,
        gear_down_cmd: false,
        nz: 1.0,
        ..Default::default()
    }
}

#[test]
fn engaging_without_a_destination_holds_the_current_flight() {
    let mut ap = Autopilot::default();
    let inp = airborne_inputs();
    assert!(ap.engage(&inp, spec("b737")));
    assert_eq!(ap.phase, Phase::Hold);
    assert!(!ap.is_managed());
    assert_eq!(ap.target_heading, 90.0);
    assert_eq!(ap.target_altitude_ft, 4_800.0);
    assert_eq!(ap.target_speed_kt, 250.0);
    // Hold mode accepts the classic target adjustments.
    ap.apply(&AutopilotCommand { heading_delta: Some(-10.0), altitude_delta_ft: Some(500.0), ..Default::default() }, spec("b737"));
    assert_eq!(ap.target_heading, 80.0);
    assert_eq!(ap.target_altitude_ft, 5_300.0);
}

#[test]
fn engaging_with_a_destination_plans_a_landing_runway() {
    let mut ap = Autopilot::default();
    let inp = airborne_inputs();
    ap.set_destination(NavTarget::lookup("KMKE", None), &inp, spec("b737"));
    assert!(ap.engage(&inp, spec("b737")));
    assert!(ap.is_managed());
    assert!(matches!(ap.phase, Phase::Climb | Phase::Cruise | Phase::Descent), "{:?}", ap.phase);
    let rw = ap.runway().expect("runway planned").clone();
    assert_eq!(rw.airport, "KMKE");
    assert_eq!(ap.take_runway_event(), Some(("KMKE".into(), rw.ident.clone())));
    assert!(ap.cruise_altitude_ft() > 4_000.0);
}

#[test]
fn ground_engagement_needs_a_runway() {
    let mut ap = Autopilot::default();
    let inp = ApInputs { lat: 30.0, lon: -150.0, on_ground: true, ..Default::default() };
    assert!(!ap.engage(&inp, spec("c172")));
    assert!(!ap.engaged);
    assert!(ap.take_messages().iter().any(|m| m.contains("no runway")));
}

#[test]
fn engaging_on_the_runway_starts_the_takeoff() {
    let g = rwy("KORD", "28R");
    let (lat, lon) = g.point(40.0, 0.0);
    let inp = ApInputs { lat, lon, on_ground: true, heading: g.course_deg(), sigma: 1.0, ..Default::default() };
    let mut ap = Autopilot::default();
    assert!(ap.engage(&inp, spec("b737")));
    assert_eq!(ap.phase, Phase::TakeoffRoll);
    assert_eq!(ap.departure_runway().unwrap().ident, "28R");
    // Off the centreline or crooked: line up first.
    let inp = ApInputs { heading: g.course_deg() + 20.0, ..inp };
    let mut ap = Autopilot::default();
    assert!(ap.engage(&inp, spec("b737")));
    assert_eq!(ap.phase, Phase::LineUp);
}

#[test]
fn pilot_inputs_and_thrust_levers_take_over_where_they_should() {
    let mut ap = Autopilot::default();
    assert!(ap.engage(&airborne_inputs(), spec("b737")));
    let nudge = ControlInput { pitch: 0.3, ..Default::default() };
    assert!(ap.pilot_override(&nudge, false).is_none(), "small inputs do not disconnect");
    let yank = ControlInput { roll: 0.9, ..Default::default() };
    assert!(ap.pilot_override(&yank, false).is_some());
    // Manual thrust in flight only drops the autothrottle.
    assert!(!ap.manual_throttle());
    assert!(ap.engaged && !ap.autothrottle);
    // ...but during the takeoff roll it hands the aircraft back.
    let mut ap = Autopilot { engaged: true, phase: Phase::TakeoffRoll, ..Default::default() };
    assert!(ap.manual_throttle());
    assert!(!ap.engaged);
    let ap = Autopilot { engaged: true, phase: Phase::TakeoffRoll, ..Default::default() };
    assert!(ap.pilot_override(&ControlInput { brake: 1.0, ..Default::default() }, true).is_some());
}

#[test]
fn hold_mode_disconnects_at_touchdown_but_a_managed_landing_continues() {
    let mut ap = Autopilot { engaged: true, phase: Phase::Hold, ..Default::default() };
    ap.on_touchdown();
    assert!(!ap.engaged);
    let mut ap = Autopilot { engaged: true, phase: Phase::Flare, ..Default::default() };
    ap.on_touchdown();
    assert!(ap.engaged);
}

#[test]
fn weather_limits_rule_out_landings() {
    let p = Perf::from_spec(spec("b737"));
    let course = 270f64.to_radians();
    let calm = ApInputs { wind_from_deg: 270.0, wind_kt: 10.0, ..Default::default() };
    assert!(Autopilot::landing_weather(&calm, &p, course).is_none());
    let gusty = ApInputs { gust_ms: 3.0, ..calm.clone() };
    assert!(Autopilot::landing_weather(&gusty, &p, course).is_some());
    let cross = ApInputs { wind_from_deg: 0.0, wind_kt: 45.0, ..Default::default() };
    assert!(Autopilot::landing_weather(&cross, &p, course).unwrap().starts_with("Crosswind"));
    let tail = ApInputs { wind_from_deg: 90.0, wind_kt: 20.0, ..Default::default() };
    assert!(Autopilot::landing_weather(&tail, &p, course).unwrap().starts_with("Tailwind"));
    let severe = ApInputs { turbulence: 0.8, ..calm };
    assert!(Autopilot::landing_weather(&severe, &p, course).is_some());
}

#[test]
fn approach_speed_additive_is_bounded() {
    let p = Perf::from_spec(spec("b737"));
    let course = 270f64.to_radians();
    let none = ApInputs::default();
    assert_eq!(Autopilot::wind_additive(&none, &p, course), 0.0);
    let windy = ApInputs { wind_from_deg: 270.0, wind_kt: 40.0, turbulence: 1.0, ..Default::default() };
    assert!(Autopilot::wind_additive(&windy, &p, course) <= 10.0);
    let tail = ApInputs { wind_from_deg: 90.0, wind_kt: 10.0, ..Default::default() };
    assert_eq!(Autopilot::wind_additive(&tail, &p, course), 0.0, "no additive for a tailwind");
}
