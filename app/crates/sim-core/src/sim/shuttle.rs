//! Isolated Endeavour mission: a condensed guided ascent, then Newtonian free flight.
//! Orbital integration uses SI units in an inertial frame, rotated back to ECEF each step.
//! The ISS is an ideal circular mission target, not a live ephemeris.

use glam::{DMat3, DQuat, DVec3};

use super::{attitude_from_hpr, approach, Simulation};
use crate::atmosphere::G0;
use crate::autopilot::{nav::choose_landing_runway, NavTarget, Perf, Wind};
use crate::protocol::RunwaySpawnKind;
use super::AutopilotResume;
use crate::geo::{geodetic_to_ecef, EnuFrame, WGS84_A};
use crate::protocol::{snap, ShuttleSite, SimCommand, SimEvent};

const MU: f64 = 3.986_004_418e14;
const EARTH_RATE: f64 = 7.292_115e-5;
const ORBIT_RADIUS: f64 = WGS84_A + 420_000.0;
const ASCENT_SECONDS: f64 = 510.0;
const BOOSTER_SECONDS: f64 = 125.0;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase { Pad, Boost, Ascent, Attached, Free }

impl Phase {
    fn code(self) -> f64 {
        match self { Self::Pad => 1.0, Self::Boost => 2.0, Self::Ascent => 3.0, Self::Attached => 4.0, Self::Free => 5.0 }
    }
}

pub(super) struct ShuttleMission {
    site: ShuttleSite,
    pad_height: f64,
    phase: Phase,
    elapsed: f64,
    booster_sep: f64,
    tank_sep: f64,
    radial: DVec3,
    tangent: DVec3,
    start_radius: f64,
}

fn earth_spin() -> DVec3 { DVec3::Z * EARTH_RATE }
fn gravity(pos: DVec3) -> DVec3 { -pos * (MU / pos.length().powi(3)) }
fn mean_motion() -> f64 { (MU / ORBIT_RADIUS.powi(3)).sqrt() }

/// Velocity Verlet in inertial axes. ECEF velocity is ground-relative, so both
/// the rotational velocity and the rotation of the axes must be accounted for.
fn coast(pos: &mut DVec3, vel: &mut DVec3, thrust: DVec3, dt: f64) {
    let inertial_vel = *vel + earth_spin().cross(*pos);
    let first = gravity(*pos) + thrust;
    let next_pos = *pos + inertial_vel * dt + first * (0.5 * dt * dt);
    let next_vel = inertial_vel + (first + gravity(next_pos) + thrust) * (0.5 * dt);
    let rotation = DQuat::from_rotation_z(-EARTH_RATE * dt);
    *pos = rotation * next_pos;
    *vel = rotation * next_vel - earth_spin().cross(*pos);
}

impl ShuttleMission {
    fn new(site: ShuttleSite, pad_height: f64) -> Self {
        let (lat, lon) = site.coordinates();
        let start = geodetic_to_ecef(lat.to_radians(), lon.to_radians(), pad_height + 21.0);
        let radial = start.normalize();
        let enu = EnuFrame::at(lat.to_radians(), lon.to_radians());
        // A prograde 51.6-degree orbit through the departure's geocentric latitude.
        let east = 51.6_f64.to_radians().cos() / (1.0 - radial.z * radial.z).sqrt();
        let north = (DVec3::Z - radial * radial.z).normalize();
        let tangent = enu.east * east + north * (1.0 - east * east).sqrt();
        Self { site, pad_height, phase: Phase::Pad, elapsed: 0.0, booster_sep: -1.0, tank_sep: -1.0,
            radial, tangent, start_radius: start.length() }
    }

    /// Smooth guided reference: vertical liftoff, pitch-over, orbital insertion.
    /// This condenses the ascent and OMS transfer into 8.5 simulated minutes.
    fn ascent(&self, seconds: f64) -> (DVec3, DVec3) {
        let seconds = seconds.clamp(0.0, ASCENT_SECONDS);
        let u = seconds / ASCENT_SECONDS;
        let smooth = u * u * (3.0 - 2.0 * u);
        let radius = self.start_radius + (ORBIT_RADIUS - self.start_radius) * smooth;
        let dr = (ORBIT_RADIUS - self.start_radius) * 6.0 * u * (1.0 - u) / ASCENT_SECONDS;
        let theta = mean_motion() * ASCENT_SECONDS * (u.powi(3) - 0.5 * u.powi(4));
        let (s, c) = theta.sin_cos();
        let radial = self.radial * c + self.tangent * s;
        let tangent = self.tangent * c - self.radial * s;
        let inertial_pos = radial * radius;
        let inertial_vel = radial * dr + tangent * (radius * mean_motion() * smooth);
        // Begin at rest on the rotating pad, then converge to the mission's inertial plane.
        let compensation = EARTH_RATE * seconds * (1.0 - u).powi(3);
        let compensation_rate = EARTH_RATE * (1.0 - u).powi(2) * (1.0 - 4.0 * u);
        let inertial_vel = inertial_vel + (DVec3::Z * compensation_rate).cross(inertial_pos);
        let rotation = DQuat::from_rotation_z(compensation - EARTH_RATE * seconds);
        let pos = rotation * inertial_pos;
        (pos, rotation * inertial_vel - earth_spin().cross(pos))
    }

    fn iss(&self) -> DVec3 {
        // 600 m ahead at insertion; continues in its own orbit after pilot manoeuvres.
        let theta = mean_motion() * (self.elapsed - ASCENT_SECONDS * 0.5) + 600.0 / ORBIT_RADIUS;
        let (s, c) = theta.sin_cos();
        DQuat::from_rotation_z(-EARTH_RATE * self.elapsed)
            * (self.radial * c + self.tangent * s) * ORBIT_RADIUS
    }
}

impl Simulation {
    pub(super) fn spawn_shuttle(&mut self, orbit: bool, site: ShuttleSite) {
        if self.spec.id != "endeavour" { return; }
        self.reset_dynamic_state();
        self.awaiting = None;
        self.ground_fallback = site.fallback_height();
        self.gear = 0.0;
        self.gear_cmd_down = false;
        self.flaps = 0.0;
        self.flaps_index = 0;
        self.lever = 0.0;
        self.engine = 0.0;
        let mut mission = ShuttleMission::new(site, site.fallback_height());
        if orbit {
            mission.elapsed = ASCENT_SECONDS;
            mission.phase = Phase::Free;
            mission.booster_sep = BOOSTER_SECONDS;
            mission.tank_sep = ASCENT_SECONDS - 30.0;
        }
        (self.pos, self.vel) = mission.ascent(mission.elapsed);
        self.on_ground = !orbit;
        let (lat, lon) = site.coordinates();
        let enu = EnuFrame::at(lat.to_radians(), lon.to_radians());
        self.att = attitude_from_hpr(&enu, 45_f64.to_radians(), 89.9_f64.to_radians(), 0.0);
        self.shuttle = Some(mission);
        self.last_spawn = Some(SimCommand::SpawnShuttle { orbit, site });
        self.update_derived();
        if orbit { self.align_shuttle_to_velocity(); }
        self.spec_force = if orbit { DVec3::ZERO } else { DVec3::X };
    }

    /// Refine a stationary pad against the same ellipsoid-height terrain used
    /// by ordinary flights. Never move the launch site after liftoff.
    pub(super) fn ground_shuttle_pad(&mut self, height: f64) {
        let Some(m) = &self.shuttle else { return; };
        if m.phase != Phase::Pad || !(-500.0..2000.0).contains(&height) { return; }
        let mission = ShuttleMission::new(m.site, height);
        (self.pos, self.vel) = mission.ascent(0.0);
        self.shuttle = Some(mission);
        self.ground_fallback = height;
        self.update_derived();
    }

    pub(super) fn land_shuttle(&mut self, airport: &str, runway: Option<String>) {
        if self.spec.id != "endeavour" || self.crashed { return; }
        if self.shuttle.as_ref().is_some_and(|m| m.phase != Phase::Free) {
            self.message("Reach orbit and release the external tank before returning to a runway");
            return;
        }
        let Some(target) = NavTarget::lookup(airport, runway) else {
            self.message("Choose an airport with a runway for Endeavour's return");
            return;
        };
        let perf = Perf::from_spec(self.spec);
        let wind = Wind { from_deg: self.weather.settings.wind_from_deg, speed_kt: self.weather.settings.wind_speed_ms * crate::geo::MS_TO_KT };
        let Some(runway) = choose_landing_runway(&target, &perf, wind, None) else { return; };
        if !runway.hard || runway.landing_length_m() < perf.required_landing_m {
            self.message(format!("Choose a paved runway at least {:.0} m long for Endeavour", perf.required_landing_m.ceil()));
            return;
        }
        // User-requested flight assist: skip re-entry and place a stable final.
        // From here the existing autopilot flies the forces, flare and wheel brakes.
        if self.spawn_runway(airport, Some(&runway.ident), RunwaySpawnKind::Approach) {
            let target = NavTarget::lookup(airport, Some(runway.ident));
            let inp = self.ap_inputs();
            self.autopilot.set_destination(target, &inp, self.spec);
            self.ap_resume = Some(AutopilotResume::Standard);
            self.message("Assisted return — re-entry skipped. Autopilot will fly the approach, land on wheels and brake to a stop.");
        }
    }

    pub(super) fn launch_shuttle(&mut self) {
        let Some(m) = self.shuttle.as_mut() else { return; };
        if m.phase != Phase::Pad || self.crashed || self.paused { return; }
        m.phase = Phase::Boost;
        self.on_ground = false;
        self.events.push(SimEvent::Liftoff);
        self.message("Endeavour liftoff — guided ascent. Boosters separate at T+2:05.");
    }

    pub(super) fn separate_shuttle(&mut self) {
        let Some(m) = self.shuttle.as_mut() else { return; };
        if self.paused || self.crashed { return; }
        if m.phase == Phase::Attached {
            m.phase = Phase::Free;
            m.tank_sep = m.elapsed;
            // A small spring push away from the external tank, no artificial orbital-speed jump.
            self.vel += self.att * DVec3::Z * 0.3;
            self.message("External tank released. Free flight: R/F thrust, W/S pitch, A/D roll, J/E yaw; X reverse RCS, U/O lateral, I/K vertical.");
        } else if m.phase != Phase::Free {
            self.message("Tank release is available after orbital insertion; boosters separate automatically.");
        }
    }

    fn align_shuttle_to_velocity(&mut self) {
        let fwd = (self.vel + earth_spin().cross(self.pos)).normalize_or_zero();
        let up = self.pos.normalize();
        let left = up.cross(fwd).normalize_or_zero();
        let up = fwd.cross(left).normalize_or_zero();
        self.att = DQuat::from_mat3(&DMat3::from_cols(fwd, left, up)).normalize();
    }

    pub(super) fn integrate_shuttle(&mut self, dt: f64) {
        let Some(mut m) = self.shuttle.take() else { return; };
        if m.phase == Phase::Pad {
            self.shuttle = Some(m);
            return;
        }
        let previous = self.vel;
        let old_pos = self.pos;
        m.elapsed += dt;
        if matches!(m.phase, Phase::Boost | Phase::Ascent) {
            if m.elapsed >= BOOSTER_SECONDS && m.phase == Phase::Boost {
                m.phase = Phase::Ascent;
                m.booster_sep = m.elapsed;
                self.message("Solid rocket boosters separated — main engines continue the ascent.");
            }
            (self.pos, self.vel) = m.ascent(m.elapsed);
            self.align_shuttle_to_velocity();
            // At liftoff the body points up, then follows the commanded ascent path.
            if m.elapsed < 60.0 {
                let enu = EnuFrame::at(self.d.lat.to_radians(), self.d.lon.to_radians());
                self.att = attitude_from_hpr(&enu, 45_f64.to_radians(), (90.0 - m.elapsed * 0.6).to_radians(), 0.0);
            }
            self.lever = 1.0;
            self.engine = 1.0;
            // Convert rotating-coordinate acceleration to inertial specific force.
            let inertial_accel = (self.vel - previous) / dt + 2.0 * earth_spin().cross(previous)
                + earth_spin().cross(earth_spin().cross(old_pos));
            self.spec_force = self.att.conjugate() * (inertial_accel - gravity(old_pos)) / G0;
            if m.elapsed >= ASCENT_SECONDS {
                // The final fixed step can straddle cutoff. Coast its remainder
                // so the orbiter and independent ISS keep the same time origin.
                let remainder = m.elapsed - ASCENT_SECONDS;
                coast(&mut self.pos, &mut self.vel, DVec3::ZERO, remainder);
                self.att = DQuat::from_rotation_z(-EARTH_RATE * remainder) * self.att;
                m.phase = Phase::Attached;
                self.lever = 0.0;
                self.engine = 0.0;
                self.spec_force = DVec3::ZERO;
                self.message("Orbital insertion complete. Press B or Release tank to begin free flight beside the ISS.");
            }
        } else {
            let free = m.phase == Phase::Free;
            self.gear = approach(self.gear, if self.gear_cmd_down { 1.0 } else { 0.0 }, dt / 6.0);
            self.lever = if free { (self.lever + self.input.throttle_rate * 0.6 * dt).clamp(0.0, 1.0) } else { 0.0 };
            self.engine = self.lever;
            let target = if free {
                DVec3::new(self.input.roll * 5_f64.to_radians(), -self.input.pitch * 3_f64.to_radians(), -self.input.yaw * 3_f64.to_radians())
            } else { DVec3::ZERO };
            // RCS attitude control with rate damping; no aerodynamic lift in vacuum.
            for axis in 0..3 { self.omega[axis] = approach(self.omega[axis], target[axis], dt * 0.07); }
            self.att = (self.att * DQuat::from_scaled_axis(self.omega * dt)).normalize();
            self.att = DQuat::from_rotation_z(-EARTH_RATE * dt) * self.att;
            let body_thrust = if free {
                DVec3::new(self.lever * 0.534 - self.input.reverse * 0.15, -self.input.strafe * 0.15, self.input.vertical * 0.15)
            } else { DVec3::ZERO };
            let thrust = self.att * body_thrust;
            coast(&mut self.pos, &mut self.vel, thrust, dt);
            self.spec_force = body_thrust / G0;
            // Honest boundary: atmospheric entry is outside this orbital mission.
            if self.pos.length() < WGS84_A + 80_000.0 {
                self.crashed = true;
                self.events.push(SimEvent::Crashed { reason: "Atmospheric re-entry — restart the orbital mission".into() });
            }
            if self.pos.distance(m.iss()) < 38.0 {
                self.crashed = true;
                self.events.push(SimEvent::Crashed { reason: "ISS safety boundary reached".into() });
            }
        }
        self.shuttle = Some(m);
    }

    pub(super) fn write_shuttle_snapshot(&self, out: &mut [f64]) {
        out[snap::SHUTTLE_PHASE..snap::LEN].fill(0.0);
        let Some(m) = &self.shuttle else {
            if self.spec.id == "endeavour" { out[snap::SHUTTLE_PHASE] = 6.0; }
            return;
        };
        let iss = m.iss();
        out[snap::SHUTTLE_PHASE] = m.phase.code();
        out[snap::MISSION_TIME] = m.elapsed;
        out[snap::BOOSTER_SEP_TIME] = m.booster_sep;
        out[snap::TANK_SEP_TIME] = m.tank_sep;
        out[snap::ISS_X] = iss.x;
        out[snap::ISS_Y] = iss.y;
        out[snap::ISS_Z] = iss.z;
        out[snap::ORBITAL_SPEED] = (self.vel + earth_spin().cross(self.pos)).length();
        out[snap::LOCAL_GRAVITY] = MU / self.pos.length_squared();
        out[snap::SHUTTLE_SITE] = m.site.code();
        out[snap::SHUTTLE_PAD_HEIGHT] = m.pad_height;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ControlInput;

    fn shuttle(orbit: bool) -> Simulation {
        let mut sim = Simulation::new();
        sim.command(SimCommand::SetAircraft { id: "endeavour".into() });
        sim.command(SimCommand::SpawnShuttle { orbit, site: ShuttleSite::Houston });
        sim.command(SimCommand::SetPaused { paused: false });
        sim
    }
    fn advance(sim: &mut Simulation, seconds: f64) {
        for _ in 0..(seconds * 120.0).round() as usize { sim.step(1.0 / 120.0); }
    }

    #[test]
    fn launch_sites_refine_real_ground_and_keep_the_mission_orbit() {
        for (site, lat, lon) in [
            (ShuttleSite::Houston, 29.5547, -95.0939),
            (ShuttleSite::Kennedy, 28.6084, -80.6043),
            (ShuttleSite::Tanegashima, 30.4009, 130.9773),
            (ShuttleSite::Sriharikota, 13.7199, 80.2304),
        ] {
            let mut sim = shuttle(false);
            sim.command(SimCommand::SpawnShuttle { orbit: false, site });
            sim.command(SimCommand::Ground { lat, lon, height: Some(37.25) });
            let s = sim.snapshot();
            assert!((s[snap::LAT] - lat).abs() < 1e-7);
            assert!((s[snap::LON] - lon).abs() < 1e-7);
            assert!((s[snap::HEIGHT] - 58.25).abs() < 1e-5, "stack follows streamed ellipsoid height");
            assert_eq!(s[snap::SHUTTLE_SITE], site.code());
            assert_eq!(s[snap::SHUTTLE_PAD_HEIGHT], 37.25);
            assert!(sim.vel.length() < 1e-8);
            sim.command(SimCommand::Ground { lat: 0.0, lon: 0.0, height: Some(800.0) });
            assert_eq!(sim.snapshot()[snap::SHUTTLE_PAD_HEIGHT], 37.25, "remote ground samples cannot move the pad");
            sim.command(SimCommand::LaunchShuttle);
            advance(&mut sim, 1.0);
            sim.command(SimCommand::Ground { lat, lon, height: Some(100.0) });
            assert_eq!(sim.snapshot()[snap::SHUTTLE_PAD_HEIGHT], 37.25, "terrain refinement cannot move a launched mission");
            advance(&mut sim, 510.0);
            assert_eq!(sim.snapshot()[snap::SHUTTLE_PHASE], 4.0);
            let m = sim.shuttle.as_ref().unwrap();
            let inclination = m.radial.cross(m.tangent).normalize().z.acos().to_degrees();
            assert!((inclination - 51.6).abs() < 1e-8);
            assert!((sim.pos.distance(m.iss()) - 600.0).abs() < 0.1);
            sim.command(SimCommand::Reset);
            assert_eq!(sim.snapshot()[snap::SHUTTLE_SITE], site.code(), "reset retains the selected launch site");
            assert!((sim.snapshot()[snap::LAT] - lat).abs() < 1e-7);
        }
        let default: SimCommand = serde_json::from_str(r#"{"type":"spawn_shuttle","orbit":false}"#).unwrap();
        assert!(matches!(default, SimCommand::SpawnShuttle { site: ShuttleSite::Houston, .. }));
    }

    #[test]
    fn shuttle_launch_stages_only_in_sequence_and_can_restart() {
        let mut sim = shuttle(false);
        assert!(sim.vel.length() < 1e-8, "stationary on the rotating launch pad");
        sim.command(SimCommand::SeparateShuttle);
        assert_eq!(sim.snapshot()[snap::SHUTTLE_PHASE], 1.0);
        sim.command(SimCommand::LaunchShuttle);
        advance(&mut sim, 126.0);
        let s = sim.snapshot();
        assert_eq!(s[snap::SHUTTLE_PHASE], 3.0);
        assert!(s[snap::BOOSTER_SEP_TIME] >= 125.0);
        assert!(s[snap::HEIGHT] > 50_000.0);
        sim.command(SimCommand::SeparateShuttle);
        assert_eq!(sim.snapshot()[snap::TANK_SEP_TIME], -1.0);
        advance(&mut sim, 385.0);
        assert_eq!(sim.snapshot()[snap::SHUTTLE_PHASE], 4.0);
        assert!((sim.pos.distance(sim.shuttle.as_ref().unwrap().iss()) - 600.0).abs() < 0.1);
        let before = sim.vel;
        sim.command(SimCommand::SeparateShuttle);
        assert_eq!(sim.snapshot()[snap::SHUTTLE_PHASE], 5.0);
        assert!((sim.vel - before).length() < 0.31);
        assert!(!sim.crashed);
        sim.command(SimCommand::Reset);
        assert_eq!(sim.snapshot()[snap::SHUTTLE_PHASE], 1.0);
    }

    #[test]
    fn shuttle_orbit_conserves_energy_and_feels_weightless_with_real_gravity() {
        let mut sim = shuttle(true);
        let energy = |s: &Simulation| 0.5 * (s.vel + earth_spin().cross(s.pos)).length_squared() - MU / s.pos.length();
        let initial = energy(&sim);
        advance(&mut sim, 5_580.0);
        let s = sim.snapshot();
        assert!(!sim.crashed);
        assert!((energy(&sim) / initial - 1.0).abs() < 1e-7);
        assert!((sim.pos.length() - ORBIT_RADIUS).abs() < 2.0);
        assert!((8.5..9.0).contains(&s[snap::LOCAL_GRAVITY]));
        assert!((7_600.0..7_750.0).contains(&s[snap::ORBITAL_SPEED]));
        assert!(sim.spec_force.length() < 1e-10);
        assert!((sim.pos.distance(sim.shuttle.as_ref().unwrap().iss()) - 600.0).abs() < 2.0);
    }

    #[test]
    fn shuttle_rcs_changes_attitude_and_velocity_and_pause_freezes_mission() {
        let mut sim = shuttle(true);
        let att = sim.att;
        sim.set_input(ControlInput { pitch: 1.0, strafe: 1.0, vertical: 1.0, ..ControlInput::default() });
        advance(&mut sim, 4.0);
        assert!(sim.att.dot(att).abs() < 0.999);
        assert!(sim.spec_force.length() > 0.01);
        sim.set_input(ControlInput::default());
        sim.command(SimCommand::ToggleGear);
        advance(&mut sim, 7.0);
        assert!(sim.gear > 0.99, "wheels can extend in orbital free flight");
        sim.command(SimCommand::ToggleGear);
        advance(&mut sim, 7.0);
        assert!(sim.gear < 0.01);
        let pos = sim.pos;
        let time = sim.snapshot()[snap::MISSION_TIME];
        sim.command(SimCommand::SetPaused { paused: true });
        advance(&mut sim, 10.0);
        assert_eq!(sim.pos, pos);
        assert_eq!(sim.snapshot()[snap::MISSION_TIME], time);
        sim.command(SimCommand::SetAircraft { id: "b737".into() });
        assert!(sim.shuttle.is_none());
        assert_eq!(sim.snapshot()[snap::SHUTTLE_PHASE], 0.0);
    }

    #[test]
    fn endeavour_returns_from_orbit_and_autolands_on_wheels() {
        for (airport, wind_kt) in [("KTTS", 0.0), ("KORD", 8.0), ("KEDW", 12.0)] {
            let mut sim = shuttle(true);
            sim.command(SimCommand::SetWeather(crate::protocol::WeatherRequest {
                wind_from_deg: 270.0, wind_speed_kt: wind_kt, turbulence: if wind_kt > 0.0 { 0.15 } else { 0.0 },
            }));
            sim.command(SimCommand::LandShuttle { airport: airport.into(), runway: None });
            assert!(sim.shuttle.is_none(), "{airport}: return switched to atmospheric dynamics");
            assert_eq!(sim.snapshot()[snap::SHUTTLE_PHASE], 6.0);
            let field = crate::world::db().airport(airport).unwrap().elevation_ft;
            let mut touchdown = false;
            for step in 0..120 * 600 {
                if step % 12 == 0 {
                    let lat = sim.d.lat;
                    let lon = sim.d.lon;
                    sim.command(SimCommand::Ground { lat, lon, height: Some(crate::world::msl_ft_to_ellipsoid_m(lat, lon, field)) });
                }
                sim.step(1.0 / 120.0);
                for event in sim.take_events() {
                    if let SimEvent::Touchdown { .. } = event { touchdown = true; }
                }
                assert!(!sim.crashed, "{airport}: crashed, IAS={} pitch={} roll={} AP={:?}", sim.d.ias_kt, sim.d.pitch.to_degrees(), sim.d.roll.to_degrees(), sim.autopilot.phase);
                if sim.autopilot.phase == crate::autopilot::Phase::Stopped { break; }
            }
            assert!(touchdown, "{airport}: no touchdown; IAS={} AGL={} AP={:?}", sim.d.ias_kt, sim.d.agl, sim.autopilot.phase);
            assert!(sim.on_ground && sim.d.gs < 1.0, "{airport}: must stop on the runway");
            assert!(sim.gear > 0.99, "{airport}: must land on extended wheels");
            assert_eq!(sim.autopilot.phase, crate::autopilot::Phase::Stopped);
            sim.command(SimCommand::Reset);
            assert!(sim.shuttle.is_some(), "restart returns to original departure");
        }
    }


    #[test]
    fn shuttle_return_rejects_early_release_unknown_airports_and_short_runways() {
        let mut sim = shuttle(false);
        sim.command(SimCommand::LandShuttle { airport: "KTTS".into(), runway: None });
        assert_eq!(sim.snapshot()[snap::SHUTTLE_PHASE], 1.0);
        sim = shuttle(true);
        let pos = sim.pos;
        for airport in ["not-an-airport", "KMDW"] {
            sim.command(SimCommand::LandShuttle { airport: airport.into(), runway: None });
            assert_eq!(sim.pos, pos);
            assert_eq!(sim.snapshot()[snap::SHUTTLE_PHASE], 5.0);
        }
    }

}
