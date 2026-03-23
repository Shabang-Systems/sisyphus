//! # 42-Dirichlet Energy Model
//!
//! Learns the user's energy distribution across tag classes for each
//! (day-of-week, within-day-chunk) pair. 42 independent Dirichlet distributions
//! (7 days × 6 chunks per day), each with K concentration parameters (one per tag class).
//!
//! ## Structure
//!
//! Each Dirichlet `m ∈ {1..7} × {1..6}` has concentration `ξ_m ∈ ℝ_{>0}^K`.
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
//! Each (dow, chunk) Dirichlet gets one observation per week.
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
/// Returns a map: `(dow, chunk_position, tag) → ξ`.
/// Missing entries default to 1.0 in the solver.
pub async fn load_dirichlet(pool: &SqlitePool) -> Result<HashMap<(usize, usize, String), f64>> {
    let rows: Vec<(i64, i64, String, f64)> = sqlx::query_as(
        "SELECT dow, chunk, tag, xi FROM dirichlet_state"
    ).fetch_all(pool).await?;

    let mut state = HashMap::new();
    for (dow, chunk, tag, xi) in rows {
        state.insert((dow as usize, chunk as usize, tag), xi);
    }
    Ok(state)
}

/// Updates the Dirichlet state after observing work.
///
/// For each `(dow, chunk_position, tag)` observation, applies the exponential
/// forgetting update: `ξ ← ρ · ξ + n`.
///
/// # Arguments
///
/// * `observations` — List of `(dow, chunk_position, tag, observed_slots)`.
pub async fn update_dirichlet(
    pool: &SqlitePool,
    observations: &[(usize, usize, String, f64)],
) -> Result<()> {
    for (dow, chunk, tag, n) in observations {
        // Upsert with exponential decay
        sqlx::query(
            "INSERT INTO dirichlet_state (dow, chunk, tag, xi) VALUES (?, ?, ?, ?) \
             ON CONFLICT(dow, chunk, tag) DO UPDATE SET xi = ? * xi + ?"
        )
        .bind(*dow as i64)
        .bind(*chunk as i64)
        .bind(tag)
        .bind(1.0 + n) // initial: default 1.0 + observation
        .bind(RHO)
        .bind(*n)
        .execute(pool)
        .await?;
    }
    Ok(())
}
