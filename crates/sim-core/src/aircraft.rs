//! Aircraft performance definitions. Values are approximations of public data
//! for each class of aircraft, tuned for a believable but forgiving feel.
//! New aircraft are added by appending to [`catalog`] (and a matching visual
//! model on the frontend keyed by the same `id`).

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineKind {
    Jet,
    Propeller,
}

#[derive(Debug, Clone, Serialize)]
pub struct AircraftSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub manufacturer_style: &'static str,
    pub category: &'static str,
    pub description: &'static str,

    // Mass & geometry
    /// Typical operating mass (kg).
    pub mass_kg: f64,
    pub wing_area_m2: f64,
    pub wingspan_m: f64,
    pub length_m: f64,
    /// Height of the center of gravity above the ground with gear extended (m).
    pub gear_height_m: f64,
    /// Height of the center of gravity above the ground when sitting on the belly (m).
    pub belly_height_m: f64,
    /// Distance from nose gear to main gear (m), used for ground steering.
    pub wheelbase_m: f64,
    pub retractable_gear: bool,
    /// Pitch attitude when resting on all wheels (deg).
    pub rest_pitch_deg: f64,
    /// Maximum pitch on the ground before a tail strike (deg).
    pub tailstrike_pitch_deg: f64,

    // Propulsion
    pub engine: EngineKind,
    pub engine_count: u32,
    /// Max static thrust, total (N).
    pub max_thrust_n: f64,
    /// Seconds for the engines to spool from idle to full.
    pub spool_time_s: f64,
    /// Idle thrust fraction.
    pub idle_thrust: f64,
    /// For propellers: shaft power times propeller efficiency (W).
    pub prop_power_w: f64,

    // Aerodynamics
    pub cd0: f64,
    pub oswald: f64,
    pub cl0: f64,
    /// Lift curve slope (per radian).
    pub cl_alpha: f64,
    pub alpha_stall_deg: f64,
    /// Lift coefficient added by fully extended flaps. Tuned so each type flies
    /// its approach at a realistic attitude (airliners ~2-3° nose up at Vref).
    pub flap_cl: f64,
    pub flap_cd: f64,
    pub gear_cd: f64,
    pub spoiler_cd: f64,
    pub spoiler_cl: f64,
    pub flap_detents: &'static [&'static str],

    // Handling
    /// Max commanded roll rate (deg/s).
    pub max_roll_rate: f64,
    /// Max commanded pitch rate (deg/s) in direct mode.
    pub max_pitch_rate: f64,
    /// Max commanded yaw rate from rudder (deg/s).
    pub max_yaw_rate: f64,
    /// Time constant of the rate response (s); larger feels heavier.
    pub response_time_s: f64,
    /// Max positive load factor used by the assisted control law.
    pub max_load_factor: f64,
    /// Dynamic pressure (Pa) at which control surfaces reach full authority.
    pub full_authority_q: f64,

    // Speeds (knots IAS) used for spawning, UI and autopilot limits
    pub v_rotate_kt: f64,
    pub v_approach_kt: f64,
    pub v_cruise_kt: f64,
    pub v_max_kt: f64,
    pub cruise_alt_ft: f64,
    pub max_alt_ft: f64,
    pub service_ceiling_note: &'static str,
}

impl AircraftSpec {
    pub fn aspect_ratio(&self) -> f64 {
        self.wingspan_m * self.wingspan_m / self.wing_area_m2
    }

    pub fn induced_k(&self) -> f64 {
        1.0 / (std::f64::consts::PI * self.oswald * self.aspect_ratio())
    }

    pub fn takeoff_flaps(&self) -> usize {
        match self.flap_detents.len() {
            n if n >= 5 => 2,
            n if n >= 3 => 1,
            _ => 0,
        }
    }
}

const AIRLINER_FLAPS: &[&str] = &["UP", "1", "5", "15", "30"];
const A320_FLAPS: &[&str] = &["0", "1", "2", "3", "FULL"];
const BIZJET_FLAPS: &[&str] = &["UP", "15°", "35°"];
const GA_FLAPS: &[&str] = &["0°", "10°", "20°", "30°"];

static CATALOG: &[AircraftSpec] = &[
    AircraftSpec {
        id: "b737",
        name: "737-800 style",
        manufacturer_style: "Boeing-style narrowbody",
        category: "Commercial airliner",
        description: "Twin-engine narrowbody workhorse. Heavy, stable and fast; plan your descents early.",
        mass_kg: 62_000.0,
        wing_area_m2: 124.6,
        wingspan_m: 35.8,
        length_m: 39.5,
        gear_height_m: 3.05,
        belly_height_m: 1.6,
        wheelbase_m: 15.6,
        retractable_gear: true,
        rest_pitch_deg: 0.6,
        tailstrike_pitch_deg: 11.0,
        engine: EngineKind::Jet,
        engine_count: 2,
        max_thrust_n: 2.0 * 121_000.0,
        spool_time_s: 4.5,
        idle_thrust: 0.04,
        prop_power_w: 0.0,
        cd0: 0.021,
        oswald: 0.80,
        cl0: 0.25,
        cl_alpha: 5.4,
        alpha_stall_deg: 15.0,
        flap_cl: 0.78,
        flap_cd: 0.075,
        gear_cd: 0.018,
        spoiler_cd: 0.06,
        spoiler_cl: -0.45,
        flap_detents: AIRLINER_FLAPS,
        max_roll_rate: 18.0,
        max_pitch_rate: 5.0,
        max_yaw_rate: 4.0,
        response_time_s: 0.75,
        max_load_factor: 2.5,
        full_authority_q: 6_000.0,
        v_rotate_kt: 145.0,
        v_approach_kt: 142.0,
        v_cruise_kt: 290.0,
        v_max_kt: 340.0,
        cruise_alt_ft: 35_000.0,
        max_alt_ft: 41_000.0,
        service_ceiling_note: "FL410",
    },
    AircraftSpec {
        id: "a320",
        name: "A320neo style",
        manufacturer_style: "Airbus-style narrowbody",
        category: "Commercial airliner",
        description: "Modern fly-by-wire narrowbody with a wide, comfortable flight envelope.",
        mass_kg: 64_000.0,
        wing_area_m2: 122.6,
        wingspan_m: 35.8,
        length_m: 37.6,
        gear_height_m: 3.2,
        belly_height_m: 1.7,
        wheelbase_m: 12.6,
        retractable_gear: true,
        rest_pitch_deg: 0.4,
        tailstrike_pitch_deg: 11.5,
        engine: EngineKind::Jet,
        engine_count: 2,
        max_thrust_n: 2.0 * 120_600.0,
        spool_time_s: 4.0,
        idle_thrust: 0.04,
        prop_power_w: 0.0,
        cd0: 0.020,
        oswald: 0.82,
        cl0: 0.26,
        cl_alpha: 5.5,
        alpha_stall_deg: 15.0,
        flap_cl: 0.80,
        flap_cd: 0.075,
        gear_cd: 0.018,
        spoiler_cd: 0.06,
        spoiler_cl: -0.45,
        flap_detents: A320_FLAPS,
        max_roll_rate: 15.0,
        max_pitch_rate: 5.0,
        max_yaw_rate: 4.0,
        response_time_s: 0.7,
        max_load_factor: 2.5,
        full_authority_q: 6_000.0,
        v_rotate_kt: 140.0,
        v_approach_kt: 135.0,
        v_cruise_kt: 280.0,
        v_max_kt: 340.0,
        cruise_alt_ft: 36_000.0,
        max_alt_ft: 39_800.0,
        service_ceiling_note: "FL398",
    },
    AircraftSpec {
        id: "bizjet",
        name: "Midsize business jet",
        manufacturer_style: "Private jet",
        category: "Business jet",
        description: "Light, quick and high-flying. Climbs like a rocket and turns crisply.",
        mass_kg: 14_500.0,
        wing_area_m2: 49.0,
        wingspan_m: 19.4,
        length_m: 21.0,
        gear_height_m: 1.55,
        belly_height_m: 0.75,
        wheelbase_m: 8.6,
        retractable_gear: true,
        rest_pitch_deg: 0.5,
        tailstrike_pitch_deg: 13.0,
        engine: EngineKind::Jet,
        engine_count: 2,
        max_thrust_n: 2.0 * 34_000.0,
        spool_time_s: 3.0,
        idle_thrust: 0.04,
        prop_power_w: 0.0,
        cd0: 0.019,
        oswald: 0.82,
        cl0: 0.2,
        cl_alpha: 5.3,
        alpha_stall_deg: 16.0,
        flap_cl: 0.55,
        flap_cd: 0.06,
        gear_cd: 0.02,
        spoiler_cd: 0.05,
        spoiler_cl: -0.4,
        flap_detents: BIZJET_FLAPS,
        max_roll_rate: 35.0,
        max_pitch_rate: 9.0,
        max_yaw_rate: 6.0,
        response_time_s: 0.45,
        max_load_factor: 3.0,
        full_authority_q: 4_500.0,
        v_rotate_kt: 118.0,
        v_approach_kt: 120.0,
        v_cruise_kt: 300.0,
        v_max_kt: 350.0,
        cruise_alt_ft: 41_000.0,
        max_alt_ft: 45_000.0,
        service_ceiling_note: "FL450",
    },
    AircraftSpec {
        id: "c172",
        name: "Skyhawk style",
        manufacturer_style: "Cessna-style high-wing single",
        category: "General aviation",
        description: "The classic four-seat trainer. Slow, gentle and perfect for low-level sightseeing.",
        mass_kg: 1_000.0,
        wing_area_m2: 16.2,
        wingspan_m: 11.0,
        length_m: 8.28,
        gear_height_m: 1.05,
        belly_height_m: 0.45,
        wheelbase_m: 1.65,
        retractable_gear: false,
        rest_pitch_deg: 1.5,
        tailstrike_pitch_deg: 14.0,
        engine: EngineKind::Propeller,
        engine_count: 1,
        max_thrust_n: 2_200.0,
        spool_time_s: 0.8,
        idle_thrust: 0.03,
        prop_power_w: 80_000.0,
        cd0: 0.031,
        oswald: 0.75,
        cl0: 0.32,
        cl_alpha: 4.9,
        alpha_stall_deg: 16.0,
        flap_cl: 0.50,
        flap_cd: 0.06,
        gear_cd: 0.0,
        spoiler_cd: 0.0,
        spoiler_cl: 0.0,
        flap_detents: GA_FLAPS,
        max_roll_rate: 45.0,
        max_pitch_rate: 18.0,
        max_yaw_rate: 12.0,
        response_time_s: 0.25,
        max_load_factor: 3.8,
        full_authority_q: 1_100.0,
        v_rotate_kt: 55.0,
        v_approach_kt: 65.0,
        v_cruise_kt: 115.0,
        v_max_kt: 160.0,
        cruise_alt_ft: 5_500.0,
        max_alt_ft: 14_000.0,
        service_ceiling_note: "14,000 ft",
    },
];

/// All available aircraft.
pub fn catalog() -> &'static [AircraftSpec] {
    CATALOG
}

pub fn find(id: &str) -> Option<&'static AircraftSpec> {
    CATALOG.iter().find(|a| a.id == id)
}

pub fn default_aircraft() -> &'static AircraftSpec {
    &CATALOG[0]
}
