//! Bundled world data: airports and runways (OurAirports), populated places
//! (Natural Earth), curated landmarks and the EGM96 geoid. All datasets are
//! public domain and compiled into the binary so search works offline.

use crate::geo::{self, FT_TO_M};
use serde::Serialize;
use std::sync::OnceLock;

mod search;

static AIRPORTS_TSV: &str = include_str!("../../../data/airports.tsv");
static RUNWAYS_TSV: &str = include_str!("../../../data/runways.tsv");
static PLACES_TSV: &str = include_str!("../../../data/places.tsv");
static GEOID_BIN: &[u8] = include_bytes!("../../../data/geoid_1deg.bin");

// ---------------------------------------------------------------------------
// Geoid
// ---------------------------------------------------------------------------

/// EGM96 geoid undulation (meters) at a location: ellipsoid height = MSL + N.
/// Bilinear interpolation of a 1-degree grid (accurate to ~1-2 m).
pub fn geoid_undulation(lat_deg: f64, lon_deg: f64) -> f64 {
    const COLS: usize = 361;
    let r = (90.0 - lat_deg.clamp(-90.0, 90.0)).clamp(0.0, 179.9999);
    let c = (geo::wrap_deg_180(lon_deg) + 180.0).clamp(0.0, 359.9999);
    let (r0, c0) = (r.floor() as usize, c.floor() as usize);
    let (fr, fc) = (r - r0 as f64, c - c0 as f64);
    let at = |rr: usize, cc: usize| -> f64 {
        let i = (rr * COLS + cc) * 2;
        i16::from_le_bytes([GEOID_BIN[i], GEOID_BIN[i + 1]]) as f64 / 10.0
    };
    let top = at(r0, c0) * (1.0 - fc) + at(r0, c0 + 1) * fc;
    let bottom = at(r0 + 1, c0) * (1.0 - fc) + at(r0 + 1, c0 + 1) * fc;
    top * (1.0 - fr) + bottom * fr
}

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AirportSize {
    Large,
    Medium,
    Small,
}

#[derive(Debug, Clone, Serialize)]
pub struct Airport {
    pub ident: String,
    pub icao: String,
    pub iata: String,
    pub name: String,
    pub city: String,
    pub country: String,
    pub size: AirportSize,
    pub lat: f64,
    pub lon: f64,
    pub elevation_ft: f64,
    #[serde(skip)]
    runway_range: (usize, usize),
    #[serde(skip)]
    search_words: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunwayEnd {
    pub ident: String,
    pub lat: f64,
    pub lon: f64,
    pub elevation_ft: Option<f64>,
    /// True heading (degrees) when departing from this end.
    pub heading_deg: f64,
    pub displaced_threshold_ft: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Runway {
    pub length_ft: f64,
    pub width_ft: f64,
    pub surface: String,
    pub ends: [RunwayEnd; 2],
}

#[derive(Debug, Clone, Serialize)]
pub struct Place {
    pub name: String,
    pub region: String,
    pub country: String,
    pub lat: f64,
    pub lon: f64,
    pub population: u64,
    #[serde(skip)]
    search_words: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchKind {
    Airport,
    City,
    Landmark,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub kind: SearchKind,
    pub title: String,
    pub subtitle: String,
    pub code: Option<String>,
    pub lat: f64,
    pub lon: f64,
    /// Ground elevation in feet MSL when known (airports).
    pub elevation_ft: Option<f64>,
    /// Suggested view altitude above ground (ft) for in-flight spawns.
    pub suggested_agl_ft: f64,
    /// Suggested initial heading (deg).
    pub suggested_heading: f64,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AirportDetail {
    pub airport: Airport,
    pub runways: Vec<Runway>,
    pub geoid_m: f64,
}

pub struct Landmark {
    pub name: &'static str,
    pub place: &'static str,
    pub lat: f64,
    pub lon: f64,
    /// Suggested AGL altitude (ft) and heading for a scenic approach.
    pub agl_ft: f64,
    pub heading: f64,
}

/// Curated scenic spots. Coordinates are public-knowledge locations.
pub static LANDMARKS: &[Landmark] = &[
    Landmark { name: "Downtown Chicago & Willis Tower", place: "Chicago, United States", lat: 41.8789, lon: -87.6359, agl_ft: 2000.0, heading: 90.0 },
    Landmark { name: "Navy Pier", place: "Chicago, United States", lat: 41.8917, lon: -87.6086, agl_ft: 1500.0, heading: 270.0 },
    Landmark { name: "Lower Manhattan & One World Trade Center", place: "New York, United States", lat: 40.7127, lon: -74.0134, agl_ft: 2000.0, heading: 20.0 },
    Landmark { name: "Empire State Building", place: "New York, United States", lat: 40.7484, lon: -73.9857, agl_ft: 2000.0, heading: 30.0 },
    Landmark { name: "Statue of Liberty", place: "New York, United States", lat: 40.6892, lon: -74.0445, agl_ft: 1200.0, heading: 45.0 },
    Landmark { name: "Central Park", place: "New York, United States", lat: 40.7829, lon: -73.9654, agl_ft: 2000.0, heading: 200.0 },
    Landmark { name: "Golden Gate Bridge", place: "San Francisco, United States", lat: 37.8199, lon: -122.4783, agl_ft: 1500.0, heading: 140.0 },
    Landmark { name: "Hollywood Sign", place: "Los Angeles, United States", lat: 34.1341, lon: -118.3215, agl_ft: 1500.0, heading: 0.0 },
    Landmark { name: "Las Vegas Strip", place: "Las Vegas, United States", lat: 36.1147, lon: -115.1728, agl_ft: 2000.0, heading: 0.0 },
    Landmark { name: "Hoover Dam", place: "Nevada / Arizona, United States", lat: 36.0160, lon: -114.7377, agl_ft: 1500.0, heading: 120.0 },
    Landmark { name: "Grand Canyon (South Rim)", place: "Arizona, United States", lat: 36.0616, lon: -112.1078, agl_ft: 3000.0, heading: 0.0 },
    Landmark { name: "Monument Valley", place: "Utah, United States", lat: 36.9980, lon: -110.0985, agl_ft: 2000.0, heading: 0.0 },
    Landmark { name: "Yosemite Valley & Half Dome", place: "California, United States", lat: 37.7459, lon: -119.5332, agl_ft: 4000.0, heading: 70.0 },
    Landmark { name: "Space Needle", place: "Seattle, United States", lat: 47.6205, lon: -122.3493, agl_ft: 1500.0, heading: 180.0 },
    Landmark { name: "Mount Rainier", place: "Washington, United States", lat: 46.8523, lon: -121.7603, agl_ft: 6000.0, heading: 0.0 },
    Landmark { name: "Mount St. Helens", place: "Washington, United States", lat: 46.1914, lon: -122.1956, agl_ft: 5000.0, heading: 180.0 },
    Landmark { name: "Washington Monument & National Mall", place: "Washington D.C., United States", lat: 38.8895, lon: -77.0353, agl_ft: 1500.0, heading: 90.0 },
    Landmark { name: "Niagara Falls", place: "Ontario / New York", lat: 43.0828, lon: -79.0742, agl_ft: 1500.0, heading: 0.0 },
    Landmark { name: "CN Tower", place: "Toronto, Canada", lat: 43.6426, lon: -79.3871, agl_ft: 2000.0, heading: 0.0 },
    Landmark { name: "Moraine Lake", place: "Banff, Canada", lat: 51.3217, lon: -116.1860, agl_ft: 4000.0, heading: 90.0 },
    Landmark { name: "Christ the Redeemer", place: "Rio de Janeiro, Brazil", lat: -22.9519, lon: -43.2105, agl_ft: 1500.0, heading: 90.0 },
    Landmark { name: "Sugarloaf Mountain", place: "Rio de Janeiro, Brazil", lat: -22.9493, lon: -43.1546, agl_ft: 1500.0, heading: 270.0 },
    Landmark { name: "Machu Picchu", place: "Cusco, Peru", lat: -13.1631, lon: -72.5450, agl_ft: 3000.0, heading: 0.0 },
    Landmark { name: "Iguazu Falls", place: "Argentina / Brazil", lat: -25.6953, lon: -54.4367, agl_ft: 1500.0, heading: 0.0 },
    Landmark { name: "Eiffel Tower", place: "Paris, France", lat: 48.8584, lon: 2.2945, agl_ft: 1500.0, heading: 120.0 },
    Landmark { name: "Mont Blanc", place: "Chamonix, France", lat: 45.8326, lon: 6.8652, agl_ft: 5000.0, heading: 0.0 },
    Landmark { name: "Big Ben & Westminster", place: "London, United Kingdom", lat: 51.5007, lon: -0.1246, agl_ft: 1500.0, heading: 90.0 },
    Landmark { name: "Tower Bridge", place: "London, United Kingdom", lat: 51.5055, lon: -0.0754, agl_ft: 1500.0, heading: 270.0 },
    Landmark { name: "Cliffs of Moher", place: "County Clare, Ireland", lat: 52.9715, lon: -9.4309, agl_ft: 1200.0, heading: 0.0 },
    Landmark { name: "Rock of Gibraltar", place: "Gibraltar", lat: 36.1440, lon: -5.3536, agl_ft: 2500.0, heading: 0.0 },
    Landmark { name: "Sagrada Família", place: "Barcelona, Spain", lat: 41.4036, lon: 2.1744, agl_ft: 1500.0, heading: 135.0 },
    Landmark { name: "Colosseum", place: "Rome, Italy", lat: 41.8902, lon: 12.4922, agl_ft: 1500.0, heading: 0.0 },
    Landmark { name: "Venice Grand Canal", place: "Venice, Italy", lat: 45.4380, lon: 12.3359, agl_ft: 1500.0, heading: 180.0 },
    Landmark { name: "Lake Como", place: "Lombardy, Italy", lat: 45.9870, lon: 9.2610, agl_ft: 4000.0, heading: 0.0 },
    Landmark { name: "Matterhorn", place: "Zermatt, Switzerland", lat: 45.9763, lon: 7.6586, agl_ft: 5000.0, heading: 230.0 },
    Landmark { name: "Jungfrau & Lauterbrunnen Valley", place: "Bernese Oberland, Switzerland", lat: 46.5368, lon: 7.9626, agl_ft: 5000.0, heading: 0.0 },
    Landmark { name: "Zugspitze", place: "Bavaria, Germany", lat: 47.4211, lon: 10.9853, agl_ft: 4000.0, heading: 90.0 },
    Landmark { name: "Neuschwanstein Castle", place: "Bavaria, Germany", lat: 47.5576, lon: 10.7498, agl_ft: 1500.0, heading: 0.0 },
    Landmark { name: "Brandenburg Gate", place: "Berlin, Germany", lat: 52.5163, lon: 13.3777, agl_ft: 1500.0, heading: 90.0 },
    Landmark { name: "Geirangerfjord", place: "Møre og Romsdal, Norway", lat: 62.1049, lon: 7.0943, agl_ft: 3000.0, heading: 270.0 },
    Landmark { name: "Acropolis", place: "Athens, Greece", lat: 37.9715, lon: 23.7257, agl_ft: 1500.0, heading: 0.0 },
    Landmark { name: "Santorini (Oia)", place: "Cyclades, Greece", lat: 36.4618, lon: 25.3753, agl_ft: 1500.0, heading: 180.0 },
    Landmark { name: "Red Square & the Kremlin", place: "Moscow, Russia", lat: 55.7539, lon: 37.6208, agl_ft: 1500.0, heading: 0.0 },
    Landmark { name: "Pyramids of Giza", place: "Giza, Egypt", lat: 29.9792, lon: 31.1342, agl_ft: 1500.0, heading: 225.0 },
    Landmark { name: "Burj Khalifa", place: "Dubai, United Arab Emirates", lat: 25.1972, lon: 55.2744, agl_ft: 3500.0, heading: 0.0 },
    Landmark { name: "Palm Jumeirah", place: "Dubai, United Arab Emirates", lat: 25.1124, lon: 55.1390, agl_ft: 3000.0, heading: 0.0 },
    Landmark { name: "Mount Kilimanjaro", place: "Tanzania", lat: -3.0674, lon: 37.3556, agl_ft: 6000.0, heading: 0.0 },
    Landmark { name: "Victoria Falls", place: "Zambia / Zimbabwe", lat: -17.9243, lon: 25.8572, agl_ft: 1500.0, heading: 0.0 },
    Landmark { name: "Table Mountain", place: "Cape Town, South Africa", lat: -33.9628, lon: 18.4098, agl_ft: 2500.0, heading: 0.0 },
    Landmark { name: "Taj Mahal", place: "Agra, India", lat: 27.1751, lon: 78.0421, agl_ft: 1500.0, heading: 0.0 },
    Landmark { name: "Mount Everest", place: "Nepal / China", lat: 27.9881, lon: 86.9250, agl_ft: 3000.0, heading: 0.0 },
    Landmark { name: "Forbidden City", place: "Beijing, China", lat: 39.9163, lon: 116.3972, agl_ft: 1500.0, heading: 0.0 },
    Landmark { name: "Great Wall at Mutianyu", place: "Beijing, China", lat: 40.4319, lon: 116.5704, agl_ft: 2000.0, heading: 90.0 },
    Landmark { name: "The Bund & Pudong Skyline", place: "Shanghai, China", lat: 31.2397, lon: 121.4998, agl_ft: 2000.0, heading: 90.0 },
    Landmark { name: "Victoria Harbour", place: "Hong Kong", lat: 22.2930, lon: 114.1694, agl_ft: 2000.0, heading: 0.0 },
    Landmark { name: "Ha Long Bay", place: "Quang Ninh, Vietnam", lat: 20.9101, lon: 107.1839, agl_ft: 2000.0, heading: 90.0 },
    Landmark { name: "Angkor Wat", place: "Siem Reap, Cambodia", lat: 13.4125, lon: 103.8670, agl_ft: 1500.0, heading: 0.0 },
    Landmark { name: "Petronas Towers", place: "Kuala Lumpur, Malaysia", lat: 3.1579, lon: 101.7116, agl_ft: 2000.0, heading: 0.0 },
    Landmark { name: "Marina Bay Sands", place: "Singapore", lat: 1.2834, lon: 103.8607, agl_ft: 1500.0, heading: 0.0 },
    Landmark { name: "Tokyo Tower", place: "Tokyo, Japan", lat: 35.6586, lon: 139.7454, agl_ft: 1500.0, heading: 0.0 },
    Landmark { name: "Shibuya & Shinjuku", place: "Tokyo, Japan", lat: 35.6762, lon: 139.7003, agl_ft: 2000.0, heading: 0.0 },
    Landmark { name: "Tokyo Skytree", place: "Tokyo, Japan", lat: 35.7101, lon: 139.8107, agl_ft: 2500.0, heading: 0.0 },
    Landmark { name: "Mount Fuji", place: "Shizuoka / Yamanashi, Japan", lat: 35.3606, lon: 138.7274, agl_ft: 5000.0, heading: 0.0 },
    Landmark { name: "Sydney Opera House & Harbour Bridge", place: "Sydney, Australia", lat: -33.8568, lon: 151.2153, agl_ft: 1500.0, heading: 0.0 },
    Landmark { name: "Uluru", place: "Northern Territory, Australia", lat: -25.3444, lon: 131.0369, agl_ft: 2000.0, heading: 0.0 },
    Landmark { name: "Aoraki / Mount Cook", place: "Canterbury, New Zealand", lat: -43.5950, lon: 170.1418, agl_ft: 5000.0, heading: 0.0 },
    Landmark { name: "Milford Sound", place: "Fiordland, New Zealand", lat: -44.6414, lon: 167.8974, agl_ft: 3000.0, heading: 300.0 },
];

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

pub struct WorldDb {
    pub airports: Vec<Airport>,
    pub runways: Vec<Runway>,
    pub places: Vec<Place>,
    landmark_words: Vec<Vec<String>>,
}

static DB: OnceLock<WorldDb> = OnceLock::new();

/// The global world database (parsed lazily on first use, ~20 ms).
pub fn db() -> &'static WorldDb {
    DB.get_or_init(WorldDb::load)
}

/// Lowercases and strips common Latin diacritics for matching.
pub fn fold(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        let c = match ch {
            'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' | 'ā' | 'Á' | 'À' | 'Â' | 'Ä' | 'Ã' | 'Å' => 'a',
            'é' | 'è' | 'ê' | 'ë' | 'ē' | 'É' | 'È' | 'Ê' | 'Ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' | 'Í' | 'Ì' | 'Î' | 'Ï' => 'i',
            'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'ø' | 'ō' | 'Ó' | 'Ò' | 'Ô' | 'Ö' | 'Õ' | 'Ø' => 'o',
            'ú' | 'ù' | 'û' | 'ü' | 'ū' | 'Ú' | 'Ù' | 'Û' | 'Ü' => 'u',
            'ç' | 'Ç' => 'c',
            'ñ' | 'Ñ' => 'n',
            'ß' => 's',
            '\'' | '’' | '.' | ',' | '(' | ')' | '/' | '-' | '&' => ' ',
            c => c.to_ascii_lowercase(),
        };
        out.push(c);
    }
    out
}

fn words(parts: &[&str]) -> Vec<String> {
    let mut w: Vec<String> = parts
        .iter()
        .flat_map(|p| fold(p).split_whitespace().map(str::to_owned).collect::<Vec<_>>())
        .collect();
    w.dedup();
    w
}

fn parse_f(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() { None } else { t.parse().ok() }
}

impl WorldDb {
    fn load() -> Self {
        // Runways are grouped by airport ident in file order.
        let mut runways = Vec::new();
        let mut runway_idents: Vec<&str> = Vec::new();
        for line in RUNWAYS_TSV.lines() {
            let f: Vec<&str> = line.split('\t').collect();
            if f.len() < 16 {
                continue;
            }
            let (Some(la), Some(lo), Some(hla), Some(hlo)) = (parse_f(f[5]), parse_f(f[6]), parse_f(f[11]), parse_f(f[12])) else {
                continue;
            };
            let brg = geo::initial_bearing(la.to_radians(), lo.to_radians(), hla.to_radians(), hlo.to_radians()).to_degrees();
            let le_hdg = geo::wrap_deg_360(brg);
            let he_hdg = geo::wrap_deg_360(brg + 180.0);
            runways.push(Runway {
                length_ft: parse_f(f[1]).unwrap_or(0.0),
                width_ft: parse_f(f[2]).unwrap_or(100.0).max(30.0),
                surface: f[3].to_string(),
                ends: [
                    RunwayEnd {
                        ident: f[4].to_string(),
                        lat: la,
                        lon: lo,
                        elevation_ft: parse_f(f[7]),
                        heading_deg: le_hdg,
                        displaced_threshold_ft: parse_f(f[9]).unwrap_or(0.0),
                    },
                    RunwayEnd {
                        ident: f[10].to_string(),
                        lat: hla,
                        lon: hlo,
                        elevation_ft: parse_f(f[13]),
                        heading_deg: he_hdg,
                        displaced_threshold_ft: parse_f(f[15]).unwrap_or(0.0),
                    },
                ],
            });
            runway_idents.push(f[0]);
        }
        // Sort runways by airport ident so each airport owns a contiguous range.
        let mut order: Vec<usize> = (0..runways.len()).collect();
        order.sort_by(|&a, &b| runway_idents[a].cmp(runway_idents[b]));
        let sorted_idents: Vec<&str> = order.iter().map(|&i| runway_idents[i]).collect();
        let mut slots: Vec<Option<Runway>> = runways.into_iter().map(Some).collect();
        let runways: Vec<Runway> = order.iter().map(|&i| slots[i].take().expect("runway moved once")).collect();

        let mut airports = Vec::new();
        for line in AIRPORTS_TSV.lines() {
            let f: Vec<&str> = line.split('\t').collect();
            if f.len() < 10 {
                continue;
            }
            let ident = f[0];
            let start = sorted_idents.partition_point(|x| *x < ident);
            let end = sorted_idents.partition_point(|x| *x <= ident);
            if start == end {
                continue;
            }
            let size = match f[6] {
                "L" => AirportSize::Large,
                "M" => AirportSize::Medium,
                _ => AirportSize::Small,
            };
            airports.push(Airport {
                ident: ident.to_string(),
                icao: f[1].to_string(),
                iata: f[2].to_string(),
                name: f[3].to_string(),
                city: f[4].to_string(),
                country: f[5].to_string(),
                size,
                lat: parse_f(f[7]).unwrap_or(0.0),
                lon: parse_f(f[8]).unwrap_or(0.0),
                elevation_ft: parse_f(f[9]).unwrap_or(0.0),
                runway_range: (start, end),
                search_words: words(&[f[3], f[4], f[5]]),
            });
        }

        let places = PLACES_TSV
            .lines()
            .filter_map(|line| {
                let f: Vec<&str> = line.split('\t').collect();
                if f.len() < 6 {
                    return None;
                }
                Some(Place {
                    name: f[0].to_string(),
                    region: f[1].to_string(),
                    country: f[2].to_string(),
                    lat: parse_f(f[3])?,
                    lon: parse_f(f[4])?,
                    population: f[5].parse().unwrap_or(0),
                    search_words: words(&[f[0], f[1], f[2]]),
                })
            })
            .collect();

        let landmark_words = LANDMARKS.iter().map(|l| words(&[l.name, l.place])).collect();
        Self { airports, runways, places, landmark_words }
    }

    pub fn airport(&self, ident: &str) -> Option<&Airport> {
        let q = ident.trim().to_ascii_uppercase();
        self.airports
            .iter()
            .find(|a| a.ident == q)
            .or_else(|| self.airports.iter().find(|a| a.icao == q))
            .or_else(|| self.airports.iter().find(|a| !a.iata.is_empty() && a.iata == q))
    }

    pub fn runways_of(&self, a: &Airport) -> &[Runway] {
        &self.runways[a.runway_range.0..a.runway_range.1]
    }

    pub fn airport_detail(&self, ident: &str) -> Option<AirportDetail> {
        let a = self.airport(ident)?;
        let mut runways = self.runways_of(a).to_vec();
        runways.sort_by(|x, y| y.length_ft.total_cmp(&x.length_ft));
        Some(AirportDetail { geoid_m: geoid_undulation(a.lat, a.lon), airport: a.clone(), runways })
    }

    /// Finds a runway end by ident (e.g. "28R"); defaults to the longest runway,
    /// choosing the end best aligned into the prevailing westerly wind.
    pub fn runway_end(&self, a: &Airport, end_ident: Option<&str>) -> Option<(Runway, usize)> {
        let rws = self.runways_of(a);
        if let Some(id) = end_ident {
            let id = id.trim().to_ascii_uppercase();
            for r in rws {
                for (i, e) in r.ends.iter().enumerate() {
                    if e.ident.to_ascii_uppercase() == id {
                        return Some((r.clone(), i));
                    }
                }
            }
        }
        let r = rws.iter().max_by(|x, y| x.length_ft.total_cmp(&y.length_ft))?;
        // Prefer the end whose departure heading is closest to west (270).
        let score = |e: &RunwayEnd| geo::wrap_deg_180(e.heading_deg - 270.0).abs();
        let i = if score(&r.ends[0]) <= score(&r.ends[1]) { 0 } else { 1 };
        Some((r.clone(), i))
    }

    /// Airports within `radius_km`, nearest first.
    pub fn nearest_airports(&self, lat: f64, lon: f64, radius_km: f64, limit: usize) -> Vec<(f64, &Airport)> {
        let (la, lo) = (lat.to_radians(), lon.to_radians());
        let dlat = radius_km / 111.0;
        let mut out: Vec<(f64, &Airport)> = self
            .airports
            .iter()
            .filter(|a| (a.lat - lat).abs() <= dlat)
            .map(|a| (geo::haversine_m(la, lo, a.lat.to_radians(), a.lon.to_radians()) / 1000.0, a))
            .filter(|(d, _)| *d <= radius_km)
            .collect();
        out.sort_by(|x, y| x.0.total_cmp(&y.0));
        out.truncate(limit);
        out
    }

    /// Airports for drawing on the world map.
    pub fn map_airports(&self, include_medium: bool) -> Vec<(&str, &str, f64, f64)> {
        self.airports
            .iter()
            .filter(|a| a.size == AirportSize::Large || (include_medium && a.size == AirportSize::Medium))
            .map(|a| (a.ident.as_str(), a.name.as_str(), a.lat, a.lon))
            .collect()
    }
}

/// Converts an elevation in feet MSL to meters above the WGS84 ellipsoid.
pub fn msl_ft_to_ellipsoid_m(lat: f64, lon: f64, ft: f64) -> f64 {
    ft * FT_TO_M + geoid_undulation(lat, lon)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_ohare() {
        let db = db();
        let r = db.search("ORD", 5);
        assert_eq!(r[0].code.as_deref(), Some("KORD / ORD"));
        let r = db.search("chicago o'hare", 5);
        assert!(r[0].title.contains("O'Hare"), "{:?}", r[0].title);
        let a = db.airport("KORD").unwrap();
        assert!(db.runways_of(a).len() >= 7);
        let (rw, end) = db.runway_end(a, Some("28R")).unwrap();
        assert!((rw.ends[end].heading_deg - 270.0).abs() < 5.0);
    }

    #[test]
    fn finds_cities_and_landmarks() {
        let db = db();
        let r = db.search("tokyo", 10);
        assert!(r.iter().any(|x| x.kind == SearchKind::City && x.title == "Tokyo"));
        let r = db.search("matterhorn", 3);
        assert_eq!(r[0].kind, SearchKind::Landmark);
        let r = db.search("zurich", 5);
        assert!(!r.is_empty());
    }

    #[test]
    fn geoid_values() {
        assert!((geoid_undulation(41.97, -87.9) + 34.0).abs() < 1.5);
        // Indian Ocean geoid low (~ -100 m)
        assert!(geoid_undulation(5.0, 78.0) < -90.0);
    }
}
