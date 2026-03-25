//! # Dirichlet Energy Model
//!
//! Learns the user's energy distribution across tag classes for each
//! (day-of-week, hour) pair. Keyed by the wall-clock start hour of each
//! chunk (e.g. 0, 4, 8, 12, 16, 20 for the default 6-chunk grid).
//! This decouples the model from the chunk count — changing the grid
//! does not invalidate training data.
//!
//! ## Structure
//!
//! Each Dirichlet `m ∈ {1..7} × hours` has concentration `ξ_m ∈ ℝ_{>0}^K`.
//!
//! The posterior mean `E[θ_{mk}] = ξ_{mk} / Σ_{k'} ξ_{mk'}` gives the fraction
//! of chunk m's capacity allocated to tag class k. This multiplied by the physical
//! capacity C(c) gives the energy budget C_k(c).
//!
//! ## Update Rule
//!
//! When work is observed (task completed or day ends):
//!
//! ```text
//! ξ_{m(c), k}  ←  ρ · ξ_{m(c), k}  +  n_{ck}
//! ```
//!
//! where `n_{ck}` is the observed slots of class-k work in chunk c,
//! and `ρ = 0.95` is the exponential forgetting factor.
//!
//! Each (dow, hour) Dirichlet gets one observation per week.
//! Half-life ≈ 14 observations = 14 weeks. Old habits fade, new ones emerge.
//!
//! ## Initialization
//!
//! All ξ = 1 (uniform prior). No assumptions about energy patterns until
//! data arrives.

use std::collections::HashMap;
use anyhow::Result;
use sqlx::sqlite::SqlitePool;

use crate::scheduler::RHO;

/// Loads the full Dirichlet state from the database.
///
/// Returns a map: `(dow, start_hour, tag) → ξ`.
/// `start_hour` is the wall-clock hour at the beginning of the chunk (0, 4, 8, ...).
/// Missing entries default to 1.0 in the solver.
pub async fn load_dirichlet(pool: &SqlitePool) -> Result<HashMap<(usize, usize, String), f64>> {
    let rows: Vec<(i64, i64, String, f64)> = sqlx::query_as(
        "SELECT dow, hour, tag, xi FROM dirichlet_state"
    ).fetch_all(pool).await?;

    let mut state = HashMap::new();
    for (dow, hour, tag, xi) in rows {
        state.insert((dow as usize, hour as usize, tag), xi);
    }
    Ok(state)
}

/// Updates the Dirichlet state after observing work.
///
/// For each `(dow, start_hour, tag)` observation, applies the exponential
/// forgetting update: `ξ ← ρ · ξ + n`.
///
/// # Arguments
///
/// * `observations` — List of `(dow, start_hour, tag, observed_slots)`.
///   `start_hour` is the wall-clock hour at the beginning of the chunk (e.g. 0, 4, 8).
pub async fn update_dirichlet(
    pool: &SqlitePool,
    observations: &[(usize, usize, String, f64)],
) -> Result<()> {
    for (dow, hour, tag, n) in observations {
        // Upsert with exponential decay
        sqlx::query(
            "INSERT INTO dirichlet_state (dow, hour, tag, xi) VALUES (?, ?, ?, ?) \
             ON CONFLICT(dow, hour, tag) DO UPDATE SET xi = ? * xi + ?"
        )
        .bind(*dow as i64)
        .bind(*hour as i64)
        .bind(tag)
        .bind(1.0 + n) // initial: default 1.0 + observation
        .bind(RHO)
        .bind(*n)
        .execute(pool)
        .await?;
    }
    Ok(())
}
