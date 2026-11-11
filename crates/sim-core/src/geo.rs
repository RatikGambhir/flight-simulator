//! WGS84 geodesy: geodetic <-> ECEF conversion, local tangent frames and
//! great-circle helpers. All angles are radians unless a name says `_deg`.

use glam::{DMat3, DVec3};
use serde::{Deserialize, Serialize};

/// WGS84 semi-major axis (m).
pub const WGS84_A: f64 = 6_378_137.0;
/// WGS84 flattening.
pub const WGS84_F: f64 = 1.0 / 298.257_223_563;
/// WGS84 semi-minor axis (m).
pub const WGS84_B: f64 = WGS84_A * (1.0 - WGS84_F);
/// First eccentricity squared.
pub const WGS84_E2: f64 = WGS84_F * (2.0 - WGS84_F);
/// Second eccentricity squared.
pub const WGS84_EP2: f64 = WGS84_E2 / (1.0 - WGS84_E2);
/// Mean Earth radius used for great-circle math (m).
pub const EARTH_MEAN_RADIUS: f64 = 6_371_008.8;

pub const FT_TO_M: f64 = 0.3048;
pub const M_TO_FT: f64 = 1.0 / FT_TO_M;
pub const KT_TO_MS: f64 = 0.514_444_444;
pub const MS_TO_KT: f64 = 1.0 / KT_TO_MS;

/// A geodetic position on the WGS84 ellipsoid.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Geodetic {
    /// Latitude in radians.
    pub lat: f64,
    /// Longitude in radians.
    pub lon: f64,
    /// Height above the ellipsoid in meters.
    pub height: f64,
}

impl Geodetic {
    pub fn from_degrees(lat_deg: f64, lon_deg: f64, height: f64) -> Self {
        Self { lat: lat_deg.to_radians(), lon: lon_deg.to_radians(), height }
    }

    pub fn lat_deg(&self) -> f64 {
        self.lat.to_degrees()
    }

    pub fn lon_deg(&self) -> f64 {
        self.lon.to_degrees()
    }

    pub fn to_ecef(&self) -> DVec3 {
        geodetic_to_ecef(self.lat, self.lon, self.height)
    }
}

/// Converts geodetic coordinates to Earth-Centered, Earth-Fixed (meters).
pub fn geodetic_to_ecef(lat: f64, lon: f64, h: f64) -> DVec3 {
    let (slat, clat) = lat.sin_cos();
    let (slon, clon) = lon.sin_cos();
    let n = WGS84_A / (1.0 - WGS84_E2 * slat * slat).sqrt();
    DVec3::new(
        (n + h) * clat * clon,
        (n + h) * clat * slon,
        (n * (1.0 - WGS84_E2) + h) * slat,
    )
}

/// Converts ECEF (meters) to geodetic coordinates using Bowring's method with
/// two refinement iterations (sub-millimeter at aircraft altitudes).
pub fn ecef_to_geodetic(p: DVec3) -> Geodetic {
    let lon = p.y.atan2(p.x);
    let r = (p.x * p.x + p.y * p.y).sqrt();
    if r < 1e-6 {
        // On the polar axis.
        let lat = if p.z >= 0.0 { std::f64::consts::FRAC_PI_2 } else { -std::f64::consts::FRAC_PI_2 };
        return Geodetic { lat, lon: 0.0, height: p.z.abs() - WGS84_B };
    }
    // Initial parametric latitude estimate (Bowring 1976).
    let mut beta = (p.z * WGS84_A).atan2(r * WGS84_B);
    let mut lat = 0.0;
    for _ in 0..3 {
        let (sb, cb) = beta.sin_cos();
        lat = (p.z + WGS84_EP2 * WGS84_B * sb * sb * sb).atan2(r - WGS84_E2 * WGS84_A * cb * cb * cb);
        beta = ((1.0 - WGS84_F) * lat.sin()).atan2(lat.cos());
    }
    let slat = lat.sin();
    let n = WGS84_A / (1.0 - WGS84_E2 * slat * slat).sqrt();
    let height = if lat.cos().abs() > 1e-10 {
        r / lat.cos() - n
    } else {
        p.z.abs() / slat.abs() - n * (1.0 - WGS84_E2)
    };
    Geodetic { lat, lon, height }
}

/// East/North/Up unit vectors (expressed in ECEF) at a geodetic location.
#[derive(Debug, Clone, Copy)]
pub struct EnuFrame {
    pub east: DVec3,
    pub north: DVec3,
    pub up: DVec3,
}

impl EnuFrame {
    pub fn at(lat: f64, lon: f64) -> Self {
        let (slat, clat) = lat.sin_cos();
        let (slon, clon) = lon.sin_cos();
        Self {
            east: DVec3::new(-slon, clon, 0.0),
            north: DVec3::new(-slat * clon, -slat * slon, clat),
            up: DVec3::new(clat * clon, clat * slon, slat),
        }
    }

    /// Rotation matrix whose columns are E, N, U (local ENU -> ECEF).
    pub fn to_ecef_matrix(&self) -> DMat3 {
        DMat3::from_cols(self.east, self.north, self.up)
    }

    /// Expresses an ECEF vector in local ENU components.
    pub fn to_local(&self, v: DVec3) -> DVec3 {
        DVec3::new(v.dot(self.east), v.dot(self.north), v.dot(self.up))
    }

    /// Converts local ENU components to an ECEF vector.
    pub fn to_ecef(&self, v: DVec3) -> DVec3 {
        self.east * v.x + self.north * v.y + self.up * v.z
    }
}

/// Normalizes an angle in degrees to [0, 360).
pub fn wrap_deg_360(d: f64) -> f64 {
    let r = d % 360.0;
    if r < 0.0 { r + 360.0 } else { r }
}

/// Normalizes an angle in degrees to (-180, 180].
pub fn wrap_deg_180(d: f64) -> f64 {
    let r = wrap_deg_360(d);
    if r > 180.0 { r - 360.0 } else { r }
}

/// Great-circle distance between two points (meters, spherical approximation).
pub fn haversine_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let dlat = lat2 - lat1;
    let dlon = lon2 - lon1;
    let a = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * EARTH_MEAN_RADIUS * a.sqrt().min(1.0).asin()
}

/// Initial great-circle bearing from point 1 to point 2 (radians, 0 = north, clockwise).
pub fn initial_bearing(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let dlon = lon2 - lon1;
    let y = dlon.sin() * lat2.cos();
    let x = lat1.cos() * lat2.sin() - lat1.sin() * lat2.cos() * dlon.cos();
    y.atan2(x)
}

/// Destination point from a start point, bearing (radians) and distance (meters).
pub fn destination(lat: f64, lon: f64, bearing: f64, dist_m: f64) -> (f64, f64) {
    let d = dist_m / EARTH_MEAN_RADIUS;
    let lat2 = (lat.sin() * d.cos() + lat.cos() * d.sin() * bearing.cos()).asin();
    let lon2 = lon + (bearing.sin() * d.sin() * lat.cos()).atan2(d.cos() - lat.sin() * lat2.sin());
    (lat2, ((lon2 + 3.0 * std::f64::consts::PI) % (2.0 * std::f64::consts::PI)) - std::f64::consts::PI)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ecef_roundtrip() {
        for &(lat, lon, h) in &[
            (41.9786, -87.9048, 200.0),
            (-33.9, 151.2, 10_000.0),
            (89.999, 10.0, 50.0),
            (0.0, 0.0, -100.0),
            (35.68, 139.76, 12_000.0),
        ] {
            let g = Geodetic::from_degrees(lat, lon, h);
            let back = ecef_to_geodetic(g.to_ecef());
            assert!((back.lat_deg() - lat).abs() < 1e-9, "lat {lat}");
            assert!((back.lon_deg() - lon).abs() < 1e-9, "lon {lon}");
            assert!((back.height - h).abs() < 1e-4, "h {h} vs {}", back.height);
        }
    }

    #[test]
    fn enu_is_orthonormal() {
        let f = EnuFrame::at(0.7, -1.5);
        assert!((f.east.cross(f.north) - f.up).length() < 1e-12);
        assert!((f.east.length() - 1.0).abs() < 1e-12);
    }

    #[test]
    fn great_circle() {
        // ORD -> JFK is roughly 1,190 km.
        let d = haversine_m(
            41.9786f64.to_radians(),
            (-87.9048f64).to_radians(),
            40.6413f64.to_radians(),
            (-73.7781f64).to_radians(),
        );
        assert!((d / 1000.0 - 1190.0).abs() < 15.0, "{d}");
        let (la, lo) = destination(0.0, 0.0, std::f64::consts::FRAC_PI_2, 111_195.0);
        assert!(la.abs() < 1e-9 && (lo.to_degrees() - 1.0).abs() < 1e-3);
    }
}
