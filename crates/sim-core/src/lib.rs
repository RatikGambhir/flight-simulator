//! # sim-core
//!
//! Platform-independent core of the GeoFlight simulator. It owns the
//! simulation state (aircraft dynamics, autopilot, spawn logic) and the
//! bundled world database. Hosts:
//! * `src-tauri` runs it on a native thread and streams snapshots over IPC.
//! * `crates/sim-wasm` compiles it to WebAssembly for browser development.

pub mod aircraft;
pub mod atmosphere;
pub mod autopilot;
pub mod geo;
pub mod protocol;
pub mod sim;
pub mod stepper;
pub mod weather;
pub mod world;

pub use protocol::{snap, ControlInput, SimCommand, SimEvent};
pub use sim::Simulation;
pub use stepper::FixedStepper;

use serde::Serialize;

/// Aircraft list for the UI (JSON-friendly).
#[derive(Serialize)]
pub struct AircraftInfo {
    pub index: usize,
    #[serde(flatten)]
    pub spec: &'static aircraft::AircraftSpec,
}

pub fn aircraft_list() -> Vec<AircraftInfo> {
    aircraft::catalog().iter().enumerate().map(|(index, spec)| AircraftInfo { index, spec }).collect()
}

/// Request/response API shared by all hosts (JSON in, JSON out) so the
/// frontend can call it identically through Tauri or WASM.
pub mod api {
    use super::*;
    use serde::Deserialize;
    use serde_json::{json, Value};

    #[derive(Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    pub enum Query {
        Search { query: String, #[serde(default = "default_limit")] limit: usize },
        Airport { ident: String },
        NearestAirports { lat: f64, lon: f64, #[serde(default = "default_radius")] radius_km: f64, #[serde(default = "default_limit")] limit: usize },
        MapAirports { #[serde(default)] include_medium: bool },
        AircraftList,
        Geoid { lat: f64, lon: f64 },
    }

    fn default_limit() -> usize { 20 }
    fn default_radius() -> f64 { 80.0 }

    pub fn handle(q: Query) -> Value {
        let db = world::db();
        match q {
            Query::Search { query, limit } => json!(db.search(&query, limit.min(100))),
            Query::Airport { ident } => json!(db.airport_detail(&ident)),
            Query::NearestAirports { lat, lon, radius_km, limit } => {
                let list: Vec<Value> = db
                    .nearest_airports(lat, lon, radius_km.min(1000.0), limit.min(100))
                    .into_iter()
                    .map(|(d, a)| json!({ "distance_km": d, "airport": a }))
                    .collect();
                json!(list)
            }
            Query::MapAirports { include_medium } => {
                let list: Vec<Value> =
                    db.map_airports(include_medium).into_iter().map(|(i, n, la, lo)| json!([i, n, la, lo])).collect();
                json!(list)
            }
            Query::AircraftList => json!(aircraft_list()),
            Query::Geoid { lat, lon } => json!(world::geoid_undulation(lat, lon)),
        }
    }

    pub fn handle_json(s: &str) -> String {
        match serde_json::from_str::<Query>(s) {
            Ok(q) => handle(q).to_string(),
            Err(e) => json!({ "error": e.to_string() }).to_string(),
        }
    }
}
