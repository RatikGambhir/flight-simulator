//! Dependency-free WebAssembly exports for running `sim-core` in a browser
//! Web Worker (used by `npm run dev:web`). The API mirrors the Tauri
//! commands. Strings are exchanged as UTF-8 through a shared byte buffer.
//!
//! Build: `cargo build -p sim-wasm --target wasm32-unknown-unknown --release`

use sim_core::{snap, ControlInput, FixedStepper, SimCommand, Simulation};
use std::cell::RefCell;

struct Host {
    sim: Simulation,
    stepper: FixedStepper,
    snapshot: Vec<f64>,
    io: Vec<u8>,
}

thread_local! {
    static HOST: RefCell<Option<Host>> = const { RefCell::new(None) };
}

fn with_host<R>(f: impl FnOnce(&mut Host) -> R) -> R {
    HOST.with(|h| {
        let mut h = h.borrow_mut();
        let host = h.get_or_insert_with(|| Host {
            sim: Simulation::new(),
            stepper: FixedStepper::default(),
            snapshot: vec![0.0; snap::LEN],
            io: Vec::with_capacity(64 * 1024),
        });
        f(host)
    })
}

/// Reserves `len` bytes in the IO buffer and returns a pointer for JS to write into.
#[no_mangle]
pub extern "C" fn io_reserve(len: usize) -> *mut u8 {
    with_host(|h| {
        h.io.clear();
        h.io.resize(len, 0);
        h.io.as_mut_ptr()
    })
}

#[no_mangle]
pub extern "C" fn io_ptr() -> *const u8 {
    with_host(|h| h.io.as_ptr())
}

fn take_io_string(h: &mut Host) -> String {
    String::from_utf8_lossy(&h.io).into_owned()
}

fn put_io_string(h: &mut Host, s: String) -> usize {
    h.io = s.into_bytes();
    h.io.len()
}

/// Advances by `elapsed` seconds of wall time in fixed steps; returns steps taken.
#[no_mangle]
pub extern "C" fn sim_advance(elapsed: f64) -> u32 {
    with_host(|h| h.stepper.advance(&mut h.sim, elapsed) as u32)
}

/// Writes the latest snapshot and returns a pointer to `snap::LEN` f64 values.
#[no_mangle]
pub extern "C" fn sim_snapshot() -> *const f64 {
    with_host(|h| {
        h.sim.write_snapshot(&mut h.snapshot);
        h.snapshot.as_ptr()
    })
}

#[no_mangle]
pub extern "C" fn sim_snapshot_len() -> u32 {
    snap::LEN as u32
}

#[no_mangle]
pub extern "C" fn sim_input(pitch: f64, roll: f64, yaw: f64, throttle_rate: f64, brake: f64) {
    with_host(|h| h.sim.set_input(ControlInput { pitch, roll, yaw, throttle_rate, brake }));
}

/// Applies the JSON command previously written to the IO buffer. Returns 0 on success.
#[no_mangle]
pub extern "C" fn sim_command() -> u32 {
    with_host(|h| {
        let s = take_io_string(h);
        match serde_json::from_str::<SimCommand>(&s) {
            Ok(cmd) => {
                h.sim.command(cmd);
                0
            }
            Err(_) => 1,
        }
    })
}

/// Serializes pending events as JSON into the IO buffer; returns the byte length.
#[no_mangle]
pub extern "C" fn sim_events() -> usize {
    with_host(|h| {
        let ev = h.sim.take_events();
        let s = if ev.is_empty() { String::new() } else { serde_json::to_string(&ev).unwrap_or_default() };
        put_io_string(h, s)
    })
}

/// Runs the JSON world query in the IO buffer; the JSON reply replaces it. Returns its length.
#[no_mangle]
pub extern "C" fn world_query() -> usize {
    with_host(|h| {
        let q = take_io_string(h);
        let r = sim_core::api::handle_json(&q);
        put_io_string(h, r)
    })
}
