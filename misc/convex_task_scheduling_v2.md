# Convex Task Scheduling v2: Urgency-Driven QP + Greedy Packing

---

## Overview

Two-phase scheduling: a convex QP produces dual variables that encode task urgency, then a greedy packer assigns whole tasks to chunks using those duals as priority scores.

The QP's primal solution is discarded. Its only job is to compute the shadow prices of time and task completion — the information the greedy packer needs to make good discrete assignments.

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
| wᵢ | Work required (slots) | T-shirt size → {1, 2, 4, 8}. Default S = 2. |
| tᵢˢ | Earliest chunk | start_date mapped to chunk index. 0 if none. |
| tᵢᶠ | Latest chunk | effective_due (earliest deadline in dependency chain) mapped to chunk index. 83 if none. |
| kᵢ | Tag class | User tag, or NB Model 2 posterior if untagged (threshold p > 0.3). |

---

## Parameters

| Symbol | Meaning | Default |
|--------|---------|---------|
| αₖ | Urgency multiplier for tag class k | 1.0 |
| C(c) | Available slots in chunk c | Base 8 slots per chunk, reduced by calendar busy blocks and locked/completed tasks. |
| eₖ(c) | Efficiency multiplier for tag k at chunk c | Derived from Dirichlet ξ (see below) |

---

## Efficiency model: Dirichlet → reward scaling

The 42 independent Dirichlet distributions (one per day-of-week × within-day-chunk pair) store concentration parameters ξₘₖ for each tag class k.

The Dirichlet parameters enter the **objective** as a reward multiplier on delay_reward. The idea: the scheduler values scheduling a task at times the user habitually works on that tag class, because the user is more productive there.

**Efficiency multiplier:**

    eₖ(c) = clamp( ξₖ(c) / ξ̄ₖ , 0.2, 5.0 )

where ξ̄ₖ = (1/T) Σ꜀ ξₖ(c) is the mean concentration across all chunks for tag k.

- eₖ(c) > 1: preferred time → higher reward for scheduling here
- eₖ(c) < 1: non-preferred → lower reward
- eₖ(c) = 1: no preference (uniform ξ, or `__untagged__` with constant ξ = 10)

**Example:** If @action has ξ = 4.85 at Tue 04:00 and ξ = 1.0 elsewhere:

| Chunk | ξ | ξ̄ | e | Effect on reward |
|-------|---|---|---|--------|
| Tue 04:00 | 4.85 | 1.09 | **4.4** | r is 4.4× higher → strong pull |
| elsewhere | 1.0 | 1.09 | **0.92** | r is 0.92× → slight discount |

For `__untagged__` (ξ = 10.0 everywhere): e = 1.0 uniformly. No time preference.

**Why reward, not constraint?** An earlier approach used Dirichlet as an energy cap constraint (C2). This failed because: (1) higher ξ → looser constraint → lower dual η → no positive incentive to use that slot; (2) the constraint could only repel (when binding), never attract. A constraint-on-C3 approach (efficiency-scaled work) also failed: when ν < 0 (no-deadline tasks), multiplying ν by efficiency *inverted* the preference, pushing tasks away from preferred times. Putting efficiency in the objective avoids both issues — e multiplies the always-positive reward r, so the preference is correctly oriented regardless of dual signs.

---

## Phase 1: QP for dual variables

### Decision variables

| Symbol | Meaning | Range |
|--------|---------|-------|
| xᵢ꜀ | Physical slots of work on task i in chunk c | [0, 8] |

Only instantiated for feasible (i, c) pairs where c ∈ [tᵢˢ, tᵢᶠ] and C(c) > 0.

### Preference reward

    rᵢ(c) = αₖᵢ · eₖᵢ(c)

Pure preference signal. The scheduler values placing work where the user is most productive (high Dirichlet efficiency). A task at a 4× preferred chunk gets r = 4.0; at a non-preferred chunk r = 0.92.

**Why no 1/slack urgency term**: Deadlines are enforced by the feasibility window [tˢ, tᶠ] — tasks simply cannot be assigned outside their window. Urgency emerges naturally from the QP dual ν: a task with a tight window (few feasible chunks relative to work needed) gets high ν because the equality constraint C3 is hard to satisfy. This gives it high Λ without needing an explicit urgency reward. The 1/slack formula was removed because it pushed tasks to the last possible moment, drowning out the preference signal.

### Objective

    min_x  Σᵢ Σ꜀ [ ε · xᵢ꜀²  −  rᵢ(c) · xᵢ꜀ ]

- **ε · x²**: Tiny regularizer (ε = 10⁻⁶) for strict convexity → unique dual variables. Has no material effect on the primal.
- **−r(c) · x**: Urgency reward. The solver allocates more to urgent tasks in early chunks.

The primal x values are discarded. The objective exists only to produce meaningful duals.

### Constraints

**(C1) Chunk capacity.**

    Σᵢ xᵢ꜀ ≤ C(c)    ∀c

Dual: μ꜀ ≥ 0. Marginal value of time at chunk c.

**(C3) Work completion (equality).**

    Σ꜀ xᵢ꜀ = wᵢ    ∀i

Equality prevents over-allocation. Dual: νᵢ. Completion pressure — positive when task i's window is tight relative to available capacity. Dirichlet efficiency enters the objective (via r), not this constraint.

**(C4) Feasibility window.** Variables not instantiated for c ∉ [tᵢˢ, tᵢᶠ].

**(C5) Precedence.** For (i, j) where i is a parent of j (parent_id):

    (1/wᵢ) Σ{τ≤c} xᵢτ  −  (1/wⱼ) Σ{τ≤c} xⱼτ  ≥  0    ∀c

Task j's fractional completion cannot exceed task i's at any chunk.

**(C6) Bounds.** xᵢ꜀ ∈ [0, 8].

---

## Phase 2: Priority scores from KKT conditions

From the solved QP, extract dual variables and compute for each (i, c):

    Λᵢ꜀ = rᵢ(c) + νᵢ − μ꜀

where rᵢ(c) = αₖ · eₖ(c) · T / slack already includes the efficiency multiplier, and duals are:
- μ꜀ = max(−y[c], 0) — C1 dual (first TOTAL_CHUNKS rows)
- νᵢ = −y[n_c1 + i] — C3 dual (may be negative)

| Term | Effect |
|------|--------|
| rᵢ(c) | Preference: up when αₖ is high, up when eₖ(c) is high (preferred time). Constant across chunks for a given (task, chunk) pair's tag. |
| νᵢ | Completion pressure: up when task barely fits in its window. This is how urgency enters — tight deadlines produce high ν automatically. |
| μ꜀ | Time competition: down when chunk c is contested by many tasks |

**Key mechanism**: r encodes only preference (always positive), ν encodes urgency (from QP constraint tightness), μ encodes competition (from capacity scarcity). The three concerns are cleanly separated. Deadlines don't appear in the reward — they are constraints that make ν high when binding.

Λᵢ꜀ > 0: this task-chunk pair is worth scheduling.
Λᵢ꜀ ≤ 0 for all c: task is optimally parked.

A small stability bonus (ε = 0.001) is added to Λ for a task's currently-scheduled chunk, acting as a tiebreaker to reduce schedule churn between solves.

---

## Phase 3: Greedy packing

The QP's continuous primal is discarded. The discrete schedule is built by greedy assignment using Λ as the priority signal.

### Algorithm

Tasks are never split across chunks — each task is placed entirely in one chunk or parked.

1. Build per-task Λ lookup: for each task, collect (chunk, Λ) pairs sorted by Λ descending.
2. Topological sort (BFS from DAG roots) to determine placement order. Parents are placed before children. Within each BFS level, tasks are sorted by best Λ descending.
3. For each task in BFS order:
   - Find the highest-Λ chunk where the task fits entirely (remaining capacity ≥ wᵢ).
   - If found, assign the task there. Otherwise, park it.

### Why this produces good schedules

- **Preference-driven concentration**: Λ is higher at preferred chunks (via e in r), so the greedy packs there first. The solver naturally concentrates work where the user habitually works on that tag.

- **Whole-task blocks**: Λᵢ꜀ for a given task i varies smoothly across chunks (earliness changes by 1 per chunk, e varies by tag preference). The greedy fills adjacent preferred chunks with the same task before moving on.

- **Natural focus**: Tasks with low Λ across all chunks never get reached before capacity runs out. No explicit sparsity penalty needed.

- **Deadline priority**: High-pressure tasks (tight deadline relative to work) get Λ values that dominate low-pressure tasks, ensuring they are packed first.

- **Capacity-aware**: The dual μ꜀ encodes which chunks are most contested. The greedy respects this by preferring chunks where the task's Λ is highest (least contested + most urgent + most efficient).

- **Graceful degradation**: With no Dirichlet training, all e = 1.0, and the formulation reduces to pure urgency-based scheduling (v1 behavior).

---

## Capacity model

All 6 daily chunks start at full capacity (8 slots). Availability is reduced by:

1. **Calendar busy blocks** — ICS calendar events subtract slots from the corresponding chunks.
2. **Locked tasks** — tasks manually pinned to a schedule date consume capacity.
3. **Completed tasks** — recently completed tasks consume capacity in their completion chunk.

Without calendars, all hours are available.

---

## Dirichlet model: 42 distributions

42 independent Dirichlet distributions, one per (day-of-week, within-day-chunk) pair. Each has K concentration parameters ξₘₖ (one per tag class k).

**Update rule** (on task completion): ξₘₖ ← ρ · ξₘₖ + n, where n = observed slots, ρ = 0.95. Half-life ≈ 14 weeks.

**Initialization**: ξ = 1.0 (uniform). `__untagged__` gets ξ = 10.0.

**Training**: explicit training via the Training screen (Settings → Training) also calls update_dirichlet directly.

**Usage**: ξ values are converted to per-tag efficiency multipliers eₖ(c) = clamp(ξₖ(c) / ξ̄ₖ, 0.2, 5.0), which enter the objective as a reward multiplier on delay_reward. No separate energy constraint exists.

---

## NB Tag Prediction

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
