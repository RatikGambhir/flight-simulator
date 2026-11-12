//! End-to-end autopilot tests: real flights through the full flight model.
//!
//! Every test does what a player does — spawn, (optionally) choose a
//! destination, press Z — and then lets the autopilot fly through the same
//! controls a pilot uses. The harness plays the renderer's part (ground height
//! samples and the terrain-ahead profile). Assertions check the outcome
//! (landed on the right runway, stopped) and the quality of the flight
//! (no crash, no stall, gentle touchdowns, smooth engagement, no position
//! jumps).

mod common;

use common::{airport_terrain, Harness, DT};
use sim_core::autopilot::{Lateral, Phase};
use sim_core::geo::{self, FT_TO_M};
use sim_core::protocol::{RunwaySpawnKind, SpawnMode, SpawnRequest};
use sim_core::stepper::FixedStepper;
use sim_core::{snap, world, ControlInput, SimCommand, SimEvent, Simulation};

/// What must hold after any flight: nothing crashed and the aircraft was flown, not moved.
fn assert_healthy(h: &Harness, what: &str) {
    assert!(h.crashed.is_none(), "{what}: crashed ({:?}) after {}", h.crashed, h.phase_names());
    assert!(h.max_jump_m < 0.5, "{what}: position jumped {:.2} m beyond its velocity", h.max_jump_m);
    let stalls = h.events.iter().filter(|(_, e)| matches!(e, SimEvent::Stall)).count();
    assert_eq!(stalls, 0, "{what}: stalled");
}

/// Asserts the aircraft came to a stop on a runway of `airport` and returns its ident.
fn assert_stopped_on_runway(h: &Harness, airport: &str) -> String {
    assert_eq!(h.phase(), Phase::Stopped, "not stopped: {}", h.phase_names());
    let rw = h.sim.autopilot.runway().expect("landing runway").clone();
    assert_eq!(rw.airport, airport);
    let s = h.snap();
    let (along, cross) = rw.frame(s[snap::LAT], s[snap::LON]);
    assert!(along > 0.0 && along < rw.length_m, "stopped {along:.0} m along a {:.0} m runway", rw.length_m);
    assert!(cross.abs() < rw.width_m * 0.5, "stopped {cross:.1} m off the centreline (width {:.0} m)", rw.width_m);
    assert!(s[snap::GS_KT] < 1.0, "still moving at {:.1} kt", s[snap::GS_KT]);
    assert!((s[snap::FLAGS] as u32) & snap::flags::PARKING_BRAKE != 0, "parking brake set");
    rw.ident
}

fn first_touchdown_fpm(h: &Harness) -> f64 {
    h.touchdowns.first().map(|t| t.1).expect("touched down")
}

/// Spawns on a departure runway, sets the destination, presses Z once and flies to a stop.
fn fly_route(aircraft: &str, from: &str, runway: &str, to: &str, max_s: f64) -> Harness {
    let mut h = Harness::new(aircraft, airport_terrain(&[from, to]));
    h.destination(to);
    h.spawn_runway(from, runway, RunwaySpawnKind::Takeoff);
    h.toggle_ap();
    assert!(h.engaged(), "{aircraft}: autopilot engaged on the runway");
    assert_eq!(h.phase(), Phase::TakeoffRoll);
    h.run_until(max_s, |h| h.phase() == Phase::Stopped || !h.engaged());
    h
}

fn check_route(h: &Harness, aircraft: &str, to: &str) {
    assert_healthy(h, aircraft);
    for p in [Phase::TakeoffRoll, Phase::Rotate, Phase::InitialClimb, Phase::Final, Phase::Flare, Phase::Rollout, Phase::Stopped] {
        assert!(h.saw_phase(p), "{aircraft}: never flew {} ({})", p.label(), h.phase_names());
    }
    assert!(h.saw_phase(Phase::Approach) || h.saw_phase(Phase::Final));
    assert_stopped_on_runway(h, to);
    let td = first_touchdown_fpm(h);
    assert!(td > -400.0, "{aircraft}: touchdown {td:.0} fpm");
    assert_eq!(h.touchdowns.len(), 1, "{aircraft}: bounced: {:?}", h.touchdowns);
    // Comfortable, well-coordinated flight throughout.
    let (nz_lo, nz_hi) = h.range(0.0, h.t, |s| if s.on_ground { 1.0 } else { s.nz });
    if !(nz_lo > 0.5 && nz_hi < 1.6) {
        for s in h.log.iter().filter(|s| !s.on_ground && (s.nz < 0.6 || s.nz > 1.45)) {
            eprintln!("{aircraft}: t {:.1} phase {:?} nz {:.2} agl {:.0} vs {:.0} pitch {:.1} roll {:.1}", s.t, Phase::from_code(s.phase), s.nz, s.agl_ft, s.vs, s.pitch, s.roll);
        }
    }
    assert!(nz_lo > 0.5 && nz_hi < 1.6, "{aircraft}: load factor {nz_lo:.2}..{nz_hi:.2}");
    let (roll_lo, roll_hi) = h.range(0.0, h.t, |s| s.roll);
    // Within the bank limit (30° for fighters, 25° otherwise) plus a small overshoot.
    assert!(roll_lo > -33.0 && roll_hi < 33.0, "{aircraft}: bank {roll_lo:.0}..{roll_hi:.0}");
    let (pitch_lo, pitch_hi) = h.range(0.0, h.t, |s| s.pitch);
    let pitch_max = if aircraft == "f16" { 28.0 } else { 20.0 };
    assert!(pitch_lo > -10.0 && pitch_hi < pitch_max, "{aircraft}: pitch {pitch_lo:.0}..{pitch_hi:.0}");
}

// ---------------------------------------------------------------------------
// Complete flights
// ---------------------------------------------------------------------------

#[test]
fn airliner_flies_gate_to_gate_chicago_to_milwaukee() {
    let h = fly_route("b737", "KORD", "28R", "KMKE", 2_400.0);
    check_route(&h, "b737", "KMKE");
    for p in [Phase::Climb, Phase::Cruise, Phase::Descent] {
        assert!(h.saw_phase(p), "never flew {} ({})", p.label(), h.phase_names());
    }
    // Clean in cruise: gear and flaps up, at the planned level.
    let cruise: Vec<_> = h.phases.windows(2).filter(|w| w[0].1 == Phase::Cruise).map(|w| (w[0].0, w[1].0)).collect();
    let (t0, t1) = cruise[0];
    let mid = h.log.iter().find(|s| s.t > (t0 + t1) / 2.0).unwrap();
    assert!(mid.alt_ft > 7_000.0, "cruise altitude {}", mid.alt_ft);
    assert!(mid.ias > 230.0 && mid.ias < 260.0, "cruise speed below 10,000 ft {}", mid.ias);
    assert!(h.messages().iter().any(|m| m.contains("Top of descent")));
}

#[test]
fn every_aircraft_type_completes_a_flight() {
    for (ac, from, rwy, to) in [
        ("a320", "KORD", "28R", "KMDW"),
        ("bizjet", "KORD", "28R", "KMDW"),
        ("longitude", "KORD", "28R", "KMDW"),
        ("c172", "KORD", "28R", "KDPA"),
        ("f16", "KORD", "28R", "KMDW"),
    ] {
        let h = fly_route(ac, from, rwy, to, 2_400.0);
        check_route(&h, ac, to);
    }
}

#[test]
fn short_hop_without_a_cruise_segment() {
    // O'Hare to Midway is 14 nm: the autopilot climbs only as high as the approach needs.
    let h = fly_route("b737", "KORD", "28R", "KMDW", 1_800.0);
    check_route(&h, "b737", "KMDW");
    let max_alt = h.log.iter().map(|s| s.alt_ft).fold(0.0, f64::max);
    assert!(max_alt < 6_000.0, "climbed to {max_alt:.0} ft for a 14 nm trip");
}

#[test]
fn shorter_runway_in_a_gusty_wind_lands_in_the_touchdown_zone() {
    // Midway's 6,445 ft runways are close to the 737's minimum: no floating allowed.
    let mut h = Harness::new("b737", airport_terrain(&["KORD", "KMDW"]));
    h.weather(264.0, 15.0, 0.15);
    h.destination("KMDW");
    h.spawn_runway("KORD", "28R", RunwaySpawnKind::Takeoff);
    h.toggle_ap();
    let mut touchdown_along = None;
    let done = h.run_until(1_800.0, |h| {
        if touchdown_along.is_none() && h.on_ground() && h.phase() == Phase::Rollout {
            let rw = h.sim.autopilot.runway().unwrap();
            touchdown_along = Some((rw.frame(h.snap()[snap::LAT], h.snap()[snap::LON]).0, rw.aim_along(), rw.length_m));
        }
        h.phase() == Phase::Stopped || !h.engaged()
    });
    assert!(done, "{}", h.phase_names());
    assert_healthy(&h, "KMDW");
    assert_eq!(h.sim.autopilot.go_arounds(), 0, "{:?}", h.messages());
    assert_stopped_on_runway(&h, "KMDW");
    let (along, aim, len) = touchdown_along.expect("touched down");
    assert!(along < aim + (len - aim) / 3.0, "touched down {along:.0} m along a {len:.0} m runway");
    assert!(along > 0.0, "touched down short of the runway ({along:.0} m)");
}

#[test]
fn light_aircraft_flies_a_circuit_back_to_its_departure_airport() {
    let h = fly_route("c172", "KORD", "28R", "KORD", 1_800.0);
    check_route(&h, "c172", "KORD");
    assert!(h.sim.autopilot.lateral == Lateral::None || h.phase() == Phase::Stopped);
    // A traffic pattern: downwind, then base onto final.
    assert!(h.log.iter().any(|s| s.phase == Phase::Approach.code()), "{}", h.phase_names());
}

#[test]
fn arriving_from_behind_the_runway_flies_a_downwind_pattern() {
    // Land on 28R/27L into a westerly wind, arriving from the west (the wrong end).
    let mut h = Harness::new("b737", airport_terrain(&["KORD"]));
    h.weather(270.0, 12.0, 0.0);
    h.destination("KORD");
    h.spawn_air(41.98, -88.35, 90.0, 5_000.0, Some(250.0));
    h.toggle_ap();
    let mut saw_downwind = false;
    let done = h.run_until(2_400.0, |h| {
        saw_downwind |= h.sim.autopilot.lateral == Lateral::Downwind;
        h.phase() == Phase::Stopped || !h.engaged()
    });
    assert!(done, "{}", h.phase_names());
    assert_healthy(&h, "downwind arrival");
    assert!(saw_downwind, "flew a downwind leg");
    let rwy = assert_stopped_on_runway(&h, "KORD");
    let course = h.sim.autopilot.runway().unwrap().course_deg();
    assert!(geo::wrap_deg_180(course - 270.0).abs() < 40.0, "landed on {rwy} ({course:.0}°) into the wind");
}

// ---------------------------------------------------------------------------
// Engaging and disengaging
// ---------------------------------------------------------------------------

/// Maximum per-second changes in the first `secs` after engagement at time `t0`.
struct Transient {
    roll_rate: f64,
    pitch_rate: f64,
    nz: (f64, f64),
    alt_change: f64,
    speed_change: f64,
}

fn transient(h: &Harness, t0: f64, secs: f64) -> Transient {
    let alt0 = h.log.iter().find(|s| s.t >= t0).map(|s| s.alt_ft).unwrap_or(0.0);
    let spd0 = h.log.iter().find(|s| s.t >= t0).map(|s| s.ias).unwrap_or(0.0);
    let (alt_lo, alt_hi) = h.range(t0, t0 + secs, |s| s.alt_ft);
    let (spd_lo, spd_hi) = h.range(t0, t0 + secs, |s| s.ias);
    Transient {
        roll_rate: h.max_rate(t0, t0 + secs, |s| s.roll, true),
        pitch_rate: h.max_rate(t0, t0 + secs, |s| s.pitch, false),
        nz: h.range(t0, t0 + secs, |s| if s.on_ground { 1.0 } else { s.nz }),
        alt_change: (alt_hi - alt0).abs().max((alt0 - alt_lo).abs()),
        speed_change: (spd_hi - spd0).abs().max((spd0 - spd_lo).abs()),
    }
}

/// Flies manually (or hands off) for a while, presses Z, and checks the next seconds are smooth.
fn engage_smoothly(h: &mut Harness, label: &str) -> f64 {
    h.log_every = 1;
    let vs = h.snap()[snap::VS_FPM];
    h.toggle_ap();
    assert!(h.engaged(), "{label}: engaged");
    let t0 = h.t;
    h.run_for(12.0);
    let tr = transient(h, t0, 12.0);
    if std::env::var("AP_DEBUG").is_ok() {
        for s in h.log.iter().filter(|s| s.t >= t0 - 0.5 && s.t < t0 + 12.0).step_by(12) {
            eprintln!("{label}: t {:.2} {:?} nz {:.2} vs {:.0} pitch {:.1} roll {:.1} ias {:.0} thr {:.2}", s.t - t0, Phase::from_code(s.phase), s.nz, s.vs, s.pitch, s.roll, s.ias, s.throttle);
        }
    }
    assert_healthy(h, label);
    assert!(tr.roll_rate < 8.0, "{label}: roll rate {:.1}°/s after engaging", tr.roll_rate);
    assert!(tr.pitch_rate < 4.0, "{label}: pitch rate {:.1}°/s after engaging", tr.pitch_rate);
    assert!(tr.nz.0 > 0.75 && tr.nz.1 < 1.35, "{label}: load factor {:.2}..{:.2} after engaging", tr.nz.0, tr.nz.1);
    // No sudden altitude or speed change beyond what the aircraft was already doing.
    assert!(tr.alt_change < vs.abs() / 60.0 * 12.0 + 400.0, "{label}: altitude moved {:.0} ft", tr.alt_change);
    assert!(tr.speed_change < 25.0, "{label}: speed moved {:.0} kt", tr.speed_change);
    t0
}

#[test]
fn engaging_in_level_cruise_is_seamless_and_navigates_to_the_destination() {
    let mut h = Harness::new("a320", airport_terrain(&["KORD", "KMKE"]));
    h.destination("KMKE");
    h.spawn_air(41.60, -87.70, 200.0, 9_000.0, Some(260.0));
    h.run_for(5.0);
    engage_smoothly(&mut h, "level cruise");
    assert!(h.sim.autopilot.is_managed());
    let done = h.run_until(3_000.0, |h| h.phase() == Phase::Stopped || !h.engaged());
    assert!(done, "{}", h.phase_names());
    assert_healthy(&h, "cruise engagement");
    assert_stopped_on_runway(&h, "KMKE");
}

#[test]
fn engaging_in_a_steep_turn_rolls_out_gently() {
    let mut h = Harness::new("b737", airport_terrain(&["KORD", "KMKE"]));
    h.destination("KMKE");
    h.spawn_air(41.70, -87.90, 90.0, 6_000.0, Some(230.0));
    // Roll into a 30° bank by hand, then release the stick (the bank holds).
    h.input = ControlInput { roll: 0.5, ..Default::default() };
    h.run_until(10.0, |h| h.snap()[snap::ROLL] > 28.0);
    h.input = ControlInput::default();
    h.run_for(1.0);
    assert!(h.snap()[snap::ROLL] > 20.0);
    engage_smoothly(&mut h, "steep turn");
}

#[test]
fn engaging_in_a_climb_and_in_a_descent_is_seamless() {
    for (label, pitch_in) in [("climb", 0.25), ("descent", -0.2)] {
        let mut h = Harness::new("bizjet", airport_terrain(&["KORD", "KMKE"]));
        h.destination("KMKE");
        h.spawn_air(41.75, -87.95, 0.0, 8_000.0, Some(240.0));
        h.input = ControlInput { pitch: pitch_in, ..Default::default() };
        h.run_for(4.0);
        h.input = ControlInput::default();
        h.run_for(1.0);
        let vs = h.snap()[snap::VS_FPM];
        assert!(vs.abs() > 800.0, "{label}: set up a {vs:.0} fpm {label}");
        engage_smoothly(&mut h, label);
    }
}

#[test]
fn engaging_on_final_lands_without_a_jolt() {
    for ac in ["b737", "c172", "f16"] {
        let mut h = Harness::new(ac, airport_terrain(&["KORD"]));
        h.spawn_runway("KORD", "28R", RunwaySpawnKind::Approach);
        h.run_for(3.0);
        engage_smoothly(&mut h, ac);
        assert!(matches!(h.phase(), Phase::Final), "{ac}: {}", h.phase_names());
        let done = h.run_until(900.0, |h| h.phase() == Phase::Stopped);
        assert!(done, "{ac}: {}", h.phase_names());
        assert_healthy(&h, ac);
        assert_eq!(assert_stopped_on_runway(&h, "KORD"), "28R", "{ac}: landed on the runway it was lined up on");
        assert!(first_touchdown_fpm(&h) > -350.0, "{ac}: touchdown {:.0}", first_touchdown_fpm(&h));
    }
}

#[test]
fn engaging_during_the_takeoff_roll_continues_the_takeoff() {
    let mut h = Harness::new("b737", airport_terrain(&["KORD", "KMKE"]));
    h.destination("KMKE");
    h.spawn_runway("KORD", "28R", RunwaySpawnKind::Takeoff);
    h.command(SimCommand::SetThrottle { value: 1.0 });
    h.run_until(60.0, |h| h.snap()[snap::IAS_KT] > 80.0);
    h.toggle_ap();
    assert_eq!(h.phase(), Phase::TakeoffRoll, "{}", h.phase_names());
    h.run_until(120.0, |h| h.phase() == Phase::Climb);
    assert_healthy(&h, "takeoff roll engagement");
    assert!(h.saw_phase(Phase::Rotate) && h.saw_phase(Phase::InitialClimb));
    // It lifted off over the runway, not beyond it.
    let liftoff = h.events.iter().find(|(_, e)| matches!(e, SimEvent::Liftoff)).map(|(t, _)| *t).expect("lifted off");
    let at = h.log.iter().find(|s| s.t >= liftoff).unwrap();
    let db = world::db();
    let ap = db.airport("KORD").unwrap();
    let (rw, i) = db.runway_end(ap, Some("28R")).unwrap();
    let g = sim_core::autopilot::RunwayGeom::new(ap, &rw, i);
    let (along, cross) = g.frame(at.lat, at.lon);
    assert!(along < g.length_m && cross.abs() < g.width_m * 0.5, "lifted off at {along:.0} m along, {cross:.1} m off");
}

#[test]
fn engaging_during_the_landing_rollout_brakes_to_a_stop() {
    let mut h = Harness::new("a320", airport_terrain(&["KORD"]));
    h.spawn_runway("KORD", "28R", RunwaySpawnKind::Takeoff);
    h.command(SimCommand::SetThrottle { value: 1.0 });
    h.run_until(60.0, |h| h.snap()[snap::GS_KT] > 100.0);
    h.command(SimCommand::SetThrottle { value: 0.0 });
    h.run_for(1.0);
    h.toggle_ap();
    assert_eq!(h.phase(), Phase::Rollout);
    let done = h.run_until(120.0, |h| h.phase() == Phase::Stopped);
    assert!(done, "{}", h.phase_names());
    assert_healthy(&h, "rollout engagement");
    let (along, cross, len) = h.runway_position("KORD", "28R");
    assert!(along < len && cross.abs() < 15.0, "stopped at {along:.0}/{len:.0} m, {cross:.1} m off");
}

#[test]
fn disengaging_hands_back_a_steady_aircraft() {
    let mut h = Harness::new("b737", airport_terrain(&["KORD", "KMKE"]));
    h.destination("KMKE");
    h.spawn_air(41.70, -87.90, 0.0, 7_000.0, Some(250.0));
    h.toggle_ap();
    h.run_for(60.0);
    h.log_every = 1;
    let t0 = h.t;
    h.toggle_ap();
    assert!(!h.engaged());
    assert!(h.messages().iter().any(|m| m == "Autopilot disengaged"));
    h.run_for(15.0);
    let tr = transient(&h, t0, 15.0);
    assert_healthy(&h, "disengage");
    assert!(tr.roll_rate < 6.0 && tr.pitch_rate < 3.0, "attitude rates {:.1} / {:.1}", tr.roll_rate, tr.pitch_rate);
    assert!(tr.nz.0 > 0.8 && tr.nz.1 < 1.25, "load factor {:?}", tr.nz);
    assert!(tr.alt_change < 600.0, "altitude moved {:.0} ft", tr.alt_change);
}

#[test]
fn pilot_inputs_and_rejected_takeoffs_disconnect() {
    let mut h = Harness::new("b737", airport_terrain(&["KORD"]));
    h.spawn_air(41.80, -87.80, 90.0, 5_000.0, Some(250.0));
    h.toggle_ap();
    h.run_for(5.0);
    assert!(h.engaged());
    h.input = ControlInput { roll: -1.0, ..Default::default() };
    h.run_for(0.5);
    assert!(!h.engaged());
    assert!(h.messages().iter().any(|m| m.contains("disconnected by pilot")));

    // Stamping on the brakes during the takeoff roll rejects the takeoff and gives control back.
    let mut h = Harness::new("a320", airport_terrain(&["KORD"]));
    h.spawn_runway("KORD", "28R", RunwaySpawnKind::Takeoff);
    h.toggle_ap();
    h.run_until(60.0, |h| h.snap()[snap::IAS_KT] > 60.0);
    h.input = ControlInput { brake: 1.0, ..Default::default() };
    h.step();
    assert!(!h.engaged());
    assert!(h.messages().iter().any(|m| m.contains("Takeoff rejected")));
}

// ---------------------------------------------------------------------------
// Approach and landing robustness
// ---------------------------------------------------------------------------

#[test]
fn recovers_from_offsets_on_final_and_lands() {
    // 5 nm out, 150 m right of the centreline, 250 ft high and 15° off the runway heading.
    let mut h = Harness::new("a320", airport_terrain(&["KORD"]));
    let db = world::db();
    let ap = db.airport("KORD").unwrap();
    let (rw, i) = db.runway_end(ap, Some("28R")).unwrap();
    let g = sim_core::autopilot::RunwayGeom::new(ap, &rw, i);
    let along = -5.0 * 1852.0;
    let (lat, lon) = g.point(along, 150.0);
    let agl = (g.glidepath_height(along) / FT_TO_M) + 250.0;
    h.command(SimCommand::SetDestination { airport: Some("KORD".into()), runway: Some("28R".into()) });
    h.spawn_air(lat, lon, g.course_deg() + 15.0, agl, Some(160.0));
    h.toggle_ap();
    let done = h.run_until(900.0, |h| h.phase() == Phase::Stopped);
    assert!(done, "{}", h.phase_names());
    assert_healthy(&h, "offset approach");
    assert_eq!(h.sim.autopilot.go_arounds(), 0, "corrected without a go-around: {:?}", h.messages());
    assert_eq!(assert_stopped_on_runway(&h, "KORD"), "28R");
}

#[test]
fn unstable_approach_goes_around_and_lands_on_the_next_attempt() {
    // 3 nm out at 1,500 ft above the glidepath and 60 kt fast: no way to be stable by 1,000 ft.
    let mut h = Harness::new("b737", airport_terrain(&["KORD"]));
    let db = world::db();
    let ap = db.airport("KORD").unwrap();
    let (rw, i) = db.runway_end(ap, Some("28R")).unwrap();
    let g = sim_core::autopilot::RunwayGeom::new(ap, &rw, i);
    let along = -2.5 * 1852.0;
    let (lat, lon) = g.point(along, 0.0);
    h.command(SimCommand::SetDestination { airport: Some("KORD".into()), runway: Some("28R".into()) });
    h.spawn_air(lat, lon, g.course_deg(), g.glidepath_height(along) / FT_TO_M + 1_500.0, Some(210.0));
    h.toggle_ap();
    let done = h.run_until(2_400.0, |h| h.phase() == Phase::Stopped || h.phase() == Phase::Hold);
    assert!(done, "{}", h.phase_names());
    assert_healthy(&h, "go-around");
    assert!(h.saw_phase(Phase::GoAround), "went around: {}", h.phase_names());
    assert!(h.messages().iter().any(|m| m.starts_with("Go-around")));
    // It did not force the landing: no touchdown before the go-around.
    let ga_t = h.phases.iter().find(|p| p.1 == Phase::GoAround).unwrap().0;
    assert!(h.touchdowns.iter().all(|t| t.0 > ga_t), "touched down before going around");
    assert_eq!(h.phase(), Phase::Stopped, "landed after the go-around: {}", h.phase_names());
    assert_stopped_on_runway(&h, "KORD");
}

#[test]
fn crosswind_landing_stays_on_the_centreline() {
    let mut h = Harness::new("b737", airport_terrain(&["KORD"]));
    h.weather(300.0, 20.0, 0.0);
    h.command(SimCommand::SetDestination { airport: Some("KORD".into()), runway: Some("28R".into()) });
    h.spawn_runway("KORD", "28R", RunwaySpawnKind::Approach);
    h.toggle_ap();
    let mut max_cross: f64 = 0.0;
    let done = h.run_until(900.0, |h| {
        if h.phase() == Phase::Rollout {
            let (_, c, _) = h.runway_position("KORD", "28R");
            max_cross = max_cross.max(c.abs());
        }
        h.phase() == Phase::Stopped
    });
    assert!(done, "{}", h.phase_names());
    assert_healthy(&h, "crosswind");
    assert_eq!(assert_stopped_on_runway(&h, "KORD"), "28R");
    assert!(max_cross < 12.0, "drifted {max_cross:.1} m from the centreline on the rollout");
    assert!(first_touchdown_fpm(&h) > -500.0);
}

#[test]
fn lands_in_light_gusty_conditions() {
    for ac in ["b737", "c172"] {
        let mut h = Harness::new(ac, airport_terrain(&["KORD"]));
        h.weather(250.0, 10.0, 0.2);
        h.spawn_runway("KORD", "28R", RunwaySpawnKind::Approach);
        h.toggle_ap();
        let done = h.run_until(2_400.0, |h| h.phase() == Phase::Stopped || h.phase() == Phase::Hold);
        assert!(done, "{ac}: {}", h.phase_names());
        assert!(h.crashed.is_none(), "{ac}: {:?}", h.crashed);
        assert_eq!(h.phase(), Phase::Stopped, "{ac}: {}", h.phase_names());
        assert!(first_touchdown_fpm(&h) > -700.0, "{ac}: {:.0}", first_touchdown_fpm(&h));
    }
}

#[test]
fn severe_weather_circles_instead_of_landing_then_lands_when_it_improves() {
    let mut h = Harness::new("a320", airport_terrain(&["KORD"]));
    h.weather(270.0, 10.0, 0.8);
    h.spawn_runway("KORD", "28R", RunwaySpawnKind::Approach);
    h.toggle_ap();
    h.run_for(600.0);
    assert!(h.crashed.is_none(), "{:?}", h.crashed);
    assert!(h.touchdowns.is_empty(), "did not force a landing in severe turbulence");
    assert!(h.engaged() && h.phase() == Phase::Approach, "{}", h.phase_names());
    assert!(h.messages().iter().any(|m| m.contains("not landing")), "{:?}", h.messages());
    let min_agl = h.log.iter().filter(|s| s.t > 60.0).map(|s| s.agl_ft).fold(f64::MAX, f64::min);
    assert!(min_agl > 1_000.0, "kept clear of the ground while circling ({min_agl:.0} ft)");
    // The weather improves: the approach resumes.
    h.weather(270.0, 5.0, 0.0);
    let done = h.run_until(1_800.0, |h| h.phase() == Phase::Stopped);
    assert!(done, "{}", h.phase_names());
    assert!(h.messages().iter().any(|m| m.contains("continuing the approach")));
    assert_stopped_on_runway(&h, "KORD");
}

#[test]
fn gust_limit_depends_on_the_aircraft() {
    // Moderate turbulence and 15 kt of wind (σw ≈ 1.9 m/s): beyond what the
    // 737 lands reliably (autoland_max_gust_ms 1.8), within the A320's (2.1).
    for (ac, declines) in [("b737", true), ("a320", false)] {
        let mut h = Harness::new(ac, airport_terrain(&["KORD"]));
        h.weather(250.0, 15.0, 0.45);
        h.spawn_runway("KORD", "28R", RunwaySpawnKind::Approach);
        h.toggle_ap();
        h.run_for(300.0);
        assert!(h.crashed.is_none(), "{ac}: {:?}", h.crashed);
        let gusts = h.messages().iter().any(|m| m.contains("Gusts too strong") && m.contains("not landing"));
        assert_eq!(gusts, declines, "{ac}: {:?}", h.messages());
    }
}

// ---------------------------------------------------------------------------
// Terrain, ground operations and modes
// ---------------------------------------------------------------------------

#[test]
fn climbs_over_terrain_that_rises_above_the_planned_altitude() {
    // A 4,000 ft ridge between DuPage and Rockford, higher than the planned cruise level.
    let base = airport_terrain(&["KDPA", "KRFD"]);
    let ridge_lon = -88.6;
    let terrain: common::Terrain = Box::new(move |lat, lon| {
        let ground = base(lat, lon);
        let d = (lon - ridge_lon).abs() * 111_000.0 * lat.to_radians().cos();
        if d < 3_000.0 { ground.max(world::msl_ft_to_ellipsoid_m(lat, lon, 4_000.0)) } else { ground }
    });
    let mut h = Harness::new("c172", terrain);
    h.destination("KRFD");
    h.spawn_runway("KDPA", "28", RunwaySpawnKind::Takeoff);
    let planned = {
        h.toggle_ap();
        h.sim.autopilot.cruise_altitude_ft()
    };
    assert!(planned < 4_500.0, "the plan ({planned} ft) does not already clear the ridge");
    let mut min_clearance = f64::MAX;
    let done = h.run_until(3_600.0, |h| {
        let s = h.snap();
        if (s[snap::LON] - ridge_lon).abs() < 0.04 {
            min_clearance = min_clearance.min(s[snap::ALT_MSL_FT] - 4_000.0);
        }
        h.phase() == Phase::Stopped || !h.engaged()
    });
    assert!(done, "{}", h.phase_names());
    assert_healthy(&h, "terrain");
    assert!(min_clearance > 300.0, "crossed the ridge with {min_clearance:.0} ft to spare");
    assert!(h.messages().iter().any(|m| m.contains("TERRAIN")));
    assert_stopped_on_runway(&h, "KRFD");
}

#[test]
fn taxis_from_off_the_runway_lines_up_and_takes_off() {
    let mut h = Harness::new("c172", airport_terrain(&["KORD"]));
    let db = world::db();
    let ap = db.airport("KORD").unwrap();
    let (rw, i) = db.runway_end(ap, Some("28R")).unwrap();
    let g = sim_core::autopilot::RunwayGeom::new(ap, &rw, i);
    // 120 m to the side of the runway, near its start, pointing away from it.
    let (lat, lon) = g.point(150.0, 120.0);
    h.sim.command(SimCommand::Spawn(SpawnRequest {
        lat,
        lon,
        heading: g.course_deg() + 90.0,
        mode: SpawnMode::Ground,
        agl_ft: None,
        speed_kt: None,
        ground_elevation_ft: Some(ap.elevation_ft),
        keep_autopilot: false,
    }));
    h.settle();
    h.toggle_ap();
    assert_eq!(h.phase(), Phase::Taxi, "{:?}", h.messages());
    let done = h.run_until(600.0, |h| h.phase() == Phase::Hold || h.phase() == Phase::Climb);
    assert!(done, "{}", h.phase_names());
    assert_healthy(&h, "taxi");
    for p in [Phase::Taxi, Phase::LineUp, Phase::TakeoffRoll, Phase::Rotate, Phase::InitialClimb] {
        assert!(h.saw_phase(p), "{} in {}", p.label(), h.phase_names());
    }
}

#[test]
fn without_a_destination_it_takes_off_and_holds_runway_heading() {
    let mut h = Harness::new("bizjet", airport_terrain(&["KORD"]));
    h.spawn_runway("KORD", "28R", RunwaySpawnKind::Takeoff);
    h.toggle_ap();
    assert!(h.messages().iter().any(|m| m.contains("no destination")));
    let done = h.run_until(600.0, |h| h.phase() == Phase::Hold);
    assert!(done, "{}", h.phase_names());
    assert_healthy(&h, "climb-out");
    h.run_for(60.0);
    let s = h.snap();
    let field = world::db().airport("KORD").unwrap().elevation_ft;
    assert!((s[snap::ALT_MSL_FT] - (field + 5_000.0)).abs() < 600.0, "holding {:.0} ft", s[snap::ALT_MSL_FT]);
    assert!(geo::wrap_deg_180(s[snap::TRACK] - 270.0).abs() < 5.0, "runway heading, track {:.0}", s[snap::TRACK]);
    assert!(s[snap::GEAR] < 0.01 && s[snap::FLAPS_INDEX] == 0.0, "cleaned up");

    // Choosing a destination now hands over to full navigation.
    h.command(SimCommand::SetDestination { airport: Some("KMDW".into()), runway: None });
    assert!(h.sim.autopilot.is_managed(), "{}", h.phase_names());
    let done = h.run_until(2_400.0, |h| h.phase() == Phase::Stopped);
    assert!(done, "{}", h.phase_names());
    assert_stopped_on_runway(&h, "KMDW");
}

#[test]
fn on_the_ground_far_from_any_runway_it_declines_to_engage() {
    let mut h = Harness::new("c172", Box::new(world::geoid_undulation));
    h.sim.command(SimCommand::Spawn(SpawnRequest {
        lat: 30.0,
        lon: -150.0,
        heading: 0.0,
        mode: SpawnMode::Ground,
        agl_ft: None,
        speed_kt: None,
        ground_elevation_ft: Some(0.0),
        keep_autopilot: false,
    }));
    h.settle();
    h.toggle_ap();
    assert!(!h.engaged());
    assert!(h.messages().iter().any(|m| m.contains("no runway nearby")));
    // Nothing moved.
    h.run_for(5.0);
    assert!(h.snap()[snap::GS_KT] < 0.5);
}

#[test]
fn skip_to_keeps_the_autopilot_flying() {
    let mut h = Harness::new("b737", airport_terrain(&["KORD", "KMKE"]));
    h.destination("KMKE");
    h.spawn_air(41.6, -87.9, 0.0, 8_000.0, None);
    h.toggle_ap();
    h.run_for(10.0);
    assert!(h.engaged());
    let db = world::db();
    let mke = db.airport("KMKE").unwrap();
    let (la, lo) = geo::destination(mke.lat.to_radians(), mke.lon.to_radians(), 180f64.to_radians(), 20.0 * 1852.0);
    h.sim.command(SimCommand::Spawn(SpawnRequest {
        lat: la.to_degrees(),
        lon: lo.to_degrees(),
        heading: 0.0,
        mode: SpawnMode::Air,
        agl_ft: Some(5_000.0),
        speed_kt: None,
        ground_elevation_ft: Some(mke.elevation_ft),
        keep_autopilot: true,
    }));
    h.settle();
    assert!(h.engaged(), "autopilot resumed after the relocation");
    assert!(h.sim.autopilot.is_managed());
    let done = h.run_until(1_800.0, |h| h.phase() == Phase::Stopped);
    assert!(done, "{}", h.phase_names());
    assert_stopped_on_runway(&h, "KMKE");
}

// ---------------------------------------------------------------------------
// Timing independence
// ---------------------------------------------------------------------------

fn run_with_frames(frame_dt: f64, steps: usize) -> Vec<f64> {
    let mut sim = Simulation::new();
    sim.command(SimCommand::SetAircraft { id: "a320".into() });
    sim.command(SimCommand::SetDestination { airport: Some("KMDW".into()), runway: None });
    let field = world::msl_ft_to_ellipsoid_m(41.98, -87.9, 672.0);
    let s = sim.snapshot();
    sim.command(SimCommand::Ground { lat: s[snap::LAT], lon: s[snap::LON], height: Some(field) });
    sim.command(SimCommand::ToggleAutopilot);
    let mut stepper = FixedStepper::default();
    let mut taken = 0;
    // Display frames of the given length, until just short of the step count...
    while taken + 4 < steps {
        taken += stepper.advance(&mut sim, frame_dt);
    }
    // ...then the last few physics steps one by one, so every run ends on the same step.
    while taken < steps {
        sim.step(DT);
        taken += 1;
    }
    sim.snapshot()
}

#[test]
fn autopilot_is_independent_of_the_display_frame_rate() {
    // The same 45 s takeoff driven by 30, 60 and 144 Hz display frames. The
    // physics runs in identical fixed 120 Hz steps, so the flights are identical.
    let steps = (45.0 / DT) as usize;
    let a = run_with_frames(1.0 / 30.0, steps);
    let b = run_with_frames(1.0 / 60.0, steps);
    let c = run_with_frames(1.0 / 144.0, steps);
    assert!(a[snap::AGL_FT] > 100.0, "airborne after 45 s ({} ft)", a[snap::AGL_FT]);
    for (name, s) in [("60 Hz", &b), ("144 Hz", &c)] {
        for i in [snap::ECEF_X, snap::ECEF_Y, snap::ECEF_Z, snap::QX, snap::QY, snap::QZ, snap::QW, snap::IAS_KT, snap::THROTTLE, snap::AP_PHASE] {
            assert!((a[i] - s[i]).abs() < 1e-9, "{name}: field {i} differs: {} vs {}", a[i], s[i]);
        }
    }
}

#[test]
fn faster_sim_rate_flies_the_same_landing() {
    let mut h = Harness::new("b737", airport_terrain(&["KORD"]));
    h.command(SimCommand::SetTimeScale { scale: 4.0 });
    h.spawn_runway("KORD", "28R", RunwaySpawnKind::Approach);
    h.toggle_ap();
    let done = h.run_until(300.0, |h| h.phase() == Phase::Stopped);
    assert!(done, "{}", h.phase_names());
    assert_healthy(&h, "4x sim rate");
    assert_eq!(assert_stopped_on_runway(&h, "KORD"), "28R");
    assert!(first_touchdown_fpm(&h) > -400.0);
}
