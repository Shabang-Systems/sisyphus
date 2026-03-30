//! # Convex Task Scheduling: Urgency-Driven QP + Greedy Packing
//!
//! Two-phase scheduling: a convex QP produces dual variables that encode task
//! urgency, then a greedy packer assigns whole tasks to chunks using those duals
//! as priority scores. See `misc/convex_task_scheduling_v2.md` for the full spec.
//!
//! ## Units
//!
//! - **Slot**: 30 minutes of work. Tasks are measured in slots (1 slot = 30 min).
//! - **Chunk**: 4 hours of wall time. Each chunk holds up to 8 slots.
//!
//! ## Decision Variables
//!
//! - `x_{ic}` ∈ [0, 8]: slots of work on task `i` in chunk `c`.
//!
//! ## Objective (minimized)
//!
//! ```text
//! Σ_i Σ_c [ ε · x_{ic}²  −  r_i(c) · x_{ic} ]
//! ```
//!
//! - **ε · x²**: Regularizer (ε = 10⁻⁶) for strict convexity → unique duals.
//! - **−r(c) · x**: Urgency reward. `r_i(c) = α_k · T / max(tᶠ − c, 1)`.
//!   Inversely proportional to remaining slack. Blows up near deadline (capped at T).
//!
//! The primal is discarded. Only duals matter.
//!
//! ## Constraints
//!
//! - **(C1)** Chunk capacity: `Σ_i x_{ic} ≤ C(c)`.
//! - **(C2)** Energy by tag: `Σ_{i: k_i=k} x_{ic} ≤ C_k(c)` (Dirichlet-learned).
//! - **(C3)** Work completion: `Σ_c x_{ic} = w_i`.
//! - **(C4)** Feasibility window: vars not instantiated for `c ∉ [t_s, t_f]`.
//! - **(C5)** Precedence: fractional completion of parent ≥ child at every chunk.
//! - **(C6)** Bounds: `x ∈ [0, 8]`.
//!
//! ## Priority Score (from KKT conditions)
//!
//! ```text
//! Λ_{ic} = r_i(c) + ν_i − μ_c − η_{k_i,c}
//! ```
//!
//! ## Greedy Packing
//!
//! **Pass 1** (energy-aware): sort by Λ descending, assign respecting both
//! physical capacity and Dirichlet energy budgets.
//!
//! **Pass 2** (energy-ignored): remaining tasks placed in first available chunk
//! with physical capacity, ignoring energy budgets.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Default planning horizon in days.
const DEFAULT_HORIZON_DAYS: usize = 14;

/// Default number of chunks per day (24h / 4h = 6).
const DEFAULT_CHUNKS_PER_DAY: usize = 6;

/// Runtime-configurable grid parameters for the scheduling horizon.
///
/// The scheduler divides each day into equal-length chunks. Each chunk holds
/// `hours_per_chunk * 2` slots (1 slot = 30 minutes).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkConfig {
    /// Number of equal-length time blocks per day. Must divide 24 evenly.
    pub chunks_per_day: usize,
    /// Planning horizon in days.
    pub horizon_days: usize,
    /// Human-readable labels for each chunk (length must equal `chunks_per_day`).
    pub labels: Vec<String>,
}

impl Default for ChunkConfig {
    fn default() -> Self {
        Self {
            chunks_per_day: DEFAULT_CHUNKS_PER_DAY,
            horizon_days: DEFAULT_HORIZON_DAYS,
            labels: vec![
                "midnight".into(), "dawn".into(), "morning".into(),
                "afternoon".into(), "evening".into(), "night".into(),
            ],
        }
    }
}

impl ChunkConfig {
    /// Total chunks in the planning horizon.
    pub fn total_chunks(&self) -> usize {
        self.chunks_per_day * self.horizon_days
    }
    /// Hours per chunk (e.g. 4 when chunks_per_day = 6).
    pub fn hours_per_chunk(&self) -> usize {
        24 / self.chunks_per_day
    }
    /// Maximum slots per chunk (hours_per_chunk * 2, since 1 slot = 30 min).
    pub fn slots_per_chunk(&self) -> f64 {
        (self.hours_per_chunk() * 2) as f64
    }
}

/// Dirichlet forgetting factor. Each (dow, chunk) Dirichlet gets one observation
/// per week. ρ = 0.95 gives a half-life of ≈14 observations = 14 weeks.
pub const RHO: f64 = 0.95;

/// Maps the user-facing T-shirt effort size to work requirement in slots.
///
/// | Effort | Label | Slots | Wall time |
/// |--------|-------|-------|-----------|
/// | 0      | —     | 0     | (skip)    |
/// | 1      | XS    | 1     | 30 min    |
/// | 2      | S     | 2     | 1 hr      |
/// | 3      | M     | 4     | 2 hr      |
/// | 4      | L     | 8     | 4 hr      |
/// | 5      | XL    | 16    | 8 hr      |
///
/// Powers of 2 spacing matches Weber-Fechner perception of proportional differences.
/// Maps the user-facing T-shirt effort size to work requirement in slots.
/// Effort 0 (unset) defaults to S (2 slots / 1 hour).
pub fn effort_to_slots(effort: i64) -> f64 {
    match effort {
        1 => 1.0,
        2 => 2.0,
        3 => 4.0,
        4 => 8.0,
        5 => 16.0,
        _ => 2.0, // default: S
    }
}

/// A task prepared for the scheduler. All dates are pre-mapped to chunk indices.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskInput {
    /// Unique task identifier.
    pub id: String,
    /// Work required in slots. May be debiased by NB Model 1.
    pub w: f64,
    /// Earliest chunk index this task can be worked on (from `start_date`). 0-based.
    pub t_s: usize,
    /// Latest chunk index this task must complete by (from `due_date`). 0-based.
    /// Set to `TOTAL_CHUNKS - 1` if no deadline.
    pub t_f: usize,
    /// Tag class for energy budgeting and per-tag cost parameters.
    pub tag: String,
    /// Parent task ID for precedence constraint (from `parent_id` reply chain).
    /// If set, this task's fractional completion cannot exceed the parent's.
    pub parent_id: Option<String>,
    /// Human-readable task name for display.
    pub name: String,
    /// Current scheduled chunk (for stability seeding). None if unscheduled.
    pub current_chunk: Option<usize>,
}

impl TaskInput {
    /// Build a TaskInput, expanding [t_s, t_f] so the window always contains
    /// at least one chunk with non-zero capacity.
    pub fn new(
        id: String, w: f64, t_s: usize, t_f: usize,
        tag: String, parent_id: Option<String>, name: String,
        start_h: usize, current_chunk: Option<usize>,
        cfg: &ChunkConfig,
    ) -> Self {
        let total_chunks = cfg.total_chunks();
        let t_f = t_f.min(total_chunks - 1);
        let (t_s, t_f) = ensure_capacity(t_s, t_f, start_h, cfg);
        Self { id, w, t_s, t_f, tag, parent_id, name, current_chunk }
    }
}

/// Expand [t_s, t_f] outward until at least one chunk in the range has capacity.
fn ensure_capacity(t_s: usize, t_f: usize, _start_h: usize, cfg: &ChunkConfig) -> (usize, usize) {
    let total_chunks = cfg.total_chunks();
    let spc = cfg.slots_per_chunk();
    if (t_s..=t_f).any(|_c| spc > 0.0) {
        return (t_s, t_f);
    }
    let mid = (t_s + t_f) / 2;
    let mut lo = mid;
    let mut hi = mid;
    loop {
        if lo > 0 { lo -= 1; }
        if hi < total_chunks - 1 { hi += 1; }
        if spc > 0.0 {
            return (lo, hi);
        }
        if lo == 0 && hi >= total_chunks - 1 {
            return (0, total_chunks - 1);
        }
    }
}

/// Solver output for a single chunk: which tasks are allocated and how many slots each.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkAllocation {
    /// Chunk index (0-based) in the planning horizon.
    pub chunk: usize,
    /// Day index (0-based) this chunk belongs to.
    pub day: usize,
    /// Wall-clock hour this chunk starts at (0, 4, 8, 12, 16, 20).
    pub hour_start: usize,
    /// Tasks allocated in this chunk: `(task_id, slots)`.
    pub tasks: Vec<(String, f64)>,
}

/// Per-task scheduling diagnostics from the solver.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskScheduleInfo {
    /// Task ID.
    pub id: String,
    /// Human-readable name.
    pub name: String,
    /// Work required (slots), after NB Model 1 debiasing.
    pub w: f64,
    /// Tag class.
    pub tag: String,
    /// Feasibility window [t_s, t_f].
    pub t_s: usize,
    pub t_f: usize,
    /// α_k for this task's tag.
    pub alpha: f64,
    /// Deadline pressure = w / window_size.
    pub pressure: f64,
    /// Completion pressure dual variable ν_i. Positive when the task barely fits
    /// in its feasibility window. Zero when there is ample slack.
    pub completion_pressure: f64,
    /// Total slots allocated across all chunks.
    pub total_allocated: f64,
    /// Priority scores Λ_{ic} per chunk with formula breakdown.
    /// (chunk, Λ, r_ic, ν_i, μ_c, η_kc)
    pub priority_scores: Vec<(usize, f64, f64, f64, f64, f64)>,
}

/// Dual variable diagnostics for the debug view.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DualInfo {
    /// Marginal value of time at each chunk: `(chunk, μ_c)`.
    /// How much the objective would improve with one more free slot at chunk c.
    pub time_prices: Vec<(usize, f64)>,
    /// Marginal value of tag-class energy: `(chunk, tag, η_{kc})`.
    /// How much the objective would improve with one more slot of class-k energy.
    pub energy_prices: Vec<(usize, String, f64)>,
}

/// Complete solver output, suitable for serialization to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerOutput {
    /// Per-chunk allocations (only chunks with non-zero work).
    pub allocations: Vec<ChunkAllocation>,
    /// Per-task diagnostics.
    pub task_info: Vec<TaskScheduleInfo>,
    /// Task IDs that are optimally parked (Λ_{ic} ≤ 0 everywhere, zero allocation).
    pub parked: Vec<String>,
    /// Dual variable diagnostics.
    pub duals: DualInfo,
    /// Planning horizon length in days.
    pub horizon_days: usize,
    /// Chunks per day.
    pub chunks_per_day: usize,
    /// Errors/warnings from the solver.
    pub errors: Vec<String>,
    /// Debug trace: raw QP priority density per (task_name, chunk) — continuous x_{ic} values.
    pub raw_priorities: Vec<(String, usize, f64)>,
    /// Debug trace: greedy packing order — (step, task_name, chunk, slots_assigned).
    pub packing_trace: Vec<(usize, String, usize, f64)>,
    /// Tag classes used in scheduling.
    pub tag_set: Vec<String>,
    /// Per-tag energy caps: `energy_caps[tag_index]` = Vec of capacity per chunk.
    pub energy_caps: Vec<Vec<f64>>,
    /// Physical capacity per chunk (after calendar/locked deductions).
    pub chunk_caps: Vec<f64>,
    /// Starting within-day chunk position (0–5).
    pub start_h: usize,
    /// Raw Dirichlet ξ values: `dirichlet_xi[tag_index][chunk]`.
    pub dirichlet_xi: Vec<Vec<f64>>,
    /// Dirichlet posterior mean (normalized): `dirichlet_mean[tag_index][chunk]`.
    pub dirichlet_mean: Vec<Vec<f64>>,
}

/// Per-tag cost parameters. These control the solver's scheduling behavior:
///
/// - `α_k`: How expensive it is, per chunk, to leave class-k work undone.
///   Higher α → more urgency, earlier scheduling.
/// - `β_k`: How expensive it is to concentrate class-k work into dense chunks.
///   Higher β → thinner spreading. Lower β → dense deep-work blocks.
/// - `γ`: Global focus penalty. How expensive it is to put one more task on a day's
///   schedule. Higher γ → fewer tasks per day, more focused days.
#[derive(Debug, Clone)]
pub struct SchedulerParams {
    /// Per-tag delay cost α_k. Default 1.0 for unknown tags.
    pub alpha: HashMap<String, f64>,
    /// Per-tag concentration cost β_k. Default 1.0 for unknown tags.
    pub beta: HashMap<String, f64>,
    /// Global daily task activation penalty.
    pub gamma: f64,
}

impl Default for SchedulerParams {
    fn default() -> Self {
        Self {
            alpha: HashMap::new(),
            beta: HashMap::new(),
            // γ must be large enough relative to delay reward r_i(c) = α·(t_f - c)
            // to meaningfully limit tasks per day. With α=1.0 and horizon=84 chunks,
            // r ranges 0–84. γ=30 means adding a 5th task to a day costs 30,
            // which competes with the ~40 delay reward difference between today and tomorrow.
            gamma: 3.0,
        }
    }
}

impl SchedulerParams {
    fn alpha_for(&self, tag: &str) -> f64 {
        *self.alpha.get(tag).unwrap_or(&1.0)
    }
    #[allow(dead_code)]
    fn beta_for(&self, tag: &str) -> f64 {
        *self.beta.get(tag).unwrap_or(&0.01)
    }
}

/// Preference reward r_i(c) — single source of truth.
///
/// r_i(c) = α_k · e_k(c)
///
/// Pure preference signal: the scheduler values placing work where the user
/// is most productive (high Dirichlet efficiency). Deadlines are enforced
/// by the feasibility window [tˢ, tᶠ] — tasks simply cannot be assigned
/// outside their window. Urgency is handled by ν (completion pressure dual):
/// tight windows → high ν → high Λ, without needing 1/slack in the reward.
fn delay_reward(alpha: f64, eff: f64) -> f64 {
    alpha * eff
}

/// Returns the absolute wall-clock hour position (0..chunks_per_day-1) for a
/// chunk index, given the starting offset `start_h`.
///
/// Chunk 0 maps to `start_h`. The first `chunks_per_day - start_h` chunks fill
/// the rest of today. Subsequent chunks start at position 0 for each new day.
fn abs_hour_pos(chunk_index: usize, start_h: usize, cfg: &ChunkConfig) -> usize {
    let remaining_today = cfg.chunks_per_day - start_h;
    if chunk_index < remaining_today {
        start_h + chunk_index
    } else {
        (chunk_index - remaining_today) % cfg.chunks_per_day
    }
}

/// Returns the base capacity C(c) for a given chunk.
///
/// All chunks start at full capacity. Calendar busy blocks and
/// locked/completed tasks subtract from this via `capacity_used`.
fn get_chunk_capacity(cfg: &ChunkConfig) -> f64 {
    cfg.slots_per_chunk()
}

/// Maps a chunk index to the wall-clock hour it starts at.
fn chunk_to_hour(chunk_index: usize, start_h: usize, cfg: &ChunkConfig) -> usize {
    abs_hour_pos(chunk_index, start_h, cfg) * cfg.hours_per_chunk()
}

/// Maps a chunk index to which day offset (0 = today, 1 = tomorrow, ...).
fn chunk_to_day(chunk_index: usize, start_h: usize, cfg: &ChunkConfig) -> usize {
    let remaining_today = cfg.chunks_per_day - start_h;
    if chunk_index < remaining_today {
        0
    } else {
        1 + (chunk_index - remaining_today) / cfg.chunks_per_day
    }
}

/// Maps a chunk index to day-of-week (1=Mon, 7=Sun).
fn chunk_to_dow(chunk_index: usize, start_dow: usize, start_h: usize, cfg: &ChunkConfig) -> usize {
    let day = chunk_to_day(chunk_index, start_h, cfg);
    ((start_dow + day - 1) % 7) + 1
}

/// Solves the convex QP task scheduling problem.
///
/// # Arguments
///
/// * `tasks` — Active tasks with pre-computed effort, windows, tags, and precedence.
/// * `dirichlet` — Dirichlet concentration parameters ξ_{mk} keyed by `(dow, chunk_pos, tag)`.
///   Used to compute per-tag energy budgets C_k(c). Missing entries default to ξ=1 (uniform).
/// * `params` — Scheduling parameters (α, β, γ).
/// * `start_dow` — Day-of-week for chunk 0 (1=Monday, 7=Sunday).
///
/// # Returns
///
/// A [`SchedulerOutput`] containing per-chunk allocations, per-task diagnostics,
/// parked task list, and dual variable information.
///
/// # Algorithm
///
/// 1. Build variable mapping: only instantiate x_{ic} for chunks where task i
///    is feasible (c ∈ [t_s, t_f]) and the chunk has capacity (C(c) > 0).
/// 2. Construct the QP matrices P (diagonal quadratic), q (linear), A (constraints).
/// 3. Call OSQP to solve.
/// 4. Extract primal solution (allocations) and dual variables (priority scores).
pub fn solve(
    tasks: &[TaskInput],
    dirichlet: &HashMap<(usize, usize, String), f64>,
    params: &SchedulerParams,
    start_dow: usize,
    start_h: usize, // within-day chunk position of chunk 0
    capacity_used: &[f64], // pre-consumed slots per chunk (from completed/locked tasks)
    cfg: &ChunkConfig,
) -> SchedulerOutput {
    let total_chunks = cfg.total_chunks();
    let slots_per_chunk = cfg.slots_per_chunk();

    let n = tasks.len();
    if n == 0 {
        return SchedulerOutput {
            allocations: vec![], task_info: vec![], parked: vec![],
            duals: DualInfo { time_prices: vec![], energy_prices: vec![] },
            horizon_days: cfg.horizon_days, chunks_per_day: cfg.chunks_per_day,
            errors: vec!["No schedulable tasks found.".to_string()],
            raw_priorities: vec![], packing_trace: vec![],
            tag_set: vec![], energy_caps: vec![], chunk_caps: vec![],
            start_h,
            dirichlet_xi: vec![], dirichlet_mean: vec![],
        };
    }

    // ──────────────────────────────────────────────────────────────────────
    // Phase 1: Collect tag classes and compute chunk capacities
    // ──────────────────────────────────────────────────────────────────────

    let mut tag_set: Vec<String> = tasks.iter().map(|t| t.tag.clone()).collect();
    tag_set.sort();
    tag_set.dedup();
    let tag_idx: HashMap<String, usize> = tag_set.iter().enumerate()
        .map(|(i, t)| (t.clone(), i)).collect();
    let n_tags = tag_set.len();

    // C(c): physical capacity from calendar, minus pre-consumed slots
    let cap: Vec<f64> = (0..total_chunks).map(|c| {
        let raw = get_chunk_capacity(cfg);
        let used = if c < capacity_used.len() { capacity_used[c] } else { 0.0 };
        (raw - used).max(0.0)
    }).collect();

    // ξ_k(c): raw Dirichlet concentration parameters per tag per chunk.
    // Used to compute efficiency multipliers e_k(c) = ξ_k(c) / ξ̄_k,
    // where ξ̄_k is the mean of ξ_k across all chunks in the horizon.
    let mut dir_xi: Vec<Vec<f64>> = vec![vec![0.0; total_chunks]; n_tags];
    let mut dir_mean: Vec<Vec<f64>> = vec![vec![0.0; total_chunks]; n_tags];
    // energy_cap kept for diagnostic output only (not used in constraints)
    let mut energy_cap: Vec<Vec<f64>> = vec![vec![0.0; total_chunks]; n_tags];
    for c in 0..total_chunks {
        let dow = chunk_to_dow(c, start_dow, start_h, cfg);
        let h = abs_hour_pos(c, start_h, cfg) * cfg.hours_per_chunk(); // wall-clock start hour for Dirichlet lookup

        let xi_vals: Vec<f64> = tag_set.iter()
            .map(|tag| {
                let default = if tag == "__untagged__" { 10.0 } else { 1.0 };
                dirichlet.get(&(dow, h, tag.clone())).copied().unwrap_or(default)
            })
            .collect();
        let xi_sum: f64 = xi_vals.iter().sum();
        for k in 0..n_tags {
            dir_xi[k][c] = xi_vals[k];
            dir_mean[k][c] = xi_vals[k] / xi_sum;
            if cap[c] > 0.0 {
                energy_cap[k][c] = dir_mean[k][c] * cap[c];
            }
        }
    }

    // Efficiency multiplier: e_k(c) = ξ_k(c) / ξ̄_k
    // Normalized per-tag across chunks so that e > 1 at preferred times
    // (fewer physical slots needed) and e < 1 at non-preferred times.
    // Clamped to [0.2, 5.0] to prevent extreme stretching or compression.
    let mut efficiency: Vec<Vec<f64>> = vec![vec![1.0; total_chunks]; n_tags];
    for k in 0..n_tags {
        let xi_mean: f64 = dir_xi[k].iter().sum::<f64>() / total_chunks as f64;
        if xi_mean > 1e-9 {
            for c in 0..total_chunks {
                efficiency[k][c] = (dir_xi[k][c] / xi_mean).clamp(0.2, 5.0);
            }
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    // Phase 2: Build variable mapping
    // ──────────────────────────────────────────────────────────────────────
    //
    // x_{ic} variables are only instantiated for (task, chunk) pairs where:
    // - chunk c is in the task's feasibility window [t_s, t_f]
    // - chunk c has non-zero capacity
    //
    // z_{id} variables are instantiated for all (task, day) pairs.

    let mut x_vars: Vec<(usize, usize)> = vec![]; // (task_idx, chunk_idx)
    let mut x_var_map: HashMap<(usize, usize), usize> = HashMap::new();

    for (i, task) in tasks.iter().enumerate() {
        for c in task.t_s..=task.t_f.min(total_chunks - 1) {
            if cap[c] > 0.0 {
                let var_idx = x_vars.len();
                x_vars.push((i, c));
                x_var_map.insert((i, c), var_idx);
            }
        }
    }

    let n_x = x_vars.len();
    let n_vars = n_x; // No separate z variables — sparsity penalty folded into q

    // ──────────────────────────────────────────────────────────────────────
    // Phase 3: Build P matrix (Hessian)
    // ──────────────────────────────────────────────────────────────────────
    //
    // P is diagonal:
    //   P[x_{ic}, x_{ic}] = 2·β_{k_i}   (concentration cost quadratic term)

    // Small positive β ensures strict convexity (unique solution) and
    // The QP's job is to produce dual variables, not a usable primal.
    // Tiny regularizer for strict convexity (unique duals).
    let p_diag = vec![1e-6; n_vars];

    // ──────────────────────────────────────────────────────────────────────
    // Phase 4: Build q vector (linear cost)
    // ──────────────────────────────────────────────────────────────────────
    //
    // q[x_{ic}] = −r_i(c) = −α_k · e_k(c) · T / max(tᶠ − c, 1)
    //
    // See delay_reward() for the formula. Pure preference: α · e_k(c).

    let mut q = vec![0.0; n_vars];
    for (var, &(i, c)) in x_vars.iter().enumerate() {
        let k = tag_idx[&tasks[i].tag];
        let r_ic = delay_reward(params.alpha_for(&tasks[i].tag), efficiency[k][c]);
        q[var] = -r_ic;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Phase 5: Build constraint matrix A and bounds [l, u]
    // ──────────────────────────────────────────────────────────────────────

    let task_id_to_idx: HashMap<String, usize> = tasks.iter().enumerate()
        .map(|(i, t)| (t.id.clone(), i)).collect();

    // Precedence pairs from parent_id DAG
    let mut prec_pairs: Vec<(usize, usize)> = vec![];
    for (j, task) in tasks.iter().enumerate() {
        if let Some(ref pid) = task.parent_id {
            if let Some(&i) = task_id_to_idx.get(pid) {
                prec_pairs.push((i, j));
            }
        }
    }

    // Constraint counts
    let n_c1 = total_chunks;                         // chunk capacity
    // C2 (energy by tag) removed — Dirichlet preference now enters via objective
    let n_c2 = 0;
    let n_c3 = n;                                    // work completion
    let n_c5 = prec_pairs.len() * total_chunks;     // precedence
    let n_bounds = n_vars;                           // variable bounds [0, 8]
    let n_constraints = n_c1 + n_c3 + n_c5;
    let total_rows = n_constraints + n_bounds;

    // Build A in COO (row, col, val) then assemble into dense column-major
    let mut coo: Vec<(usize, usize, f64)> = vec![];
    let mut l_bounds: Vec<f64> = Vec::with_capacity(total_rows);
    let mut u_bounds: Vec<f64> = Vec::with_capacity(total_rows);
    let mut row = 0;

    // Precompute lookups: chunk → vars, task → vars
    let mut chunk_to_vars: Vec<Vec<usize>> = vec![vec![]; total_chunks];
    let mut task_to_vars: Vec<Vec<(usize, usize)>> = vec![vec![]; n]; // (var_idx, chunk)
    for (var, &(i, c)) in x_vars.iter().enumerate() {
        chunk_to_vars[c].push(var);
        task_to_vars[i].push((var, c));
    }

    // ── C1: Chunk capacity ──
    // Σ_i x_{ic} ≤ C(c) for all c
    for c in 0..total_chunks {
        for &var in &chunk_to_vars[c] {
            coo.push((row, var, 1.0));
        }
        l_bounds.push(f64::NEG_INFINITY);
        u_bounds.push(cap[c]);
        row += 1;
    }

    // C2 (energy by tag) removed — Dirichlet preference now enters via
    // efficiency-scaled work completion (C3).

    // ── C3: Work completion (equality) ──
    // Σ_c x_{ic} = w_i for all i
    //
    // Dirichlet efficiency enters the objective (r × e), not this constraint.
    for i in 0..n {
        let w = tasks[i].w;
        for &(var, _) in &task_to_vars[i] {
            coo.push((row, var, 1.0));
        }
        l_bounds.push(w);
        u_bounds.push(w);
        row += 1;
    }

    // ── C5: Precedence ──
    // For (i,j) ∈ 𝒫, for all c:
    //   (1/w_i) Σ_{τ≤c} x_{iτ}  −  (1/w_j) Σ_{τ≤c} x_{jτ}  ≥  0
    //
    // Uses x_var_map for O(1) lookup instead of scanning all vars.
    for &(i, j) in &prec_pairs {
        let w_i = tasks[i].w;
        let w_j = tasks[j].w;

        for c in 0..total_chunks {
            if w_i > 0.0 && w_j > 0.0 {
                // Cumulative: all vars for task i with chunk ≤ c
                for &(var, vc) in &task_to_vars[i] {
                    if vc <= c { coo.push((row, var, 1.0 / w_i)); }
                }
                for &(var, vc) in &task_to_vars[j] {
                    if vc <= c { coo.push((row, var, -1.0 / w_j)); }
                }
            }
            l_bounds.push(0.0);
            u_bounds.push(f64::INFINITY);
            row += 1;
        }
    }

    // C6 (activation coupling) removed — sparsity penalty folded into q vector.

    assert_eq!(row, n_constraints);

    // ── C7: Variable bounds ──
    // 0 ≤ x_{ic} ≤ 8, 0 ≤ z_{id} ≤ 8
    // OSQP doesn't have native variable bounds; we add identity rows.
    for v in 0..n_vars {
        coo.push((n_constraints + v, v, 1.0));
        l_bounds.push(0.0);
        u_bounds.push(slots_per_chunk);
    }

    // ──────────────────────────────────────────────────────────────────────
    // Phase 6: Assemble OSQP sparse matrices and solve
    // ──────────────────────────────────────────────────────────────────────

    // P: diagonal — direct CSC construction. O(n) not O(n²).
    let p_csc = {
        let mut indptr = Vec::with_capacity(n_vars + 1);
        let mut indices = Vec::with_capacity(n_vars);
        let mut data = Vec::with_capacity(n_vars);
        indptr.push(0);
        for col in 0..n_vars {
            if p_diag[col] != 0.0 {
                indices.push(col);
                data.push(p_diag[col]);
            }
            indptr.push(indices.len());
        }
        osqp::CscMatrix {
            nrows: n_vars, ncols: n_vars,
            indptr: std::borrow::Cow::Owned(indptr),
            indices: std::borrow::Cow::Owned(indices),
            data: std::borrow::Cow::Owned(data),
        }.into_upper_tri()
    };

    // A: COO → CSC via direct construction. O(nnz log nnz) not O(rows × cols).
    let a_csc = {
        let mut col_entries: Vec<HashMap<usize, f64>> = vec![HashMap::new(); n_vars];
        for &(r, c, v) in &coo {
            *col_entries[c].entry(r).or_default() += v;
        }
        let mut indptr = Vec::with_capacity(n_vars + 1);
        let mut indices = Vec::new();
        let mut data = Vec::new();
        indptr.push(0);
        for col in 0..n_vars {
            let mut entries: Vec<(usize, f64)> = col_entries[col].drain().collect();
            entries.sort_by_key(|&(r, _)| r);
            for (r, v) in entries {
                indices.push(r);
                data.push(v);
            }
            indptr.push(indices.len());
        }
        osqp::CscMatrix {
            nrows: total_rows, ncols: n_vars,
            indptr: std::borrow::Cow::Owned(indptr),
            indices: std::borrow::Cow::Owned(indices),
            data: std::borrow::Cow::Owned(data),
        }
    };

    let settings = osqp::Settings::default()
        .verbose(false)
        .max_iter(20000)
        .eps_abs(1e-2)
        .eps_rel(1e-2)
        .polishing(true)
        .time_limit(Some(std::time::Duration::from_secs(30)));

    // Pre-flight: check total capacity vs total work
    let total_cap: f64 = cap.iter().sum();
    let total_work: f64 = tasks.iter()
        .map(|t| t.w)
        .sum();

    let mut output = SchedulerOutput {
        allocations: vec![], task_info: vec![], parked: vec![],
        duals: DualInfo { time_prices: vec![], energy_prices: vec![] },
        horizon_days: cfg.horizon_days, chunks_per_day: cfg.chunks_per_day,
        errors: vec![],
        raw_priorities: vec![],
        packing_trace: vec![],
        tag_set: tag_set.clone(),
        energy_caps: energy_cap.clone(),
        chunk_caps: cap.clone(),
        start_h,
        dirichlet_xi: dir_xi.clone(),
        dirichlet_mean: dir_mean.clone(),
    };

    if total_work > total_cap {
        output.errors.push(format!(
            "Total work ({:.0} slots / {:.0}h) exceeds total capacity ({:.0} slots / {:.0}h). Some tasks cannot be scheduled.",
            total_work, total_work * 0.5, total_cap, total_cap * 0.5
        ));
    }

    if n_vars == 0 {
        output.errors.push("No feasible (task, chunk) pairs — all tasks may be outside available hours.".to_string());
        return output;
    }

    match osqp::Problem::new(p_csc, &q, a_csc, &l_bounds, &u_bounds, &settings) {
        Ok(mut prob) => {
            match prob.solve() {
                osqp::Status::Solved(s) | osqp::Status::SolvedInaccurate(s) => {
                    let y = s.y();

                    // Step 2: Compute Λ_{ic} = r_i(c) + ν_i − μ_c − η_{k_i,c}
                    let lambda = compute_lambda(&x_vars, tasks, params, &tag_idx, &efficiency, n_c1, n_c2, y);
                    for &(i, c, l) in &lambda {
                        if l > 0.01 {
                            output.raw_priorities.push((tasks[i].name.clone(), c, l));
                        }
                    }

                    // Step 3: Greedy pack using Λ directly.
                    let (schedule, trace) = greedy_pack_lambda(&lambda, tasks, &cap, n);
                    output.packing_trace = trace;
                    build_output_from_schedule(&schedule, &x_vars, tasks, params,
                        &tag_set, &efficiency, n_c1, n_c2, start_h, &s, &mut output, cfg);
                },
                osqp::Status::PrimalInfeasible(_) => {
                    output.errors.push("QP is infeasible: cannot satisfy all task deadlines + capacity constraints simultaneously. Try relaxing deadlines or reducing task sizes.".to_string());
                    // Still populate task_info for diagnostics
                    for task in tasks {
                        let w = task.w;
                        output.task_info.push(TaskScheduleInfo {
                            id: task.id.clone(), name: task.name.clone(), w,
                            tag: task.tag.clone(), t_s: task.t_s, t_f: task.t_f,
                            alpha: params.alpha_for(&task.tag),
                            pressure: task.w / (task.t_f as f64 - task.t_s as f64).max(1.0),
                            completion_pressure: 0.0,
                            total_allocated: 0.0, priority_scores: vec![],
                        });
                        output.parked.push(task.id.clone());
                    }
                },
                osqp::Status::MaxIterationsReached(s) | osqp::Status::TimeLimitReached(s) => {
                    output.errors.push("Solver hit time/iteration limit. Using partial duals.".to_string());
                    let y = s.y();
                    let lambda = compute_lambda(&x_vars, tasks, params, &tag_idx, &efficiency, n_c1, n_c2, y);
                    for &(i, c, l) in &lambda {
                        if l > 0.01 { output.raw_priorities.push((tasks[i].name.clone(), c, l)); }
                    }
                    let (schedule, trace) = greedy_pack_lambda(&lambda, tasks, &cap, n);
                    output.packing_trace = trace;
                    build_output_from_schedule(&schedule, &x_vars, tasks, params,
                        &tag_set, &efficiency, n_c1, n_c2, start_h, &s, &mut output, cfg);
                },
                other => {
                    output.errors.push(format!("Solver failed: {:?}", other));
                }
            }
        },
        Err(e) => {
            output.errors.push(format!("Problem creation failed: {:?}", e));
        },
    }

    output
}

// ── Dual variable extraction helpers ──

fn extract_mu(y: &[f64], c: usize) -> f64 {
    if c < y.len() { (-y[c]).max(0.0) } else { 0.0 }
}



fn extract_nu(y: &[f64], n_c1: usize, n_c2: usize, i: usize) -> f64 {
    let row = n_c1 + n_c2 + i;
    if row < y.len() { -y[row] } else { 0.0 }
}

/// Compute Λ_{ic} = r_i(c) + ν_i − μ_c for all (task, chunk) pairs.
///
/// r_i(c) already includes the efficiency multiplier e_k(c), so the
/// Dirichlet preference is baked into the urgency reward.
fn compute_lambda(
    x_vars: &[(usize, usize)],
    tasks: &[TaskInput],
    params: &SchedulerParams,
    tag_idx: &HashMap<String, usize>,
    efficiency: &[Vec<f64>],
    n_c1: usize,
    n_c2: usize,
    y: &[f64],
) -> Vec<(usize, usize, f64)> {
    x_vars.iter().map(|&(i, c)| {
        let k = tag_idx.get(&tasks[i].tag).copied().unwrap_or(0);
        let r_ic = delay_reward(params.alpha_for(&tasks[i].tag), efficiency[k][c]);
        let nu_i = extract_nu(y, n_c1, n_c2, i);
        let mu_c = extract_mu(y, c);
        (i, c, r_ic + nu_i - mu_c)
    }).collect()
}

/// Greedy packing driven by Λ_{ic} priority scores.
///
/// The QP's duals produce Λ_{ic} = r_i(c) + ν_i − μ_c − η_{k_i,c} for each
/// (task, chunk) pair. This score already accounts for deadlines, precedence,
/// energy, and capacity competition.
///
/// ## Algorithm
///
/// **Pass 1 (energy-aware)**: Sort all (task, chunk) pairs by Λ descending.
/// For each pair, assign work if both physical capacity AND tag energy budget
/// allow. This respects the Dirichlet-learned energy distribution.
///
/// **Pass 2 (energy-ignored)**: Any task still unfinished after pass 1 gets
/// packed into the first available chunk with physical capacity, ignoring
/// energy budgets. This ensures tasks are never parked when time exists.
///
/// Returns: `(assignments, trace)`.
fn greedy_pack_lambda(
    lambda: &[(usize, usize, f64)], // (task_idx, chunk, Λ)
    tasks: &[TaskInput],
    cap: &[f64],
    n: usize,
) -> (Vec<(usize, usize, f64)>, Vec<(usize, String, usize, f64)>) {
    // Sort ALL (task, chunk) pairs by Λ descending — don't filter out negatives.
    // A task with Λ < 0 in some chunk is still schedulable if its preferred
    // chunk fills up. The greedy will skip completed tasks and full chunks.
    // Add small stability bonus to prefer current schedule chunk (tiebreaker only)
    let stability_eps = 0.001;
    let mut pairs: Vec<(usize, usize, f64)> = lambda.iter().map(|&(i, c, l)| {
        let bonus = if tasks[i].current_chunk == Some(c) { stability_eps } else { 0.0 };
        (i, c, l + bonus)
    }).collect();
    pairs.sort_by(|a, b| {
        b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))  // same task grouped
            .then(a.1.cmp(&b.1))  // earlier chunk
    });

    let mut remaining_cap: Vec<f64> = cap.to_vec();
    // remaining_work tracks *effective* work (efficiency-scaled)
    let mut remaining_work: Vec<f64> = (0..n)
        .map(|i| tasks[i].w)
        .collect();

    let mut assigned: Vec<f64> = vec![0.0; n];
    let mut latest_chunk: Vec<Option<usize>> = vec![None; n];

    // Build parent index for precedence: task_idx → parent_task_idx
    let task_id_to_idx: HashMap<String, usize> = tasks.iter().enumerate()
        .map(|(i, t)| (t.id.clone(), i)).collect();
    let parent_of: Vec<Option<usize>> = tasks.iter()
        .map(|t| t.parent_id.as_ref().and_then(|pid| task_id_to_idx.get(pid).copied()))
        .collect();

    let mut schedule: Vec<(usize, usize, f64)> = vec![];
    let mut trace: Vec<(usize, String, usize, f64)> = vec![];
    let mut step = 0;

    // ── Greedy packing (no splitting) ──
    // Each task is assigned to exactly one chunk. Tasks are processed in
    // topological order (BFS from DAG roots) so parents are placed before
    // children. Within each BFS level, tasks are sorted by best Λ descending.

    // Build per-task Λ lookup: task_idx → vec of (chunk, Λ) sorted by Λ desc
    let mut task_lambdas: Vec<Vec<(usize, f64)>> = vec![vec![]; n];
    for &(ti, c, lambda) in &pairs {
        task_lambdas[ti].push((c, lambda));
    }
    for v in &mut task_lambdas {
        v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    }

    // BFS topological order: roots first, then children
    let mut children_of: Vec<Vec<usize>> = vec![vec![]; n];
    let mut in_degree: Vec<usize> = vec![0; n];
    for (i, p) in parent_of.iter().enumerate() {
        if let Some(pi) = p {
            children_of[*pi].push(i);
            in_degree[i] += 1;
        }
    }

    // Collect BFS levels
    let mut queue: Vec<usize> = (0..n).filter(|&i| in_degree[i] == 0).collect();
    let mut bfs_order: Vec<Vec<usize>> = vec![];
    while !queue.is_empty() {
        // Sort this level by best Λ descending
        queue.sort_by(|&a, &b| {
            let la = task_lambdas[a].first().map(|x| x.1).unwrap_or(f64::NEG_INFINITY);
            let lb = task_lambdas[b].first().map(|x| x.1).unwrap_or(f64::NEG_INFINITY);
            lb.partial_cmp(&la).unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut next_queue = vec![];
        for &ti in &queue {
            for &ci in &children_of[ti] {
                in_degree[ci] -= 1;
                if in_degree[ci] == 0 {
                    next_queue.push(ci);
                }
            }
        }
        bfs_order.push(std::mem::take(&mut queue));
        queue = next_queue;
    }

    // Place tasks level by level
    for level in &bfs_order {
        for &task_idx in level {
            let w = remaining_work[task_idx];
            if w <= 0.01 { continue; }

            // Precedence: child must be scheduled at or after parent's chunk
            let min_chunk = parent_of[task_idx]
                .and_then(|pi| latest_chunk[pi])
                .unwrap_or(0);

            // Find the best chunk (highest Λ) where this task fits entirely
            let mut best_chunk: Option<(usize, f64)> = None;
            for &(c, lambda) in &task_lambdas[task_idx] {
                if c < min_chunk { continue; } // must be at or after parent
                if c < tasks[task_idx].t_s || c > tasks[task_idx].t_f { continue; }
                if remaining_cap[c] < w - 0.01 { continue; }
                if best_chunk.is_none() || lambda > best_chunk.unwrap().1 {
                    best_chunk = Some((c, lambda));
                }
            }

            if let Some((c, _)) = best_chunk {
                schedule.push((task_idx, c, w));
                trace.push((step, tasks[task_idx].name.clone(), c, w));
                remaining_cap[c] -= w;
                remaining_work[task_idx] = 0.0;
                assigned[task_idx] = w;
                latest_chunk[task_idx] = Some(c);
                step += 1;
            }
        }
    }

    // Capacity check: verify no chunk is over-allocated
    let mut chunk_totals = vec![0.0f64; cap.len()];
    for &(_, c, slots) in &schedule {
        chunk_totals[c] += slots;
    }
    for (c, total) in chunk_totals.iter().enumerate() {
        if *total > cap[c] + 0.1 {
            eprintln!("CAPACITY VIOLATION: chunk {} has {:.1} slots allocated but cap is {:.1}", c, total, cap[c]);
        }
    }

    (schedule, trace)
}

/// Builds the [`SchedulerOutput`] from the greedy-packed discrete schedule.
fn build_output_from_schedule(
    schedule: &[(usize, usize, f64)],
    x_vars: &[(usize, usize)],
    tasks: &[TaskInput],
    params: &SchedulerParams,
    tag_set: &[String],
    efficiency: &[Vec<f64>],
    n_c1: usize,
    n_c2: usize,
    start_h: usize,
    sol: &osqp::Solution,
    output: &mut SchedulerOutput,
    cfg: &ChunkConfig,
) {
    let y = sol.y();

    // Per-chunk allocations
    let mut chunk_map: HashMap<usize, Vec<(String, f64)>> = HashMap::new();
    for &(task_idx, c, slots) in schedule {
        chunk_map.entry(c).or_default().push((tasks[task_idx].id.clone(), slots));
    }
    let mut chunks: Vec<usize> = chunk_map.keys().cloned().collect();
    chunks.sort();
    for c in chunks {
        output.allocations.push(ChunkAllocation {
            chunk: c,
            day: chunk_to_day(c, start_h, cfg),
            hour_start: chunk_to_hour(c, start_h, cfg),
            tasks: chunk_map.remove(&c).unwrap(),
        });
    }

    // Per-task diagnostics
    let mut task_allocated: HashMap<usize, f64> = HashMap::new();
    for &(task_idx, _, slots) in schedule {
        *task_allocated.entry(task_idx).or_default() += slots;
    }

    let tag_idx_map: HashMap<String, usize> = tag_set.iter().enumerate()
        .map(|(i, t)| (t.clone(), i)).collect();

    for (i, task) in tasks.iter().enumerate() {
        let total = task_allocated.get(&i).copied().unwrap_or(0.0);
        let w = task.w;
        let nu_i = extract_nu(y, n_c1, n_c2, i);
        let alpha = params.alpha_for(&task.tag);

        // (chunk, Λ, r_ic, ν_i, μ_c, e_kc)
        let mut scores: Vec<(usize, f64, f64, f64, f64, f64)> = vec![];
        for &(vi, c) in x_vars.iter() {
            if vi == i {
                let k = tag_idx_map.get(&task.tag).copied().unwrap_or(0);
                let e_kc = efficiency[k][c];
                let r_ic = delay_reward(alpha, e_kc);
                let mu_c = extract_mu(y, c);
                let l = r_ic + nu_i - mu_c;
                scores.push((c, l, r_ic, nu_i, mu_c, e_kc));
            }
        }

        if total < 0.01 {
            output.parked.push(task.id.clone());
        }

        let window = (task.t_f as f64 - task.t_s as f64).max(1.0);
        output.task_info.push(TaskScheduleInfo {
            id: task.id.clone(),
            name: task.name.clone(),
            w,
            tag: task.tag.clone(),
            t_s: task.t_s,
            t_f: task.t_f,
            alpha,
            pressure: task.w / window,
            completion_pressure: nu_i,
            total_allocated: total,
            priority_scores: scores,
        });
    }

    // Dual variables
    for c in 0..cfg.total_chunks() {
        if c < y.len() {
            let mu = (-y[c]).max(0.0);
            if mu > 0.01 { output.duals.time_prices.push((c, mu)); }
        }
    }
    // C2 (energy by tag) removed — no η duals to extract.
}

// Keep old extract_solution for reference but unused
