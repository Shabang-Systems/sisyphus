# Convex Task Scheduling v2: Urgency-Driven QP + Greedy Packing

---

## Overview

Two-phase scheduling: a convex QP produces dual variables that encode task urgency, then a greedy packer assigns whole tasks to chunks using those duals as priority scores.

The QP's primal solution is discarded. Its only job is to compute the shadow prices of time, energy, and task completion — the information the greedy packer needs to make good discrete assignments.

---

## Units

- **Slot**: 30 minutes of work. Unit of effort.
- **Chunk**: 4 hours of wall time. Unit of scheduling. Each chunk holds ≤ 8 slots.

---

## Indices

- i ∈ {1, …, n}: tasks
- c ∈ {0, …, 6k−1}: chunks in the planning horizon (k = 14 days, 84 chunks)
- Chunk 0 = current 4-hour block. First `6 − h₀` chunks fill today (h₀ = current within-day position). Subsequent days start at position 0.

---

## Per-task data

| Symbol | Meaning | Source |
|--------|---------|--------|
| wᵢ | Work required (slots) | T-shirt size → {1, 2, 4, 8, 16}. Default S = 2. Debiased by NB Model 1. |
| tᵢˢ | Earliest chunk | start_date mapped to chunk index. 0 if none. |
| tᵢᶠ | Latest chunk | effective_due (earliest deadline in dependency chain) mapped to chunk index. 83 if none. |
| kᵢ | Tag class | User tag, or NB Model 2 posterior if untagged (threshold p > 0.3). |

---

## Parameters

| Symbol | Meaning | Default |
|--------|---------|---------|
| αₖ | Urgency multiplier for tag class k | 1.0 |
| C(c) | Available slots in chunk c | Base 8 slots per chunk, reduced by calendar busy blocks and locked/completed tasks. |
| Cₖ(c) | Energy budget for class k in chunk c | Dirichlet posterior mean × C(c) |

---

## Phase 1: QP for dual variables

### Decision variables

| Symbol | Meaning | Range |
|--------|---------|-------|
| xᵢ꜀ | Slots of work on task i in chunk c | [0, 8] |

Only instantiated for feasible (i, c) pairs where c ∈ [tᵢˢ, tᵢᶠ] and C(c) > 0.

### Delay reward

    rᵢ(c) = αₖᵢ · T / max(tᵢᶠ − c, 1)

where T = total chunks in horizon (84).

**Interpretation**: reward is inversely proportional to remaining slack. A task due in 2 chunks gets r = 84/2 = 42. A task due in 80 chunks gets r = 84/80 ≈ 1. A no-deadline task (tᵢᶠ = 83) at chunk 0 gets r = 84/83 ≈ 1.

The `max(·, 1)` caps the blowup — maximum r is T (84). This is safe for QP convexity because r appears only in the linear term q, not the Hessian. The Hessian is `2εI` regardless of r values.

**Why 1/slack works**: The carrying cost of leaving a task undone grows as the deadline approaches — each remaining chunk of inaction is more costly when fewer chunks remain. The marginal cost of delay at chunk c is proportional to 1/(tᶠ − c), matching the urgency reward.

### Objective

    min_x  Σᵢ Σ꜀ [ ε · xᵢ꜀²  −  rᵢ(c) · xᵢ꜀ ]

- **ε · x²**: Tiny regularizer (ε = 10⁻⁶) for strict convexity → unique dual variables. Has no material effect on the primal.
- **−r(c) · x**: Urgency reward. The solver allocates more to urgent tasks in early chunks.

The primal x values are discarded. The objective exists only to produce meaningful duals.

### Constraints

**(C1) Chunk capacity.**

    Σᵢ xᵢ꜀ ≤ C(c)    ∀c

Dual: μ꜀ ≥ 0. Marginal value of time at chunk c.

**(C2) Energy by tag class.**

    Σ{i: kᵢ=k} xᵢ꜀ ≤ Cₖ(c)    ∀c, ∀k

Dual: ηₖ꜀ ≥ 0. Marginal value of class-k energy at chunk c.

**(C3) Work completion (equality).**

    Σ꜀ xᵢ꜀ = wᵢ    ∀i

Equality prevents over-allocation. Dual: νᵢ. Completion pressure — positive when task i's window is tight relative to available capacity.

**(C4) Feasibility window.** Variables not instantiated for c ∉ [tᵢˢ, tᵢᶠ].

**(C5) Precedence.** For (i, j) where i is a parent of j (parent_id):

    (1/wᵢ) Σ{τ≤c} xᵢτ  −  (1/wⱼ) Σ{τ≤c} xⱼτ  ≥  0    ∀c

Task j's fractional completion cannot exceed task i's at any chunk.

**(C6) Bounds.** xᵢ꜀ ∈ [0, 8].

---

## Phase 2: Priority scores from KKT conditions

From the solved QP, extract dual variables and compute for each (i, c):

    Λᵢ꜀ = rᵢ(c) + νᵢ − μ꜀ − ηₖᵢ,꜀

where duals are read from the OSQP solution vector y:
- μ꜀ = max(−y[c], 0) — C1 dual (first TOTAL_CHUNKS rows)
- ηₖ꜀ = max(−y[n_c1 + k·T + c], 0) — C2 dual
- νᵢ = −y[n_c1 + n_c2 + i] — C3 dual (may be negative)

| Term | Effect |
|------|--------|
| rᵢ(c) | Urgency: up when deadline is near (1/slack), up when αₖ is high |
| νᵢ | Completion pressure: up when task barely fits in its window |
| μ꜀ | Time competition: down when chunk c is contested by many tasks |
| ηₖ,꜀ | Energy scarcity: down when class-k energy is scarce at chunk c |

Λᵢ꜀ > 0: this task-chunk pair is worth scheduling.
Λᵢ꜀ ≤ 0 for all c: task is optimally parked.

A small stability bonus (ε = 0.001) is added to Λ for a task's currently-scheduled chunk, acting as a tiebreaker to reduce schedule churn between solves.

---

## Phase 3: Greedy packing

The QP's continuous primal is discarded. The discrete schedule is built by greedy assignment using Λ as the priority signal.

### Algorithm

**Pass 1 (energy-aware):**

1. Collect ALL (i, c) pairs with their Λᵢ꜀ (including negatives — a task with Λ < 0 in some chunks is still schedulable if preferred chunks fill up).
2. Sort by Λᵢ꜀ descending. Tiebreak: same task index first, then earlier chunk.
3. For each (i, c) in sorted order:
   - Skip if task i has no remaining work.
   - Skip if chunk c has no remaining physical capacity.
   - Skip if chunk c has no remaining energy budget for task i's tag class.
   - Skip if c is outside task i's feasibility window [tᵢˢ, tᵢᶠ].
   - **Precedence check**: if task i has parent j, verify j's fractional completion ≥ i's. Skip if violated.
   - Assign min(wᵢ remaining, C(c) remaining, Cₖ(c) remaining) slots.

**Pass 2 (energy-ignored):**

Re-iterate the same Λ-sorted pairs. For tasks with remaining work, assign to chunks with physical capacity, ignoring energy budgets but still respecting precedence. Same Λ ordering ensures spillover tasks still land in their best chunks — they just aren't blocked by exhausted tag energy.

### Why this produces good schedules

- **Whole-task blocks**: Λᵢ꜀ for a given task i varies smoothly across chunks (earliness changes by 1 per chunk). So consecutive chunks for the same task have similar Λ, and the greedy fills adjacent chunks with the same task before moving to the next — producing contiguous blocks.

- **Natural focus**: Tasks with low Λ across all chunks never get reached before capacity runs out. No explicit sparsity penalty needed.

- **Deadline priority**: High-pressure tasks (tight deadline relative to work) get Λ values that dominate low-pressure tasks, ensuring they are packed first.

- **Capacity-aware**: The duals μ꜀ and ηₖ꜀ encode which chunks are most contested. The greedy respects this by preferring chunks where the task's Λ is highest (least contested + most urgent).

- **Energy-aware**: Pass 1 enforces Dirichlet-learned energy budgets. Pass 2 ensures no task is left unscheduled when time exists.

---

## Capacity model

All 6 daily chunks start at full capacity (8 slots). Availability is reduced by:

1. **Calendar busy blocks** — ICS calendar events subtract slots from the corresponding chunks.
2. **Locked tasks** — tasks manually pinned to a schedule date consume capacity.
3. **Completed tasks** — recently completed tasks consume capacity in their completion chunk.

Without calendars, all hours are available and the Dirichlet energy model alone governs tag distribution.

---

## Energy model: 42 Dirichlets

42 independent Dirichlet distributions, one per (day-of-week, within-day-chunk) pair. Each has K concentration parameters ξₘₖ (one per tag class k).

**Posterior mean**: E[θₘₖ] = ξₘₖ / Σₖ' ξₘₖ' — fraction of chunk m's capacity for tag k.

**Energy budget**: Cₖ(c) = E[θₘₖ] × C(c), where m = (dow(c), hour_pos(c)).

**Update rule** (on task completion): ξₘₖ ← ρ · ξₘₖ + n, where n = observed slots, ρ = 0.95.

**Initialization**: ξ = 1.0 (uniform). `__untagged__` gets ξ = 10.0 to prevent starvation.

**Training**: explicit training via the Training screen (Settings → Training) also calls update_dirichlet directly.

---

## NB Models

### Model 1: Duration debiasing

Table: `nb_duration (tag, size, total_observed, count)`. Learns actual duration per (tag, effort) pair from completed tasks. After ≥5 observations, debiased wᵢ replaces the raw T-shirt mapping.

Updated on task completion: Δ = (completed_at − schedule) in slots.

### Model 2: Tag prediction

Tables: `nb_tags (word, tag, count)`, `nb_tag_priors (tag, count)`. Multinomial Naive Bayes with Laplace smoothing predicts tag posterior p(k | text) for untagged tasks. Used when p > 0.3 to substitute a predicted tag for scheduling.

Updated on task tag changes and via explicit training (Settings → Training).

---

## Solver configuration

| Parameter | Value | Purpose |
|-----------|-------|---------|
| OSQP max_iter | 20,000 | Iteration limit |
| OSQP eps_abs/rel | 10⁻² | Convergence tolerance |
| OSQP polish | true | Solution refinement |
| OSQP time_limit | 30s | Hard timeout |

On solver failure (infeasible / timeout), partial duals are used if available. Tasks with ν > 10¹⁰ are treated as unconverged and parked.
