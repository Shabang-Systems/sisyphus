use chrono::{DateTime, Local, NaiveDateTime, Duration, Utc, Timelike, Datelike, TimeZone};
use crate::scheduler::ChunkConfig;

/// A busy time block from a calendar event.
#[derive(Debug, Clone)]
pub struct BusyBlock {
    pub start: DateTime<Local>,
    pub end: DateTime<Local>,
}

/// Extended busy block with raw ICS diagnostic data for the debug view.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DebugBusyBlock {
    pub summary: String,
    pub start: String,
    pub end: String,
    pub duration_min: i64,
    pub raw_start: String,
    pub raw_end: String,
    pub tzid: Option<String>,
    pub all_day: bool,
    pub transparent: bool,
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
                let mut dtstart_prop: Option<&ical::property::Property> = None;
                let mut dtend_prop: Option<&ical::property::Property> = None;
                let mut rrule_val: Option<String> = None;

                for prop in &event.properties {
                    match prop.name.as_str() {
                        "DTSTART" => dtstart_prop = Some(prop),
                        "DTEND" => dtend_prop = Some(prop),
                        "RRULE" => rrule_val = prop.value.clone(),
                        _ => {}
                    }
                }

                let start_val = dtstart_prop.and_then(|p| p.value.clone());
                let end_val = dtend_prop.and_then(|p| p.value.clone());
                let (tzid, _) = dtstart_prop.map(extract_dt_params).unwrap_or((None, false));
                let tzid_ref = tzid.as_deref();

                if let (Some(start_str), Some(end_str)) = (start_val, end_val) {
                    if let (Some(start), Some(end)) = (parse_ical_dt(&start_str, tzid_ref), parse_ical_dt(&end_str, tzid_ref)) {
                        let duration = end - start;

                        // Base occurrence
                        if end > now && start < horizon_end {
                            blocks.push(BusyBlock { start, end });
                        }

                        // RRULE expansion
                        if let Some(ref rv) = rrule_val {
                            if let Some(rule) = parse_rrule(rv, tzid_ref) {
                                let exdates = parse_exdates(&event.properties, tzid_ref);
                                for (s, e) in expand_rrule(start, duration, &rule, &exdates, horizon_end) {
                                    if e > now && s < horizon_end {
                                        blocks.push(BusyBlock { start: s, end: e });
                                    }
                                }
                            }
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

// ── RRULE expansion ──────────────────────────────────────────────────────────

struct ParsedRRule {
    freq: String,
    interval: usize,
    until: Option<DateTime<Local>>,
    count: Option<usize>,
    byday: Vec<chrono::Weekday>,
}

fn parse_rrule(value: &str, tzid: Option<&str>) -> Option<ParsedRRule> {
    let mut freq = None;
    let mut interval = 1usize;
    let mut until = None;
    let mut count = None;
    let mut byday = Vec::new();

    for part in value.split(';') {
        if let Some((k, v)) = part.split_once('=') {
            match k {
                "FREQ" => freq = Some(v.to_string()),
                "INTERVAL" => interval = v.parse().unwrap_or(1),
                "UNTIL" => until = parse_ical_dt(v, tzid),
                "COUNT" => count = v.parse().ok(),
                "BYDAY" => {
                    byday = v.split(',').filter_map(|d| {
                        let d = d.trim_start_matches(|c: char| c.is_ascii_digit() || c == '-' || c == '+');
                        match d {
                            "MO" => Some(chrono::Weekday::Mon),
                            "TU" => Some(chrono::Weekday::Tue),
                            "WE" => Some(chrono::Weekday::Wed),
                            "TH" => Some(chrono::Weekday::Thu),
                            "FR" => Some(chrono::Weekday::Fri),
                            "SA" => Some(chrono::Weekday::Sat),
                            "SU" => Some(chrono::Weekday::Sun),
                            _ => None,
                        }
                    }).collect();
                }
                _ => {}
            }
        }
    }

    Some(ParsedRRule { freq: freq?, interval, until, count, byday })
}

/// Parse EXDATE properties (possibly multiple, possibly comma-separated).
fn parse_exdates(props: &[ical::property::Property], fallback_tzid: Option<&str>) -> Vec<DateTime<Local>> {
    let mut out = Vec::new();
    for prop in props {
        if prop.name != "EXDATE" { continue; }
        let tzid = prop.params.as_ref()
            .and_then(|ps| ps.iter().find(|(k, _)| k == "TZID"))
            .and_then(|(_, v)| v.first())
            .map(|s| s.as_str())
            .or(fallback_tzid);
        if let Some(ref val) = prop.value {
            for part in val.split(',') {
                if let Some(dt) = parse_ical_dt(part.trim(), tzid) {
                    out.push(dt);
                }
            }
        }
    }
    out
}

/// Generate additional occurrences from an RRULE beyond the base event.
fn expand_rrule(
    base_start: DateTime<Local>,
    duration: Duration,
    rule: &ParsedRRule,
    exdates: &[DateTime<Local>],
    horizon_end: DateTime<Local>,
) -> Vec<(DateTime<Local>, DateTime<Local>)> {
    let until = rule.until.unwrap_or(horizon_end);
    let max_occ = rule.count.unwrap_or(10000);
    let mut results = Vec::new();
    let mut occ_count = 1; // base event = occurrence #1

    let is_excluded = |dt: &DateTime<Local>| -> bool {
        exdates.iter().any(|ex| (*dt - *ex).num_seconds().abs() < 120)
    };

    match rule.freq.as_str() {
        "DAILY" => {
            let step = Duration::days(rule.interval as i64);
            let mut cursor = base_start + step;
            while cursor <= until && cursor < horizon_end && occ_count < max_occ {
                if !is_excluded(&cursor) {
                    results.push((cursor, cursor + duration));
                }
                cursor = cursor + step;
                occ_count += 1;
            }
        }
        "WEEKLY" => {
            let step_weeks = Duration::weeks(rule.interval as i64);
            let time = base_start.time();
            let base_dow = base_start.weekday().num_days_from_monday();
            let base_monday = base_start.date_naive() - Duration::days(base_dow as i64);
            let mut week_monday = base_monday;

            loop {
                let days: Vec<chrono::Weekday> = if rule.byday.is_empty() {
                    vec![base_start.weekday()]
                } else {
                    rule.byday.clone()
                };

                for day in &days {
                    let offset = day.num_days_from_monday() as i64;
                    let cand_date = week_monday + Duration::days(offset);
                    let cand_naive = cand_date.and_time(time);
                    let cand = match Local.from_local_datetime(&cand_naive).single() {
                        Some(dt) => dt,
                        None => continue,
                    };

                    if cand <= base_start { continue; }
                    if cand > until || cand >= horizon_end { continue; }
                    if occ_count >= max_occ { break; }

                    if !is_excluded(&cand) {
                        results.push((cand, cand + duration));
                    }
                    occ_count += 1;
                }

                if occ_count >= max_occ { break; }
                week_monday = week_monday + step_weeks;

                match Local.from_local_datetime(&week_monday.and_hms_opt(0, 0, 0).unwrap()).single() {
                    Some(dt) if dt <= until && dt < horizon_end => {}
                    _ => break,
                }
            }
        }
        _ => {} // MONTHLY, YEARLY — not implemented
    }

    results
}

// ── ICS datetime parsing ─────────────────────────────────────────────────────

fn parse_ical_dt(s: &str, tzid: Option<&str>) -> Option<DateTime<Local>> {
    // Try common ICS formats: 20260323T120000Z, 20260323T120000, 20260323
    let s = s.trim();

    // Explicit UTC suffix — TZID is irrelevant
    if s.ends_with('Z') {
        let s = &s[..s.len()-1];
        if let Ok(dt) = NaiveDateTime::parse_from_str(s, "%Y%m%dT%H%M%S") {
            return Some(Utc.from_utc_datetime(&dt).with_timezone(&Local));
        }
    }

    // Naive datetime — use TZID if provided, otherwise assume local
    if let Ok(dt) = NaiveDateTime::parse_from_str(s, "%Y%m%dT%H%M%S") {
        if let Some(tz_name) = tzid {
            if let Ok(tz) = tz_name.parse::<chrono_tz::Tz>() {
                return tz.from_local_datetime(&dt).single().map(|d| d.with_timezone(&Local));
            }
        }
        return dt.and_local_timezone(Local).single();
    }

    // Date-only (all-day events)
    if let Ok(d) = chrono::NaiveDate::parse_from_str(s, "%Y%m%d") {
        let dt = d.and_hms_opt(0, 0, 0)?;
        if let Some(tz_name) = tzid {
            if let Ok(tz) = tz_name.parse::<chrono_tz::Tz>() {
                return tz.from_local_datetime(&dt).single().map(|d| d.with_timezone(&Local));
            }
        }
        return dt.and_local_timezone(Local).single();
    }

    // Try RFC3339
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Local));
    }

    None
}

/// Extract TZID and VALUE=DATE from an ical Property's params.
fn extract_dt_params(prop: &ical::property::Property) -> (Option<String>, bool) {
    let mut tzid = None;
    let mut all_day = false;
    if let Some(ref params) = prop.params {
        for (k, v) in params {
            if k == "TZID" && !v.is_empty() {
                tzid = Some(v[0].clone());
            }
            if k == "VALUE" && v.iter().any(|x| x == "DATE") {
                all_day = true;
            }
        }
    }
    (tzid, all_day)
}

/// Fetch ICS calendars and return both BusyBlocks (for grid computation) and
/// DebugBusyBlocks (with raw ICS data) in a single pass.
pub async fn fetch_busy_blocks_debug(
    urls: &[String],
    horizon_days: usize,
) -> (Vec<BusyBlock>, Vec<DebugBusyBlock>) {
    let now = Local::now();
    let horizon_end = now + Duration::days(horizon_days as i64);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_default();

    let mut blocks = Vec::new();
    let mut debug_blocks = Vec::new();

    for url in urls {
        let url = url.trim();
        if url.is_empty() { continue; }

        let body = match client.get(url)
            .header("Cache-Control", "no-cache")
            .send().await
        {
            Ok(resp) => match resp.text().await {
                Ok(t) => t,
                Err(e) => { eprintln!("[CAL] Failed to read body from {}: {}", url, e); continue; }
            },
            Err(e) => { eprintln!("[CAL] Failed to fetch {}: {}", url, e); continue; }
        };

        let reader = ical::IcalParser::new(body.as_bytes());
        for cal in reader.flatten() {
            for event in cal.events {
                let mut dtstart_prop: Option<&ical::property::Property> = None;
                let mut dtend_prop: Option<&ical::property::Property> = None;
                let mut summary = String::new();
                let mut transparent = false;
                let mut rrule_val: Option<String> = None;

                for prop in &event.properties {
                    match prop.name.as_str() {
                        "DTSTART" => dtstart_prop = Some(prop),
                        "DTEND" => dtend_prop = Some(prop),
                        "SUMMARY" => summary = prop.value.clone().unwrap_or_default(),
                        "RRULE" => rrule_val = prop.value.clone(),
                        "TRANSP" => {
                            if prop.value.as_deref() == Some("TRANSPARENT") {
                                transparent = true;
                            }
                        }
                        _ => {}
                    }
                }

                let start_val = dtstart_prop.and_then(|p| p.value.clone());
                let end_val = dtend_prop.and_then(|p| p.value.clone());
                let (tzid, all_day) = dtstart_prop.map(extract_dt_params).unwrap_or((None, false));
                let tzid_ref = tzid.as_deref();

                if let (Some(ref start_str), Some(ref end_str)) = (&start_val, &end_val) {
                    if let (Some(start), Some(end)) = (parse_ical_dt(start_str, tzid_ref), parse_ical_dt(end_str, tzid_ref)) {
                        let duration = end - start;

                        let mut push_occurrence = |s: DateTime<Local>, e: DateTime<Local>, raw_s: &str, raw_e: &str, is_rrule: bool| {
                            if e > now && s < horizon_end {
                                blocks.push(BusyBlock { start: s, end: e });
                                debug_blocks.push(DebugBusyBlock {
                                    summary: if is_rrule { format!("{} (rrule)", summary) } else { summary.clone() },
                                    start: s.to_rfc3339(),
                                    end: e.to_rfc3339(),
                                    duration_min: (e - s).num_minutes(),
                                    raw_start: raw_s.to_string(),
                                    raw_end: raw_e.to_string(),
                                    tzid: tzid.clone(),
                                    all_day,
                                    transparent,
                                });
                            }
                        };

                        // Base occurrence
                        push_occurrence(start, end, start_str, end_str, false);

                        // RRULE expansion
                        if let Some(ref rv) = rrule_val {
                            if let Some(rule) = parse_rrule(rv, tzid_ref) {
                                let exdates = parse_exdates(&event.properties, tzid_ref);
                                for (s, e) in expand_rrule(start, duration, &rule, &exdates, horizon_end) {
                                    let rs = s.format("%Y%m%dT%H%M%S").to_string();
                                    let re = e.format("%Y%m%dT%H%M%S").to_string();
                                    push_occurrence(s, e, &rs, &re, true);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    debug_blocks.sort_by(|a, b| a.start.cmp(&b.start));
    (blocks, debug_blocks)
}
