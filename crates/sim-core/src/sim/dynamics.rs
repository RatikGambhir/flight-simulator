//! Flight dynamics for one physics substep, including systems and runway contact.

use glam::{DQuat, DVec3};

use crate::aircraft::EngineKind;
use crate::atmosphere::{isa, G0};
use crate::autopilot::ApOutput;
use crate::engine;
use crate::geo::{ecef_to_geodetic, EnuFrame, KT_TO_MS};
use crate::protocol::SimEvent;
use crate::world;

use super::{approach, attitude_from_hpr, hpr_from_attitude, nosewheel_limit, Simulation, MS_TO_FPM};

#[inline]
fn smoothstep(x: f64) -> f64 {
    let t = x.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

impl Simulation {
    fn apply_autopilot_config(&mut self, ap: &ApOutput) {
        let s = self.spec;
        if let Some(down) = ap.gear_down {
            if s.retractable_gear && (down || !self.on_ground) {
                self.gear_cmd_down = down;
            }
        }
        if let Some(i) = ap.flaps_index {
            if !s.auto_flaps {
                self.flaps_index = i.min(s.flap_detents.len() - 1);
            }
        }
        if let Some(b) = ap.speedbrake {
            if s.spoiler_cd > 0.0 {
                self.spoilers_cmd = b;
            }
        }
        if let Some(b) = ap.parking_brake {
            self.parking_brake = b;
        }
    }

    /// Wheel brake in use: the parking brake, the pilot's pedals or the autobrake.
    pub(super) fn wheel_brake(&self) -> f64 {
        if self.parking_brake { 1.0 } else { self.input.brake.max(self.ap_out.brake.unwrap_or(0.0)) }
    }

    fn update_systems(&mut self, dt: f64, ap_throttle: Option<f64>) {
        let s = self.spec;
        match ap_throttle {
            // The autothrottle works in the dry range; afterburner is the pilot's call.
            Some(t) if s.afterburner_detent > 0.0 => self.lever = t.min(s.afterburner_detent),
            Some(t) => self.lever = t,
            None => self.lever = (self.lever + self.input.throttle_rate * 0.6 * dt).clamp(0.0, 1.0),
        }
        // Thrust reversers (jets): deploy on the ground with the levers at idle while
        // reverse is held; the engines only spool up once the sleeves are open, and
        // the sleeves only stow once the engines are back near idle.
        let reverse = self.ap_out.reverse.unwrap_or(self.input.reverse);
        let want_rev = s.engine == EngineKind::Jet && s.thrust_reversers && self.on_ground && reverse > 0.5 && self.lever < 0.05;
        let rev_target = if want_rev {
            1.0
        } else if self.engine > 0.12 {
            // Hold the sleeves where they are until the engines spool down.
            self.reverser
        } else {
            0.0
        };
        self.reverser = approach(self.reverser, rev_target, dt / 1.6);
        let n1_target = if want_rev && self.reverser > 0.95 {
            0.72
        } else if self.reverser > 0.0 {
            0.0
        } else {
            self.lever
        };
        // Turbofans accelerate slowly from idle and quickly near the top of the range.
        let spool_tau = (s.spool_time_s / 3.0).max(0.05);
        let tau = if n1_target > self.engine { spool_tau * (1.5 - self.engine) } else { spool_tau * 0.8 };
        self.engine += (n1_target - self.engine) * (dt / tau).min(1.0);

        if s.retractable_gear {
            self.gear = approach(self.gear, if self.gear_cmd_down { 1.0 } else { 0.0 }, dt / 6.0);
        } else {
            self.gear = 1.0;
        }
        if s.auto_flaps {
            self.flaps_index = if self.gear_cmd_down { s.flap_detents.len() - 1 } else { 0 };
        }
        let flap_target = self.flaps_index as f64 / (s.flap_detents.len() - 1).max(1) as f64;
        // Fighter flaperons are fast-acting hydraulic surfaces.
        self.flaps = approach(self.flaps, flap_target, dt * if s.auto_flaps { 0.5 } else { 0.12 });

        let ground_spoilers = self.on_ground && self.lever < 0.08 && self.d.gs > 30.0 * KT_TO_MS && s.spoiler_cd > 0.0;
        let sp_target = if self.spoilers_cmd || ground_spoilers { 1.0 } else { 0.0 };
        self.spoilers = approach(self.spoilers, sp_target, dt * 1.5);
    }

    fn update_controls(&mut self, dt: f64) -> ApOutput {
        if let Some(why) = self.autopilot.pilot_override(&self.input, self.on_ground) {
            self.autopilot.disengage(Some(why));
        }
        let ap_inp = self.ap_inputs();
        let ap = self.autopilot.update(&ap_inp, self.spec, dt);
        self.apply_autopilot_config(&ap);
        self.ap_out = ap;
        self.update_systems(dt, ap.throttle);

        // Control surfaces follow inputs with a short lag (also drives animation).
        let roll_in = ap.roll_stick.unwrap_or(self.input.roll);
        let pitch_in = ap.pitch_stick.unwrap_or(self.input.pitch);
        let target = DVec3::new(roll_in, pitch_in, self.input.yaw);
        self.surfaces += (target - self.surfaces) * (dt * 7.0).min(1.0);
        ap
    }

    pub(super) fn integrate(&mut self, dt: f64) {
        let s = self.spec;
        let geo0 = ecef_to_geodetic(self.pos);
        let enu = EnuFrame::at(geo0.lat, geo0.lon);
        let up = enu.up;
        let geoid = world::geoid_undulation(geo0.lat_deg(), geo0.lon_deg());
        let air = isa(geo0.height - geoid);
        let rho = air.density;
        let mass = s.mass_kg;
        let area = s.wing_area_m2;

        // ---- Air mass ----------------------------------------------------
        // Aerodynamics see the velocity relative to the (moving, gusty) air.
        let h_above_ground = (geo0.height - self.ground_height_at(geo0.lat_deg(), geo0.lon_deg())).max(0.0);
        self.weather.step(dt, self.d.tas, h_above_ground, s.wingspan_m);
        let wind = enu.to_ecef(self.weather.wind_enu(h_above_ground));
        let v = self.vel - wind;
        let speed = v.length();
        let (xb, yb, zb) = (self.att * DVec3::X, self.att * DVec3::Y, self.att * DVec3::Z);
        let vb = self.att.conjugate() * v;
        let (alpha, beta) = if speed > 0.5 { ((-vb.z).atan2(vb.x), (vb.y / speed).clamp(-1.0, 1.0)) } else { (0.0, 0.0) };
        let qbar = 0.5 * rho * speed * speed;
        let eff = (qbar / s.full_authority_q).clamp(0.0, 1.0);
        let mach = speed / air.speed_of_sound;
        let (_heading, pitch, roll) = hpr_from_attitude(&enu, self.att);
        let airborne = !self.on_ground;

        // The autopilot reads the same flight values a pilot sees and makes the
        // same demands (stick, throttle, brakes, steering, gear, flaps).
        let ap = self.update_controls(dt);

        // ---- Aerodynamics ------------------------------------------------
        let flap = self.flaps;
        let spoil = self.spoilers;
        // Ground effect (McCormick): within about one span of the surface the
        // wingtip vortices are suppressed, cutting induced drag and adding lift.
        let wing_h = (h_above_ground - self.contact_height() * 0.6).max(0.05);
        let r = 16.0 * wing_h / s.wingspan_m;
        let phi = (r * r) / (1.0 + r * r);
        self.ground_effect = 1.0 - phi;
        let cl_alpha = s.cl_alpha * (1.0 + 0.12 * self.ground_effect);
        let alpha_stall = s.alpha_stall_deg.to_radians() - flap * 2f64.to_radians();
        let cl_base = s.cl0 + s.flap_cl * flap + s.spoiler_cl * spoil;
        let cl_lin = |a: f64| cl_base + cl_alpha * a;
        let (cl, post_stall) = if alpha > alpha_stall {
            let x = (alpha - alpha_stall) / 0.15;
            (cl_lin(alpha_stall) * (1.0 - 0.45 * smoothstep(x)), alpha - alpha_stall)
        } else if alpha < -alpha_stall {
            let x = (-alpha - alpha_stall) / 0.15;
            (cl_lin(-alpha_stall) * (1.0 - 0.45 * smoothstep(x)), -alpha - alpha_stall)
        } else {
            (cl_lin(alpha), 0.0)
        };
        let k_induced = if s.wave_drag_cd > 0.0 { s.induced_k() * engine::induced_drag_factor(mach) } else { s.induced_k() };
        let cd = s.cd0
            + engine::wave_drag(s.wave_drag_cd, s.drag_rise_mach, mach)
            + k_induced * phi * cl * cl
            + s.gear_cd * self.gear
            + s.flap_cd * flap
            + s.spoiler_cd * spoil
            + post_stall * 1.2;
        let vhat = if speed > 0.5 { v / speed } else { xb };
        let lift_dir = vhat.cross(yb).try_normalize().unwrap_or(zb);
        let mut force = (lift_dir * cl - vhat * cd) * (qbar * area);
        force -= yb * (beta * qbar * area * 0.9);
        // Reversers redirect the fan stream forward (about 45 % of forward thrust).
        let thrust = self.thrust_at(self.engine, speed, rho, mach, geo0.height - geoid) * (1.0 - 1.45 * self.reverser);
        force += xb * thrust;
        let accel_aero = force / mass;
        let accel = accel_aero - up * G0;

        let was_stalled = self.stall;
        self.stall = airborne && speed > 15.0 && alpha > alpha_stall;
        if self.stall && !was_stalled {
            self.events.push(SimEvent::Stall);
        }

        // ---- Control law: desired body rates ---------------------------
        let p_max = s.max_roll_rate.to_radians();
        let q_max = s.max_pitch_rate.to_radians();
        let r_max = s.max_yaw_rate.to_radians();
        let tau = s.response_time_s;
        let assisted = self.assist || self.autopilot.engaged;
        let q_path = if speed > 5.0 { accel.dot(lift_dir) / speed } else { 0.0 };
        let flying_speed = speed > 0.55 * s.v_rotate_kt * KT_TO_MS;

        // Roll
        let mut p_des = self.surfaces.x * p_max * eff;
        // Full-envelope fly-by-wire (fighters): the stick commands roll rate and
        // neutral stick holds whatever bank the pilot left, upright or inverted.
        if assisted && airborne && !self.autopilot.engaged && !s.aerobatic {
            let bank_hold = 35f64.to_radians();
            let bank_max = 67f64.to_radians();
            if self.input.roll.abs() < 0.05 {
                if roll.abs() > bank_hold {
                    p_des = -(roll - bank_hold.copysign(roll)) * 0.6;
                } else if roll.abs() < 4f64.to_radians() {
                    p_des = -roll * 0.5;
                }
            }
            if roll > bank_max && p_des > 0.0 || roll < -bank_max && p_des < 0.0 {
                p_des = -(roll - bank_max.copysign(roll)) * 2.0;
            }
        }
        if assisted && airborne && !self.autopilot.engaged && s.aerobatic {
            // Attitude hold: with the stick centred, keep the bank the pilot set
            // (including inverted). Bank is meaningless near the vertical, so the
            // hold only engages once the nose is within 60° of the horizon.
            if self.input.roll.abs() >= 0.05 || pitch.abs() > 60f64.to_radians() {
                self.bank_ref = None;
            } else if self.bank_ref.is_none() && self.surfaces.x.abs() < 0.05 && self.omega.x.abs() < 0.35 {
                self.bank_ref = Some(roll);
            }
            if let Some(br) = self.bank_ref {
                let err = (roll - br + std::f64::consts::PI).rem_euclid(std::f64::consts::TAU) - std::f64::consts::PI;
                p_des = (-err * 1.5).clamp(-0.5, 0.5);
            }
        } else {
            self.bank_ref = None;
        }
        if !assisted && airborne {
            // Dihedral effect: sideslip toward the low wing rolls the aircraft level.
            p_des += -beta * 1.5 * eff;
        }
        if self.stall && !assisted {
            p_des += (self.time * 2.3).sin() * 0.25;
        }

        // Pitch
        let q_des = if airborne && flying_speed {
            // Path hold uses the inertial flight path so gusts don't drag the reference around.
            let gamma = self.vel.try_normalize().map_or(0.0, |vi| vi.dot(up).clamp(-1.0, 1.0).asin());
            if assisted {
                // Load factor that holds the flight path at this bank: 1/cos(bank).
                // Airliners stay within ±67° of bank; aerobatic aircraft may be
                // inverted (negative g holds the path) and fade to zero g through
                // knife-edge, where the wing cannot hold the path at all.
                let bank_gain = if s.aerobatic {
                    let c = roll.cos();
                    c / (c * c).max(0.35 * 0.35)
                } else {
                    1.0 / roll.cos().max(0.35)
                };
                let stick = self.surfaces.y;
                let stick_active = self.input.pitch.abs() >= 0.05;
                // Flight-path hold: remember the path angle when the stick is released.
                if stick_active || ap.load_factor.is_some() {
                    self.gamma_ref = None;
                } else if self.gamma_ref.is_none() && stick.abs() < 0.05 {
                    self.gamma_ref = Some(gamma);
                }
                let mut n_neutral = gamma.cos() * bank_gain;
                if let Some(gr) = self.gamma_ref {
                    let corr = ((gr - gamma) * speed / G0 * 0.35).clamp(-0.3, 0.3);
                    n_neutral += if s.aerobatic { corr * bank_gain.clamp(-1.5, 1.5) } else { corr };
                }
                let n_neutral = n_neutral.clamp(s.min_load_factor, s.max_load_factor);
                let n_cmd = match ap.load_factor {
                    Some(n) if !stick_active => n,
                    _ => {
                        if stick >= 0.0 {
                            n_neutral + stick * (s.max_load_factor - n_neutral).max(0.0)
                        } else {
                            n_neutral + stick * (n_neutral - s.min_load_factor).max(0.0)
                        }
                    }
                };
                // Lift needed, net of the thrust component normal to the flight path.
                let lift_needed = n_cmd * mass * G0 - thrust * alpha.sin();
                let cl_needed = lift_needed / (qbar * area).max(1.0);
                let alpha_min = if s.aerobatic { -12f64 } else { -6f64 }.to_radians();
                let alpha_cmd = ((cl_needed - cl_base) / s.cl_alpha).clamp(alpha_min, alpha_stall - 3f64.to_radians());
                self.alpha_trim = alpha;
                (q_path + (alpha_cmd - alpha) * (1.6 / tau)).clamp(-q_max * 1.5, q_max * 1.5)
            } else {
                // Auto-trim slowly toward the angle of attack the pilot is holding.
                let st = self.surfaces.y;
                if st.abs() > 0.05 {
                    self.alpha_trim += (alpha - self.alpha_trim) * (dt * 0.15).min(1.0);
                }
                let alpha_cmd = if st >= 0.0 {
                    self.alpha_trim + st * (alpha_stall + 4f64.to_radians() - self.alpha_trim)
                } else {
                    self.alpha_trim + st * (self.alpha_trim + 8f64.to_radians())
                };
                let mut q = q_path * 0.9 + (alpha_cmd - alpha) * (1.2 / tau) * eff.max(0.3);
                if self.stall {
                    q -= post_stall * 3.0;
                }
                q.clamp(-q_max * 1.5, q_max * 1.5)
            }
        } else if airborne {
            self.surfaces.y * q_max * eff + q_path * 0.8
        } else {
            // On the ground: elevator authority vs. weight on the nose gear.
            let lift_ratio = ((accel_aero.dot(up)) / G0).clamp(0.0, 1.0);
            let settle = -(pitch - s.rest_pitch_deg.to_radians()) * 0.8 * (1.0 - lift_ratio) * (1.0 - self.surfaces.y.abs());
            self.surfaces.y * q_max * eff * 1.4 + settle
        };

        // Yaw: rudder + weathervane stability + automatic turn coordination.
        let mut r_des = self.surfaces.z * r_max * eff - beta * 2.5 * eff.max(0.2);
        if assisted && airborne && speed > 20.0 {
            if s.aerobatic {
                // Cancel the sideways pull of gravity at any attitude.
                r_des += G0 * roll.sin() * pitch.cos() / speed;
            } else {
                let turn_rate = G0 * roll.clamp(-1.3, 1.3).tan() / speed;
                r_des += turn_rate * roll.cos();
            }
        }

        let omega_des = DVec3::new(p_des, -q_des, -r_des);
        self.omega += (omega_des - self.omega) * (dt / tau).min(1.0);
        if airborne {
            // Rotational gusts nudge the airframe; the control law then works against them.
            let g = self.weather.rotational_gust();
            self.omega += DVec3::new(g.x, -g.y, -g.z) * (dt / tau).min(1.0);
        }

        // ---- Integrate ---------------------------------------------------
        self.vel += accel * dt;
        self.pos += self.vel * dt;
        self.att = (self.att * DQuat::from_scaled_axis(self.omega * dt)).normalize();

        self.resolve_ground(dt, accel, mass);
    }

    fn resolve_ground(&mut self, dt: f64, accel: DVec3, mass: f64) {
        let s = self.spec;
        let g = ecef_to_geodetic(self.pos);
        let enu = EnuFrame::at(g.lat, g.lon);
        let up = enu.up;
        let ground_h = self.ground_height_at(g.lat_deg(), g.lon_deg());
        let contact_h = self.contact_height();
        let clearance = g.height - ground_h - contact_h;
        let v_up = self.vel.dot(up);
        let speed = self.vel.length();

        // While rolling on the ground and the wings are not yet carrying the
        // weight, follow the terrain down (e.g. when streamed scenery refines
        // to a slightly lower surface) instead of dropping onto it.
        let lift_ratio = (accel.dot(up) + G0) / G0;
        let sticky = self.on_ground && lift_ratio < 0.95 && v_up < 1.0;
        let touching = clearance <= 0.0 || (self.on_ground && clearance < 0.5 && v_up < 1.0) || (sticky && clearance < 60.0);
        if !touching {
            if self.on_ground && clearance > 0.3 {
                self.on_ground = false;
                self.events.push(SimEvent::Liftoff);
            }
            return;
        }

        let (heading, pitch, roll) = hpr_from_attitude(&enu, self.att);
        if !self.on_ground {
            let fpm = v_up * MS_TO_FPM;
            let crash_reason = if clearance < -12.0 && speed > 15.0 {
                Some("Collided with terrain or a structure")
            } else if v_up < -7.6 {
                Some("Impact was too hard")
            } else if roll.abs() > 25f64.to_radians() {
                Some("Wingtip struck the ground")
            } else if pitch < -10f64.to_radians() {
                Some("Nose-first impact")
            } else if self.gear < 0.95 && v_up < -3.0 {
                Some("Gear-up impact")
            } else {
                None
            };
            if let Some(reason) = crash_reason {
                self.crashed = true;
                self.vel = DVec3::ZERO;
                self.omega = DVec3::ZERO;
                self.pos += up * (-clearance.max(-50.0));
                self.autopilot.disengage(None);
                self.events.push(SimEvent::Crashed { reason: reason.into() });
                return;
            }
            self.last_touchdown_fpm = fpm;
            let rating = match -fpm {
                x if x < 120.0 => "Butter!",
                x if x < 300.0 => "Smooth",
                x if x < 600.0 => "Firm",
                _ => "Hard",
            };
            self.events.push(SimEvent::Touchdown { vertical_speed_fpm: fpm, rating: rating.into() });
            if self.gear < 0.95 {
                self.message("Belly landing!");
            }
            self.autopilot.on_touchdown();
        }
        self.on_ground = true;

        // Snap to the surface and remove downward velocity.
        self.pos += up * (-clearance);
        if v_up < 0.0 {
            self.vel -= up * v_up;
        }

        // Wheel / belly friction.
        let normal_acc = (-(accel.dot(up))).max(0.0);
        let normal_force = mass * normal_acc;
        let xb = self.att * DVec3::X;
        let fwd_h = (xb - up * xb.dot(up)).try_normalize().unwrap_or(enu.north);
        let side_h = up.cross(fwd_h);
        let vh = self.vel - up * self.vel.dot(up);
        let mut vf = vh.dot(fwd_h);
        let mut vs = vh.dot(side_h);
        if self.gear > 0.95 {
            let brake = self.wheel_brake();
            // Rolling resistance plus anti-skid braking (max ~0.4 g on a dry runway).
            let mu = 0.015 + 0.42 * brake;
            vf = approach(vf, 0.0, mu * normal_force / mass * dt);
            vs *= (-dt * 10.0).exp();
        } else {
            let decel = 0.45 * normal_force / mass * dt;
            vf = approach(vf, 0.0, decel);
            vs = approach(vs, 0.0, decel);
        }
        self.vel = fwd_h * vf + side_h * vs + up * self.vel.dot(up).max(0.0);

        // Steering, wheels-level roll and pitch limits.
        let steer_in = match self.ap_out.steer {
            Some(steer) => steer,
            None if self.input.yaw.abs() > 0.05 => self.input.yaw,
            None => self.input.roll * 0.6,
        };
        let max_steer = nosewheel_limit(vf);
        let steer_rate = if self.gear > 0.95 { vf * (steer_in * max_steer).tan() / s.wheelbase_m } else { 0.0 };
        let new_heading = heading + steer_rate * dt;
        let new_roll = roll * (-dt * 8.0).exp();
        let rest = s.rest_pitch_deg.to_radians();
        let strike = s.tailstrike_pitch_deg.to_radians();
        self.tailstrike = pitch > strike;
        let new_pitch = pitch.clamp(rest.min(pitch.max(rest - 0.02)), strike);
        let new_pitch = new_pitch.max(rest);
        self.att = attitude_from_hpr(&enu, new_heading, new_pitch, new_roll);
        self.omega.x = 0.0;
        self.omega.z = -steer_rate;
        if new_pitch <= rest && self.omega.y > 0.0 {
            self.omega.y = 0.0;
        }
    }
}
