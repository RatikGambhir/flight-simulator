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
    /// Afterburning jets: total sea-level static thrust in full afterburner (N).
    /// `max_thrust_n` is then the dry (military power) thrust. Zero for none.
    pub afterburner_thrust_n: f64,
    /// Throttle lever position where the afterburner range begins (0 = none).
    pub afterburner_detent: f64,
    pub thrust_reversers: bool,

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
    /// Flaps scheduled automatically with the landing gear (fighter flaperons)
    /// rather than set by the pilot.
    pub auto_flaps: bool,
    /// Peak transonic/supersonic wave drag coefficient (0 = not modelled).
    pub wave_drag_cd: f64,
    /// Mach number where the drag rise begins.
    pub drag_rise_mach: f64,

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
    /// Max negative load factor (full forward stick) in assisted mode.
    pub min_load_factor: f64,
    /// Full-envelope fly-by-wire: no bank-angle limits, path hold works inverted,
    /// and turn coordination holds at any attitude (aerobatic fighters).
    pub aerobatic: bool,
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
        if self.auto_flaps {
            return self.flap_detents.len() - 1;
        }
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
const LONGITUDE_FLAPS: &[&str] = &["UP", "1", "2", "FULL"];
const GA_FLAPS: &[&str] = &["0°", "10°", "20°", "30°"];
/// Fighter flaperons are scheduled by the flight control computer: they droop
/// for takeoff and landing whenever the gear handle is down.
const FIGHTER_FLAPS: &[&str] = &["AUTO", "TO/LDG"];

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
        afterburner_thrust_n: 0.0,
        afterburner_detent: 0.0,
        thrust_reversers: true,
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
        auto_flaps: false,
        wave_drag_cd: 0.0,
        drag_rise_mach: 0.0,
        max_roll_rate: 18.0,
        max_pitch_rate: 5.0,
        max_yaw_rate: 4.0,
        response_time_s: 0.75,
        max_load_factor: 2.5,
        min_load_factor: 0.0,
        aerobatic: false,
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
        afterburner_thrust_n: 0.0,
        afterburner_detent: 0.0,
        thrust_reversers: true,
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
        auto_flaps: false,
        wave_drag_cd: 0.0,
        drag_rise_mach: 0.0,
        max_roll_rate: 15.0,
        max_pitch_rate: 5.0,
        max_yaw_rate: 4.0,
        response_time_s: 0.7,
        max_load_factor: 2.5,
        min_load_factor: 0.0,
        aerobatic: false,
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
        afterburner_thrust_n: 0.0,
        afterburner_detent: 0.0,
        thrust_reversers: true,
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
        auto_flaps: false,
        wave_drag_cd: 0.0,
        drag_rise_mach: 0.0,
        max_roll_rate: 35.0,
        max_pitch_rate: 9.0,
        max_yaw_rate: 6.0,
        response_time_s: 0.45,
        max_load_factor: 3.0,
        min_load_factor: 0.0,
        aerobatic: false,
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
        id: "longitude",
        name: "Longitude style",
        manufacturer_style: "Cessna-style super-midsize jet",
        category: "Business jet",
        description: "Long-range super-midsize twin with a T-tail. Cruises near Mach 0.84 (about 480 kt true) at FL410 and handles like a lighter jet.",
        mass_kg: 15_500.0,
        wing_area_m2: 49.9,
        wingspan_m: 21.0,
        length_m: 22.3,
        gear_height_m: 1.65,
        belly_height_m: 0.8,
        wheelbase_m: 9.2,
        retractable_gear: true,
        rest_pitch_deg: 0.5,
        tailstrike_pitch_deg: 12.5,
        engine: EngineKind::Jet,
        engine_count: 2,
        max_thrust_n: 2.0 * 34_000.0,
        spool_time_s: 3.2,
        idle_thrust: 0.04,
        prop_power_w: 0.0,
        afterburner_thrust_n: 0.0,
        afterburner_detent: 0.0,
        thrust_reversers: true,
        cd0: 0.019,
        oswald: 0.83,
        cl0: 0.2,
        cl_alpha: 5.4,
        alpha_stall_deg: 16.0,
        flap_cl: 0.70,
        flap_cd: 0.065,
        gear_cd: 0.02,
        spoiler_cd: 0.05,
        spoiler_cl: -0.4,
        flap_detents: LONGITUDE_FLAPS,
        auto_flaps: false,
        wave_drag_cd: 0.0,
        drag_rise_mach: 0.0,
        max_roll_rate: 30.0,
        max_pitch_rate: 8.0,
        max_yaw_rate: 5.5,
        response_time_s: 0.5,
        max_load_factor: 2.8,
        min_load_factor: 0.0,
        aerobatic: false,
        full_authority_q: 4_800.0,
        // 250 KIAS at FL410 is roughly Mach 0.84.
        v_rotate_kt: 120.0,
        v_approach_kt: 118.0,
        v_cruise_kt: 250.0,
        v_max_kt: 325.0,
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
        afterburner_thrust_n: 0.0,
        afterburner_detent: 0.0,
        thrust_reversers: false,
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
        auto_flaps: false,
        wave_drag_cd: 0.0,
        drag_rise_mach: 0.0,
        max_roll_rate: 45.0,
        max_pitch_rate: 18.0,
        max_yaw_rate: 12.0,
        response_time_s: 0.25,
        max_load_factor: 3.8,
        min_load_factor: 0.0,
        aerobatic: false,
        full_authority_q: 1_100.0,
        v_rotate_kt: 55.0,
        v_approach_kt: 65.0,
        v_cruise_kt: 115.0,
        v_max_kt: 160.0,
        cruise_alt_ft: 5_500.0,
        max_alt_ft: 14_000.0,
        service_ceiling_note: "14,000 ft",
    },
    AircraftSpec {
        // F-16C Block 50 class: F110-GE-129 (76.3 kN dry / 131 kN with
        // afterburner), 27.87 m² wing, clean with half internal fuel and
        // wingtip rails. Thrust lapse comes from tabulated engine data
        // (see `engine.rs`), drag from a measured-shape transonic rise.
        id: "f16",
        name: "F-16C style",
        manufacturer_style: "US single-engine multirole fighter",
        category: "Fighter jet",
        description: "Fly-by-wire fighter: 9 g, 280°/s rolls, no bank limits and Mach 2 at altitude. Push the throttle past 80 % to light the afterburner.",
        mass_kg: 11_500.0,
        wing_area_m2: 27.87,
        wingspan_m: 9.96,
        length_m: 15.06,
        gear_height_m: 1.9,
        belly_height_m: 1.1,
        wheelbase_m: 4.0,
        retractable_gear: true,
        rest_pitch_deg: 0.3,
        tailstrike_pitch_deg: 14.0,
        engine: EngineKind::Jet,
        engine_count: 1,
        max_thrust_n: 76_300.0,
        spool_time_s: 4.0,
        idle_thrust: 0.06,
        prop_power_w: 0.0,
        afterburner_thrust_n: 131_000.0,
        afterburner_detent: 0.8,
        thrust_reversers: false,
        cd0: 0.019,
        oswald: 0.80,
        cl0: 0.05,
        cl_alpha: 3.5,
        // The flight control computer limits AoA a few degrees below this (~25°).
        alpha_stall_deg: 29.0,
        flap_cl: 0.35,
        flap_cd: 0.03,
        gear_cd: 0.016,
        spoiler_cd: 0.05,
        spoiler_cl: 0.0,
        flap_detents: FIGHTER_FLAPS,
        auto_flaps: true,
        wave_drag_cd: 0.026,
        drag_rise_mach: 0.85,
        max_roll_rate: 280.0,
        max_pitch_rate: 20.0,
        max_yaw_rate: 12.0,
        response_time_s: 0.18,
        max_load_factor: 9.0,
        min_load_factor: -3.0,
        aerobatic: true,
        full_authority_q: 3_500.0,
        v_rotate_kt: 145.0,
        v_approach_kt: 145.0,
        v_cruise_kt: 350.0,
        // 800 KCAS placard (about Mach 1.2 at sea level).
        v_max_kt: 800.0,
        cruise_alt_ft: 30_000.0,
        max_alt_ft: 50_000.0,
        service_ceiling_note: "50,000 ft",
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
