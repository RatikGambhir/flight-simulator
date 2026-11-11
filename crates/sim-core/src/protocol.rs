//! Messages exchanged between the simulation and the frontend.
//!
//! * [`ControlInput`] — continuous pilot inputs, sent whenever they change.
//! * [`SimCommand`] — discrete commands (JSON, tagged by `type`).
//! * Snapshot — a flat `f64` array (see [`snap`]) streamed at display rate.
//!   The binary layout avoids JSON parsing on the hot path; the TypeScript
//!   mirror lives in `src/sim/protocol.ts` and must stay in sync.

use serde::{Deserialize, Serialize};

/// Pilot inputs. Axes are in [-1, 1]; brake in [0, 1]. The throttle lever
/// itself lives in the simulation (so autothrottle and spawns can move it);
/// the frontend drives it with `throttle_rate` or [`SimCommand::SetThrottle`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ControlInput {
    /// +1 = pull back (nose up).
    pub pitch: f64,
    /// +1 = roll right.
    pub roll: f64,
    /// +1 = yaw right (rudder / nosewheel).
    pub yaw: f64,
    /// Lever movement request in [-1, 1] (full deflection = 60 %/s).
    pub throttle_rate: f64,
    pub brake: f64,
    /// Hold for reverse thrust (jets, on the ground, throttle at idle); 0 or 1.
    pub reverse: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SpawnMode {
    /// Parked on the ground at the location.
    #[default]
    Ground,
    /// In flight at the requested altitude.
    Air,
}

/// Spawn at an arbitrary coordinate.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpawnRequest {
    pub lat: f64,
    pub lon: f64,
    #[serde(default)]
    pub heading: f64,
    #[serde(default)]
    pub mode: SpawnMode,
    /// For air spawns: height above the ground in feet.
    #[serde(default)]
    pub agl_ft: Option<f64>,
    /// For air spawns: indicated airspeed in knots (defaults to cruise-ish).
    #[serde(default)]
    pub speed_kt: Option<f64>,
    /// Known ground elevation in feet MSL, if any (e.g. airport elevation).
    #[serde(default)]
    pub ground_elevation_ft: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunwaySpawnKind {
    /// Lined up on the runway, ready for takeoff.
    Takeoff,
    /// On a stabilized final approach, about 6 nm out.
    Approach,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SimCommand {
    Spawn(SpawnRequest),
    SpawnRunway {
        airport: String,
        #[serde(default)]
        runway: Option<String>,
        kind: RunwaySpawnKind,
    },
    /// Re-spawns at the most recent spawn point.
    Reset,
    SetAircraft { id: String },
    SetPaused { paused: bool },
    SetThrottle { value: f64 },
    TogglePause,
    ToggleGear,
    FlapsUp,
    FlapsDown,
    SetFlaps { index: usize },
    ToggleSpoilers,
    ToggleParkingBrake,
    SetAssist { enabled: bool },
    ToggleAutopilot,
    Autopilot(AutopilotCommand),
    /// Ground height (meters above the WGS84 ellipsoid) sampled by the
    /// renderer under the aircraft. `height: None` means "no data here".
    Ground { lat: f64, lon: f64, height: Option<f64> },
    SetTimeScale { scale: f64 },
    /// The renderer detected the aircraft hitting scenery (buildings, terrain ahead).
    Collision { what: String },
    /// Surface wind and turbulence.
    SetWeather(WeatherRequest),
}

/// Weather settings sent by the UI.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct WeatherRequest {
    /// Direction the wind blows from (degrees true).
    pub wind_from_deg: f64,
    /// Surface wind speed (knots).
    pub wind_speed_kt: f64,
    /// Turbulence intensity 0..1.
    pub turbulence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AutopilotCommand {
    pub engaged: Option<bool>,
    pub heading_hold: Option<bool>,
    pub altitude_hold: Option<bool>,
    pub autothrottle: Option<bool>,
    pub heading: Option<f64>,
    pub altitude_ft: Option<f64>,
    pub speed_kt: Option<f64>,
    pub vertical_speed_fpm: Option<f64>,
    /// Relative adjustments (added to current targets).
    pub heading_delta: Option<f64>,
    pub altitude_delta_ft: Option<f64>,
    pub speed_delta_kt: Option<f64>,
}

/// Discrete notifications for the UI.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SimEvent {
    Spawned { generation: u32 },
    Touchdown { vertical_speed_fpm: f64, rating: String },
    Liftoff,
    Crashed { reason: String },
    Stall,
    Message { text: String },
}

/// Snapshot field indices. Keep in sync with `src/sim/protocol.ts`.
pub mod snap {
    pub const TIME: usize = 0;
    pub const ECEF_X: usize = 1;
    pub const ECEF_Y: usize = 2;
    pub const ECEF_Z: usize = 3;
    /// Body (x fwd, y left, z up) -> ECEF quaternion.
    pub const QX: usize = 4;
    pub const QY: usize = 5;
    pub const QZ: usize = 6;
    pub const QW: usize = 7;
    pub const LAT: usize = 8;
    pub const LON: usize = 9;
    /// Height above the ellipsoid (m).
    pub const HEIGHT: usize = 10;
    pub const ALT_MSL_FT: usize = 11;
    pub const AGL_FT: usize = 12;
    pub const HEADING: usize = 13;
    pub const PITCH: usize = 14;
    pub const ROLL: usize = 15;
    pub const IAS_KT: usize = 16;
    pub const TAS_KT: usize = 17;
    pub const GS_KT: usize = 18;
    pub const VS_FPM: usize = 19;
    pub const MACH: usize = 20;
    pub const THROTTLE: usize = 21;
    pub const ENGINE: usize = 22;
    pub const GEAR: usize = 23;
    pub const FLAPS: usize = 24;
    pub const FLAPS_INDEX: usize = 25;
    pub const SPOILERS: usize = 26;
    pub const BRAKE: usize = 27;
    pub const ALPHA: usize = 28;
    pub const G_LOAD: usize = 29;
    pub const FLAGS: usize = 30;
    pub const AILERON: usize = 31;
    pub const ELEVATOR: usize = 32;
    pub const RUDDER: usize = 33;
    pub const AP_HEADING: usize = 34;
    pub const AP_ALT_FT: usize = 35;
    pub const AP_SPEED_KT: usize = 36;
    pub const AP_VS_FPM: usize = 37;
    pub const AP_MODES: usize = 38;
    pub const AIRCRAFT_INDEX: usize = 39;
    pub const TOUCHDOWN_FPM: usize = 40;
    pub const GROUND_HEIGHT: usize = 41;
    pub const TRACK: usize = 42;
    pub const GENERATION: usize = 43;
    pub const FPA: usize = 44;
    pub const VEL_E: usize = 45;
    pub const VEL_N: usize = 46;
    pub const VEL_U: usize = 47;
    pub const TIME_SCALE: usize = 48;
    /// Specific force in body axes, in g (x forward, y right, z up; 1 g up in level flight).
    pub const NX: usize = 49;
    pub const NY: usize = 50;
    pub const NZ: usize = 51;
    /// Wind at the aircraft (including gusts), local east/north/up, m/s.
    pub const WIND_E: usize = 52;
    pub const WIND_N: usize = 53;
    pub const WIND_U: usize = 54;
    /// Thrust reverser deployment 0..1.
    pub const REVERSER: usize = 55;
    /// Ground-effect strength 0 (none) .. 1 (wheels on the runway).
    pub const GROUND_EFFECT: usize = 56;
    pub const LEN: usize = 57;

    pub mod flags {
        pub const ON_GROUND: u32 = 1;
        pub const PAUSED: u32 = 2;
        pub const CRASHED: u32 = 4;
        pub const STALL: u32 = 8;
        pub const AWAITING_GROUND: u32 = 16;
        pub const PARKING_BRAKE: u32 = 32;
        pub const ASSIST: u32 = 64;
        pub const AP_ENGAGED: u32 = 128;
        pub const OVERSPEED: u32 = 256;
        pub const TAILSTRIKE: u32 = 512;
    }

    pub mod ap_modes {
        pub const HEADING: u32 = 1;
        pub const ALTITUDE: u32 = 2;
        pub const AUTOTHROTTLE: u32 = 4;
    }
}
