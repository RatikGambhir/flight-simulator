//! Location search and ranking over the bundled world data.

use super::{fold, AirportSize, SearchKind, SearchResult, WorldDb, LANDMARKS};

impl WorldDb {
    /// Ranked search over airports, cities and landmarks.
    pub fn search(&self, query: &str, limit: usize) -> Vec<SearchResult> {
        let q = fold(query);
        let tokens: Vec<&str> = q.split_whitespace().collect();
        if tokens.is_empty() {
            return Vec::new();
        }
        let upper = query.trim().to_ascii_uppercase();
        let mut results = Vec::new();

        // Airports
        for a in &self.airports {
            let code_hit = upper == a.ident || (!a.icao.is_empty() && upper == a.icao) || (!a.iata.is_empty() && upper == a.iata);
            let text = if code_hit { Some(0.0) } else { match_tokens(&tokens, &a.search_words) };
            let Some(text_score) = text else { continue };
            let size_bonus = match a.size {
                AirportSize::Large => 120.0,
                AirportSize::Medium => 50.0,
                AirportSize::Small => 0.0,
            };
            let score = if code_hit { 2000.0 + size_bonus } else { text_score + size_bonus - 40.0 };
            let code = if !a.iata.is_empty() { format!("{} / {}", a.ident, a.iata) } else { a.ident.clone() };
            results.push(SearchResult {
                kind: SearchKind::Airport,
                title: a.name.clone(),
                subtitle: join_nonempty(&[&a.city, &a.country]),
                code: Some(code),
                lat: a.lat,
                lon: a.lon,
                elevation_ft: Some(a.elevation_ft),
                suggested_agl_ft: 1500.0,
                suggested_heading: 0.0,
                score,
            });
        }

        // Cities
        for p in &self.places {
            let Some(text_score) = match_tokens(&tokens, &p.search_words) else { continue };
            let pop_bonus = (p.population.max(1) as f64).log10() * 25.0;
            let exact = if fold(&p.name) == q { 250.0 } else { 0.0 };
            results.push(SearchResult {
                kind: SearchKind::City,
                title: p.name.clone(),
                subtitle: join_nonempty(&[&p.region, &p.country]),
                code: None,
                lat: p.lat,
                lon: p.lon,
                elevation_ft: None,
                suggested_agl_ft: 2500.0,
                suggested_heading: 0.0,
                score: text_score + pop_bonus + exact,
            });
        }

        // Landmarks
        for (l, w) in LANDMARKS.iter().zip(&self.landmark_words) {
            let Some(text_score) = match_tokens(&tokens, w) else { continue };
            results.push(SearchResult {
                kind: SearchKind::Landmark,
                title: l.name.to_string(),
                subtitle: l.place.to_string(),
                code: None,
                lat: l.lat,
                lon: l.lon,
                elevation_ft: None,
                suggested_agl_ft: l.agl_ft,
                suggested_heading: l.heading,
                score: text_score + 260.0,
            });
        }

        results.sort_by(|a, b| b.score.total_cmp(&a.score));
        results.truncate(limit);
        results
    }
}

fn join_nonempty(parts: &[&str]) -> String {
    parts.iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join(", ")
}

/// Every query token must prefix-match a word. Earlier words (the name) score higher.
fn match_tokens(tokens: &[&str], words: &[String]) -> Option<f64> {
    let mut score = 0.0;
    for t in tokens {
        let mut best: Option<f64> = None;
        for (i, w) in words.iter().enumerate() {
            let s = if w == t {
                120.0
            } else if w.starts_with(t) {
                70.0 + 30.0 * (t.len() as f64 / w.len() as f64)
            } else if t.len() >= 4 && w.contains(t) {
                30.0
            } else {
                continue;
            };
            let s = s - (i as f64).min(8.0) * 6.0;
            best = Some(best.map_or(s, |b: f64| b.max(s)));
        }
        score += best?;
    }
    Some(score)
}
