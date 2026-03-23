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
| tᵢᶠ | Latest chunk | effective_due (earliest deadline in dependency chain) mapped to chunk index. 6k−1 if none. |
| kᵢ | Tag class | User tag, or NB Model 2 posterior if untagged. |

---

## Parameters

| Symbol | Meaning | Default |
|--------|---------|---------|
| αₖ | Urgency multiplier for tag class k | 1.0 |
| C(c) | Available slots in chunk c | Calendar hook. Currently hardcoded: 8 for 08:00–16:00, 0 otherwise. |
| Cₖ(c) | Energy budget for class k in chunk c | Dirichlet posterior mean × C(c) |

---

## Phase 1: QP for dual variables

### Decision variables

| Symbol | Meaning | Range |
|--------|---------|-------|
| xᵢ꜀ | Slots of work on task i in chunk c | [0, 8] |

Only instantiated for feasible (i, c) pairs where c ∈ [tᵢˢ, tᵢᶠ] and C(c) > 0.

### Delay reward (urgency formulation)

    rᵢ(c) = αₖᵢ · T / max(tᵢᶠ − c, 1)

where T = total chunks in horizon (84).

**Interpretation**: reward is inversely proportional to slack. A task due in 2 chunks gets r = 84/2 = 42. A task due in 80 chunks gets r = 84/80 ≈ 1. A no-deadline task (tᵢᶠ = 83) at chunk 0 gets r = 84/83 ≈ 1.

This inverts the original formulation's r = α·(tᶠ − c) which gave highest reward to tasks with the MOST slack. The urgency formulation correctly prioritizes imminent deadlines.

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

**(C5) Precedence.** For (i, j) where j is a child of i (parent_id):

    (1/wᵢ) Σ{τ≤c} xᵢτ  −  (1/wⱼ) Σ{τ≤c} xⱼτ  ≥  0    ∀c

Task j's fractional completion cannot exceed task i's at any chunk.

**(C6) Bounds.** xᵢ꜀ ∈ [0, 8].

---

## Phase 2: Priority scores from KKT conditions

From the solved QP, extract dual variables and compute for each (i, c):

    Λᵢ꜀ = rᵢ(c) + νᵢ − μ꜀ − ηₖᵢ,꜀

| Term | Effect |
|------|--------|
| rᵢ(c) | Urgency: up when deadline is near, up when αₖ is high |
| νᵢ | Completion pressure: up when task barely fits in its window |
| μ꜀ | Time competition: down when chunk c is contested by many tasks |
| ηₖ,꜀ | Energy scarcity: down when class-k energy is scarce at chunk c |

Λᵢ꜀ > 0: this task-chunk pair is worth scheduling.
Λᵢ꜀ ≤ 0 for all c: task is optimally parked.

---

## Phase 3: Greedy packing

The QP's continuous primal is discarded. The discrete schedule is built by greedy assignment using Λ as the priority signal.

### Algorithm

1. Collect all (i, c) pairs where Λᵢ꜀ > 0.
2. Sort by Λᵢ꜀ descending. Tiebreak: same task index first (finish what you started), then earlier chunk.
3. One-pass greedy:
   - For each (i, c) in sorted order:
     - Skip if task i has no remaining work (already fully assigned).
     - Skip if chunk c has no remaining capacity.
     - Skip if c is outside task i's feasibility window [tᵢˢ, tᵢᶠ].
     - **Precedence check**: if task i has parent j, verify that j's fractional completion ≥ i's fractional completion. Skip if violated.
     - Assign min(wᵢ remaining, C(c) remaining) slots.
   - Tasks with remaining work after the pass are parked.

### Why this produces good schedules

- **Whole-task blocks**: Λᵢ꜀ for a given task i varies smoothly across chunks (rᵢ(c) = T/slack changes slowly). So consecutive chunks for the same task have similar Λ, and the greedy fills adjacent chunks with the same task before moving to the next — producing contiguous blocks.

- **Natural focus**: Tasks with low Λ across all chunks never get reached before capacity runs out. No explicit sparsity penalty needed.

- **Deadline priority**: The 1/slack urgency reward gives imminent-deadline tasks Λ values that dominate no-deadline tasks, ensuring they are packed first.

- **Capacity-aware**: The duals μ꜀ and ηₖ꜀ encode which chunks are most contested. The greedy respects this by preferring chunks where the task's Λ is highest (least contested + most urgent).

---

## Energy model: 42 Dirichlets

Unchanged from v1. 42 independent Dirichlet distributions, one per (day-of-week, within-day-chunk) pair. Updated incrementally as work is observed. Feeds into Cₖ(c) energy budgets for constraint C2.

---

## NB Models

Unchanged from v1.
- **Model 1**: Duration debiasing from completed task observations.
- **Model 2**: Tag prediction for untagged tasks via multinomial NB.

---

## What changed from v1

| Aspect | v1 | v2 |
|--------|----|----|
| Delay reward | r = α·(tᶠ − c) (proportional to slack) | r = α·T/max(tᶠ − c, 1) (inversely proportional to slack) |
| z variables | Per-day activation z_{id} with coupling constraints | Eliminated. Sparsity emerges from greedy packing. |
| Primal solution | Used directly for allocation | Discarded. Only duals matter. |
| Discrete schedule | None (continuous x values shown to user) | Greedy packing from Λ scores produces whole-task blocks. |
| Concentration cost β | Material parameter controlling work spreading | Replaced by ε = 10⁻⁶ regularizer (strict convexity only). |
| Focus penalty γ | Per-day linear cost on z | Eliminated. Focus emerges naturally from capacity + greedy. |
