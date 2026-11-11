//! Prints a takeoff + climb trace for each aircraft: `cargo run -p sim-core --example trace`
use sim_core::{snap, ControlInput, SimCommand, Simulation};

fn main() {
    for ac in ["b737", "a320", "bizjet", "longitude", "c172"] {
        let mut sim = Simulation::new();
        sim.command(SimCommand::SetAircraft { id: ac.into() });
        let s = sim.snapshot();
        let ground = s[snap::HEIGHT] - sim.spec().gear_height_m;
        sim.command(SimCommand::Ground { lat: s[snap::LAT], lon: s[snap::LON], height: Some(ground) });
        sim.command(SimCommand::SetThrottle { value: 1.0 });
        println!("== {ac}");
        for i in 0..(120 * 120) {
            let s = sim.snapshot();
            let mut inp = ControlInput::default();
            if s[snap::IAS_KT] > sim.spec().v_rotate_kt && s[snap::PITCH] < 10.0 && s[snap::AGL_FT] < 1500.0 {
                inp.pitch = 0.5;
            }
            if s[snap::AGL_FT] > 300.0 && s[snap::GEAR] > 0.99 && sim.spec().retractable_gear {
                sim.command(SimCommand::ToggleGear);
            }
            sim.set_input(inp);
            sim.step(1.0 / 120.0);
            sim.command(SimCommand::Ground { lat: s[snap::LAT], lon: s[snap::LON], height: Some(ground) });
            for e in sim.take_events() {
                println!("  t={:5.1} {:?}", i as f64 / 120.0, e);
            }
            if i % (120 * 10) == 0 {
                println!(
                    "  t={:5.1} ias={:5.1} gs={:5.1} agl={:6.0} vs={:6.0} pitch={:5.1} alpha={:5.1} g={:4.2} hdg={:5.1} thr={:.2}",
                    i as f64 / 120.0, s[snap::IAS_KT], s[snap::GS_KT], s[snap::AGL_FT], s[snap::VS_FPM],
                    s[snap::PITCH], s[snap::ALPHA], s[snap::G_LOAD], s[snap::HEADING], s[snap::ENGINE]
                );
            }
        }
    }
}

#[allow(dead_code)]
pub fn maneuvers() {}
