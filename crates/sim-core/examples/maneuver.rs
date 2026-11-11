//! Hands-on handling check: `cargo run -p sim-core --example maneuver`
use sim_core::protocol::{SpawnMode, SpawnRequest};
use sim_core::{snap, ControlInput, SimCommand, Simulation};

fn main() {
    for ac in ["b737", "bizjet", "c172"] {
        for assist in [true, false] {
            let mut sim = Simulation::new();
            sim.command(SimCommand::SetAircraft { id: ac.into() });
            sim.command(SimCommand::SetAssist { enabled: assist });
            sim.command(SimCommand::Spawn(SpawnRequest {
                lat: 41.88, lon: -87.63, heading: 0.0, mode: SpawnMode::Air,
                agl_ft: Some(5000.0), speed_kt: None, ground_elevation_ft: Some(600.0),
            }));
            let s = sim.snapshot();
            sim.command(SimCommand::Ground { lat: s[snap::LAT], lon: s[snap::LON], height: Some(150.0) });
            println!("== {ac} assist={assist}");
            for i in 0..(120 * 70) {
                let t = i as f64 / 120.0;
                let mut inp = ControlInput::default();
                if (2.0..4.0).contains(&t) { inp.roll = 1.0; }
                if (30.0..33.0).contains(&t) { inp.roll = -1.0; }
                if (45.0..48.0).contains(&t) { inp.pitch = 0.5; }
                sim.set_input(inp);
                sim.step(1.0 / 120.0);
                if i % (120 * 5) == 0 {
                    let s = sim.snapshot();
                    println!(
                        "  t={:4.0} ias={:5.1} alt={:6.0} vs={:6.0} pitch={:5.1} roll={:6.1} hdg={:5.1} alpha={:4.1} g={:4.2} thr={:.2}",
                        t, s[snap::IAS_KT], s[snap::ALT_MSL_FT], s[snap::VS_FPM], s[snap::PITCH], s[snap::ROLL],
                        s[snap::HEADING], s[snap::ALPHA], s[snap::G_LOAD], s[snap::THROTTLE]
                    );
                }
                for e in sim.take_events() { if !matches!(e, sim_core::SimEvent::Message{..}) { println!("  t={t:.1} {e:?}"); } }
            }
        }
    }
}
