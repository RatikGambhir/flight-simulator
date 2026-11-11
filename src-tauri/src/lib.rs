//! Native host for the GeoFlight simulator.
//!
//! The simulation runs on a dedicated thread at a fixed 120 Hz step. The UI
//! thread never blocks on it: pilot inputs and commands are posted through an
//! mpsc queue, and the simulation streams binary snapshots (little-endian
//! `f64` array, see `sim_core::snap`) back over a Tauri IPC channel at ~60 Hz.

use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use sim_core::{snap, ControlInput, FixedStepper, SimCommand, SimEvent, Simulation};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

/// Snapshot publication interval.
const PUBLISH_INTERVAL: Duration = Duration::from_micros(16_667);
/// Loop tick; physics is decoupled from this by the fixed stepper.
const TICK: Duration = Duration::from_millis(2);

enum HostMsg {
    Input(ControlInput),
    Command(SimCommand),
    Subscribe { snapshots: Channel<InvokeResponseBody>, events: Channel<Vec<SimEvent>> },
}

struct SimHandle {
    tx: Sender<HostMsg>,
}

fn spawn_sim_thread() -> Sender<HostMsg> {
    let (tx, rx) = mpsc::channel::<HostMsg>();
    thread::Builder::new()
        .name("flight-sim".into())
        .spawn(move || sim_loop(rx))
        .expect("failed to start simulation thread");
    tx
}

fn sim_loop(rx: Receiver<HostMsg>) {
    let mut sim = Simulation::new();
    let mut stepper = FixedStepper::default();
    let mut subscribers: Option<(Channel<InvokeResponseBody>, Channel<Vec<SimEvent>>)> = None;
    let mut snapshot = vec![0.0f64; snap::LEN];
    let mut bytes = Vec::with_capacity(snap::LEN * 8);
    let mut last = Instant::now();
    let mut last_publish = Instant::now() - PUBLISH_INTERVAL;

    loop {
        // Drain all pending messages without blocking.
        loop {
            match rx.try_recv() {
                Ok(HostMsg::Input(i)) => sim.set_input(i),
                Ok(HostMsg::Command(c)) => sim.command(c),
                Ok(HostMsg::Subscribe { snapshots, events }) => subscribers = Some((snapshots, events)),
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return,
            }
        }

        let now = Instant::now();
        stepper.advance(&mut sim, (now - last).as_secs_f64());
        last = now;

        if now - last_publish >= PUBLISH_INTERVAL {
            last_publish = now;
            if let Some((snap_ch, event_ch)) = &subscribers {
                sim.write_snapshot(&mut snapshot);
                bytes.clear();
                for v in &snapshot {
                    bytes.extend_from_slice(&v.to_le_bytes());
                }
                let events = sim.take_events();
                let ok = snap_ch.send(InvokeResponseBody::Raw(bytes.clone())).is_ok()
                    && (events.is_empty() || event_ch.send(events).is_ok());
                if !ok {
                    // Webview reloaded or closed; wait for a new subscription.
                    subscribers = None;
                }
            }
        }

        thread::sleep(TICK);
    }
}

#[tauri::command]
fn sim_subscribe(
    state: State<'_, SimHandle>,
    snapshots: Channel<InvokeResponseBody>,
    events: Channel<Vec<SimEvent>>,
) -> Result<(), String> {
    state.tx.send(HostMsg::Subscribe { snapshots, events }).map_err(|e| e.to_string())
}

#[tauri::command]
fn sim_input(state: State<'_, SimHandle>, input: ControlInput) -> Result<(), String> {
    state.tx.send(HostMsg::Input(input)).map_err(|e| e.to_string())
}

#[tauri::command]
fn sim_command(state: State<'_, SimHandle>, command: SimCommand) -> Result<(), String> {
    state.tx.send(HostMsg::Command(command)).map_err(|e| e.to_string())
}

/// World database queries (search, airport details, ...). Async so lookups
/// run on Tauri's worker pool rather than the main thread.
#[tauri::command]
async fn world_query(query: serde_json::Value) -> Result<serde_json::Value, String> {
    let q: sim_core::api::Query = serde_json::from_value(query).map_err(|e| e.to_string())?;
    Ok(sim_core::api::handle(q))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Parse the bundled world database in the background so the first search is instant.
    thread::spawn(|| {
        let _ = sim_core::world::db();
    });

    tauri::Builder::default()
        .manage(SimHandle { tx: spawn_sim_thread() })
        .invoke_handler(tauri::generate_handler![sim_subscribe, sim_input, sim_command, world_query])
        .run(tauri::generate_context!())
        .expect("error while running GeoFlight");
}
