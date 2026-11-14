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

/// Snapshot publication interval (~60 Hz; the frontend interpolates between them).
const PUBLISH_INTERVAL: Duration = Duration::from_micros(16_667);
/// Upper bound on a single wait so a quiet channel never stalls the loop.
const MAX_WAIT: Duration = Duration::from_millis(8);

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

type Subscribers = (Channel<InvokeResponseBody>, Channel<Vec<SimEvent>>);

/// Applies one host message.
fn handle(msg: HostMsg, sim: &mut Simulation, subscribers: &mut Option<Subscribers>) {
    match msg {
        HostMsg::Input(i) => sim.set_input(i),
        HostMsg::Command(c) => sim.command(c),
        HostMsg::Subscribe { snapshots, events } => *subscribers = Some((snapshots, events)),
    }
}

/// Serializes the snapshot as little-endian `f64`s into a fresh buffer (the IPC
/// channel takes ownership, so one allocation per publish is unavoidable).
fn encode_snapshot(snapshot: &[f64]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(snapshot.len() * 8);
    for v in snapshot {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    bytes
}

fn sim_loop(rx: Receiver<HostMsg>) {
    let mut sim = Simulation::new();
    let mut stepper = FixedStepper::default();
    let mut subscribers: Option<Subscribers> = None;
    let mut snapshot = vec![0.0f64; snap::LEN];
    let mut last = Instant::now();
    let mut next_publish = Instant::now();

    loop {
        // Sleep until the next physics step or publish is due, waking early
        // for pilot input so it lands in the very next step.
        let now = Instant::now();
        let step_due = now + Duration::from_secs_f64(stepper.time_to_next_step());
        let wake = step_due.min(next_publish).min(now + MAX_WAIT);
        match rx.recv_timeout(wake.saturating_duration_since(now)) {
            Ok(msg) => handle(msg, &mut sim, &mut subscribers),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        // Drain anything else that queued up.
        loop {
            match rx.try_recv() {
                Ok(msg) => handle(msg, &mut sim, &mut subscribers),
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return,
            }
        }

        let now = Instant::now();
        stepper.advance(&mut sim, (now - last).as_secs_f64());
        last = now;

        if now >= next_publish {
            // Keep a steady cadence; resync if we fell far behind (e.g. app suspended).
            next_publish += PUBLISH_INTERVAL;
            if next_publish < now {
                next_publish = now + PUBLISH_INTERVAL;
            }
            if let Some((snap_ch, event_ch)) = &subscribers {
                sim.write_snapshot(&mut snapshot);
                let events = sim.take_events();
                let ok = snap_ch.send(InvokeResponseBody::Raw(encode_snapshot(&snapshot))).is_ok()
                    && (events.is_empty() || event_ch.send(events).is_ok());
                if !ok {
                    // Webview reloaded or closed; wait for a new subscription.
                    subscribers = None;
                }
            }
        }
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
