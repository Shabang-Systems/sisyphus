use chrono::{DateTime, Local, NaiveDateTime, Duration, Utc, Timelike};
use crate::scheduler::ChunkConfig;

/// A busy time block from a calendar event.
#[derive(Debug, Clone)]
pub struct BusyBlock {
    pub start: DateTime<Local>,
    pub end: DateTime<Local>,
}

/// Fetch and parse ICS calendars, returning busy blocks within the scheduling horizon.
pub async fn fetch_busy_blocks(urls: &[String], horizon_days: usize) -> Vec<BusyBlock> {
    let now = Local::now();
    let horizon_end = now + Duration::days(horizon_days as i64);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_default();

    let mut blocks = Vec::new();

    for url in urls {
        let url = url.trim();
        if url.is_empty() { continue; }

        let body = match client.get(url)
            .header("Cache-Control", "no-cache")
            .send().await {
            Ok(resp) => match resp.text().await {
                Ok(t) => t,
                Err(e) => { eprintln!("[CAL] Failed to read body from {}: {}", url, e); continue; }
            },
            Err(e) => { eprintln!("[CAL] Failed to fetch {}: {}", url, e); continue; }
        };

        let reader = ical::IcalParser::new(body.as_bytes());
        for cal in reader.flatten() {
            for event in cal.events {
                let mut dtstart: Option<String> = None;
                let mut dtend: Option<String> = None;

                for prop in &event.properties {
                    match prop.name.as_str() {
                        "DTSTART" => dtstart = prop.value.clone(),
                        "DTEND" => dtend = prop.value.clone(),
                        _ => {}
                    }
                }

                if let (Some(start_str), Some(end_str)) = (dtstart, dtend) {
                    if let (Some(start), Some(end)) = (parse_ical_dt(&start_str), parse_ical_dt(&end_str)) {
                        // Only include events within horizon
                        if end > now && start < horizon_end {
                            blocks.push(BusyBlock { start, end });
                        }
                    }
                }
            }
        }
    }

    blocks
}

/// Convert busy blocks into capacity reduction per chunk.
/// Returns a vec of `total_chunks` floats: slots consumed by calendar events.
pub fn busy_to_capacity(blocks: &[BusyBlock], _start_h: usize, cfg: &ChunkConfig) -> Vec<f64> {
    let total_chunks = cfg.total_chunks();
    let hours_per_chunk = cfg.hours_per_chunk();
    let slots_per_chunk = cfg.slots_per_chunk();
    let mut used = vec![0.0f64; total_chunks];
    let now = Local::now();
    let now_h = now.hour() as usize / hours_per_chunk;
    let remaining_today = cfg.chunks_per_day - now_h;

    for block in blocks {
        // Iterate 30-minute slots within the block
        let mut cursor = block.start;
        while cursor < block.end {
            let diff = cursor.signed_duration_since(now);
            if diff.num_seconds() >= 0 {
                // Map to chunk index using same logic as date_to_chunk
                let target_h = cursor.hour() as usize / hours_per_chunk;
                let day_start = cursor.date_naive().and_hms_opt(0, 0, 0).unwrap();
                let now_day_start = now.date_naive().and_hms_opt(0, 0, 0).unwrap();
                let day_diff = (day_start - now_day_start).num_days() as usize;

                let chunk = if day_diff == 0 {
                    if target_h >= now_h { target_h - now_h } else { 0 }
                } else {
                    remaining_today + (day_diff - 1) * cfg.chunks_per_day + target_h
                };

                if chunk < total_chunks {
                    // Add 1 slot (30 min) for this time slice
                    used[chunk] += 1.0;
                }
            }
            cursor = cursor + Duration::minutes(30);
        }
    }

    // Cap at slots_per_chunk (full capacity)
    for v in &mut used {
        *v = v.min(slots_per_chunk);
    }

    used
}

/// Convert busy blocks into an absolute grid (day × chunk-of-day).
/// Index = day * chunks_per_day + chunk_of_day. Each value is 0.0–slots_per_chunk.
pub fn busy_to_grid(blocks: &[BusyBlock], cfg: &ChunkConfig) -> Vec<f64> {
    let grid_size = cfg.horizon_days * cfg.chunks_per_day;
    let hours_per_chunk = cfg.hours_per_chunk();
    let slots_per_chunk = cfg.slots_per_chunk();
    let mut grid = vec![0.0f64; grid_size];
    let now = Local::now();
    let today_start = now.date_naive().and_hms_opt(0, 0, 0).unwrap();

    for block in blocks {
        let mut cursor = block.start;
        while cursor < block.end {
            let day_start = cursor.date_naive().and_hms_opt(0, 0, 0).unwrap();
            let day_diff = (day_start - today_start).num_days();
            if day_diff >= 0 && (day_diff as usize) < cfg.horizon_days {
                let chunk_of_day = cursor.hour() as usize / hours_per_chunk;
                let idx = day_diff as usize * cfg.chunks_per_day + chunk_of_day;
                if idx < grid.len() {
                    grid[idx] += 1.0;
                }
            }
            cursor = cursor + Duration::minutes(30);
        }
    }

    for v in &mut grid {
        *v = v.min(slots_per_chunk);
    }

    grid
}

use chrono::TimeZone;

fn parse_ical_dt(s: &str) -> Option<DateTime<Local>> {
    // Try common ICS formats: 20260323T120000Z, 20260323T120000, 20260323
    let s = s.trim();

    if s.ends_with('Z') {
        let s = &s[..s.len()-1];
        if let Ok(dt) = NaiveDateTime::parse_from_str(s, "%Y%m%dT%H%M%S") {
            return Some(Utc.from_utc_datetime(&dt).with_timezone(&Local));
        }
    }

    if let Ok(dt) = NaiveDateTime::parse_from_str(s, "%Y%m%dT%H%M%S") {
        return dt.and_local_timezone(Local).single();
    }

    if let Ok(d) = chrono::NaiveDate::parse_from_str(s, "%Y%m%d") {
        let dt = d.and_hms_opt(0, 0, 0)?;
        return dt.and_local_timezone(Local).single();
    }

    // Try RFC3339
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Local));
    }

    None
}
