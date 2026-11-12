//! Flies a complete autopilot flight and prints a trace:
//! `cargo run -p sim-core --release --example autoflight -- b737 KORD 28R KMKE [wind_from wind_kt turbulence]`
//!
//! The aircraft spawns on the departure runway, the destination is set, and
//! `Z` (toggle autopilot) is pressed once. Everything after that is the
//! autopilot: takeoff, climb, cruise, descent, approach, landing and rollout.
//!
//! `-- c172 approach KORD 28R [wind_from wind_kt turbulence]` starts on a 6 nm
//! final instead and lets the autopilot land.

#[path = "../tests/common/mod.rs"]
mod common;

use common::Harness;
use sim_core::autopilot::Phase;
use sim_core::protocol::RunwaySpawnKind;

/// `stats <aircraft> <wind_from> <wind_kt> <turbulence> [runs]`: many 6 nm
/// approaches with different gust sequences; prints the touchdown statistics.
fn stats(args: &[String]) {
    let ac = args.first().cloned().unwrap_or_else(|| "b737".into());
    let f = |i: usize, d: f64| args.get(i).and_then(|v| v.parse().ok()).unwrap_or(d);
    let (wf, wk, tb, runs) = (f(1, 270.0), f(2, 0.0), f(3, 0.0), f(4, 12.0) as usize);
    let only: Option<usize> = std::env::var("AP_RUN").ok().and_then(|v| v.parse().ok());
    let mut tds = Vec::new();
    let (mut gas, mut crashes, mut holds, mut hard) = (0, 0, 0, 0);
    let mut reasons: std::collections::BTreeMap<String, usize> = Default::default();
    for run in 0..runs {
        if only.is_some_and(|o| o != run) {
            continue;
        }
        let mut h = Harness::new(&ac, common::airport_terrain(&["KORD"]));
        h.verbose = only.is_some();
        h.weather(wf, wk, tb);
        // Fly a different stretch of the gust sequence each run.
        h.settle();
        h.log_every = 120;
        for _ in 0..run * 997 {
            h.step();
        }
        h.spawn_runway("KORD", "28R", RunwaySpawnKind::Approach);
        h.toggle_ap();
        h.run_until(3600.0, |h| matches!(h.phase(), Phase::Stopped | Phase::Hold) || !h.engaged());
        for m in h.messages().iter().filter(|m| m.starts_with("Go-around")) {
            gas += 1;
            *reasons.entry(m.trim_start_matches("Go-around: ").to_string()).or_default() += 1;
        }
        if let Some(why) = &h.crashed {
            crashes += 1;
            println!("  run {run}: crashed ({why}) after {}", h.phase_names());
        }
        if h.phase() == Phase::Hold {
            holds += 1;
        }
        if let Some(&(_, fpm)) = h.touchdowns.first() {
            tds.push(fpm);
            if fpm < -600.0 {
                hard += 1;
            }
        }
    }
    tds.sort_by(|a, b| a.total_cmp(b));
    let mean = tds.iter().sum::<f64>() / tds.len().max(1) as f64;
    println!(
        "{ac} wind {wf:.0}/{wk:.0} turb {tb:.2}: runs {runs} landed {} crashes {crashes} holds {holds} go-arounds {gas} | touchdown fpm mean {mean:.0} worst {:.0} best {:.0} | >600 fpm: {hard}",
        tds.len(),
        tds.first().copied().unwrap_or(0.0),
        tds.last().copied().unwrap_or(0.0)
    );
    if !reasons.is_empty() {
        println!("  go-around reasons: {reasons:?}");
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("stats") {
        return stats(&args[1..]);
    }
    let arg = |i: usize, d: &str| args.get(i).cloned().unwrap_or_else(|| d.to_string());
    let (ac, from, rwy, to) = (arg(0, "b737"), arg(1, "KORD"), arg(2, "28R"), arg(3, "KMKE"));
    let wind_from: f64 = arg(4, "270").parse().unwrap_or(270.0);
    let wind_kt: f64 = arg(5, "0").parse().unwrap_or(0.0);
    let turb: f64 = arg(6, "0").parse().unwrap_or(0.0);

    let approach = from == "approach";
    let (from, rwy, to) = if approach { (rwy.clone(), to.clone(), rwy) } else { (from, rwy, to) };
    let mut h = Harness::new(&ac, common::airport_terrain(&[&from, &to]));
    h.verbose = true;
    h.weather(wind_from, wind_kt, turb);
    if approach {
        h.spawn_runway(&from, &rwy, RunwaySpawnKind::Approach);
    } else {
        h.destination(&to);
        h.spawn_runway(&from, &rwy, RunwaySpawnKind::Takeoff);
    }
    h.toggle_ap();
    let done = h.run_until(4.0 * 3600.0, |h| h.phase() == Phase::Stopped || !h.engaged());
    println!("\n{ac} {from} {rwy} -> {to}: finished={done} crashed={:?}", h.crashed);
    println!("phases: {}", h.phase_names());
    println!("touchdowns: {:?}", h.touchdowns);
    for m in h.messages() {
        println!("  · {m}");
    }
}
