//! # Dirichlet Energy Model
//!
//! Learns the user's energy distribution across tag classes for each
//! (day-of-week, hour) pair, derived on-the-fly from completed tasks.
//!
//! ## Structure
//!
//! Each Dirichlet `m ∈ {1..7} × hours` has concentration `ξ_m ∈ ℝ_{>0}^K`.
//!
//! The posterior mean `E[θ_{mk}] = ξ_{mk} / Σ_{k'} ξ_{mk'}` gives the fraction
//! of chunk m's capacity allocated to tag class k.
//!
//! ## Computation
//!
//! For each completed task, we compute `(dow, hour, tag, slots)` from
//! `completed_at`, then weight by `ρ^(weeks_since_completion)` for exponential
//! decay. The sum of weighted slots plus a uniform prior of 1.0 gives ξ.
//!
//! Half-life at ρ=0.95 ≈ 14 weeks. Old habits fade, new ones emerge.

use std::collections::HashMap;
use anyhow::Result;
use chrono::Timelike;
use sqlx::sqlite::SqlitePool;

use crate::scheduler::RHO;

/// Computes the Dirichlet state from completed tasks.
///
/// Returns a map: `(dow, start_hour, tag) → ξ`.
/// `start_hour` is the wall-clock hour at the beginning of the chunk (0, 4, 8, ...).
/// Missing entries default to 1.0 (or 10.0 for __untagged__) in the solver.
///
/// Each completed task contributes `effort_slots × ρ^(weeks_since_completion)`
/// to its `(dow, hour, tag)` bucket, plus a prior of 1.0 per bucket.
pub async fn load_dirichlet(
    pool: &SqlitePool,
    hours_per_chunk: usize,
) -> Result<HashMap<(usize, usize, String), f64>> {
    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT completed_at, tags, effort FROM tasks WHERE completed_at IS NOT NULL"
    ).fetch_all(pool).await?;

    let now = chrono::Local::now();
    let mut state: HashMap<(usize, usize, String), f64> = HashMap::new();

    for (completed_at, tags_json, effort) in rows {
        let dt = chrono::DateTime::parse_from_rfc3339(&completed_at)
            .map(|d| d.with_timezone(&chrono::Local))
            .or_else(|_| {
                chrono::NaiveDateTime::parse_from_str(&completed_at, "%Y-%m-%d %H:%M:%S")
                    .map(|d| d.and_local_timezone(chrono::Local).single().unwrap_or(now))
            });

        let dt = match dt {
            Ok(dt) => dt,
            Err(_) => continue,
        };

        let dow = dt.format("%u").to_string().parse::<usize>().unwrap_or(1);
        let hour = (dt.hour() as usize / hours_per_chunk) * hours_per_chunk;

        let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
        let tag = tags.into_iter().next().unwrap_or_else(|| "__untagged__".to_string());

        let slots = crate::scheduler::effort_to_slots(effort);

        let days_ago = now.signed_duration_since(dt).num_days().max(0) as f64;
        let weight = RHO.powf(days_ago / 7.0);

        // Prior of 1.0 is added on first insertion; subsequent observations accumulate
        state.entry((dow, hour, tag))
            .and_modify(|xi| *xi += slots * weight)
            .or_insert(1.0 + slots * weight);
    }

    Ok(state)
}
