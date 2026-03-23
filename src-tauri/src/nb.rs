//! # Naive Bayes Models for Task Scheduling
//!
//! Two complementary NB models that improve scheduling quality over time.
//!
//! ## Model 1: Duration Debiasing
//!
//! Users systematically underestimate task duration. This model learns a scalar
//! correction per (tag, effort-size) pair from observed completion times.
//!
//! Training signal: when a task is completed, `Δ = t_complete − t_scheduled`
//! measures actual duration in slots. The model maintains a running mean of Δ
//! for each (tag, size) combination. After ≥5 observations, the debiased work
//! requirement `w_i` replaces the raw T-shirt size mapping.
//!
//! ## Model 2: Tag Prediction
//!
//! Predicts tag class for untagged tasks from bag-of-words of task text.
//! Multinomial Naive Bayes produces a full posterior `p(k | b_i) ∈ Δ^{K-1}`.
//!
//! Used to:
//! - Substitute soft-weighted α̃_i, β̃_i for untagged tasks in the objective
//! - Distribute untagged energy budgets in constraint (C2)
//! - Distribute Dirichlet observations proportionally
//!
//! Both models update incrementally. No batch retraining required.

use std::collections::HashMap;
use anyhow::Result;
use sqlx::sqlite::SqlitePool;

/// Tokenizes task text into bag-of-words. Simple whitespace + lowercase.
pub fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() > 1)
        .map(|w| w.to_string())
        .collect()
}

/// Loads NB Model 1 (duration debiasing) corrections from the database.
///
/// Returns a map of `(tag, effort_size) → mean_actual_slots`.
/// Only includes entries with ≥5 observations.
pub async fn load_duration_model(pool: &SqlitePool) -> Result<HashMap<(String, i64), f64>> {
    let rows: Vec<(String, i64, f64, i64)> = sqlx::query_as(
        "SELECT tag, size, total_observed, count FROM nb_duration WHERE count >= 5"
    ).fetch_all(pool).await?;

    let mut model = HashMap::new();
    for (tag, size, total, count) in rows {
        if count > 0 {
            model.insert((tag, size), total / count as f64);
        }
    }
    Ok(model)
}

/// Updates NB Model 1 with an observed task completion.
///
/// `actual_slots`: the number of slots the task actually took (measured from
/// schedule time to completion time).
pub async fn update_duration_model(
    pool: &SqlitePool,
    tag: &str,
    effort_size: i64,
    actual_slots: f64,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO nb_duration (tag, size, total_observed, count) VALUES (?, ?, ?, 1) \
         ON CONFLICT(tag, size) DO UPDATE SET \
         total_observed = total_observed + ?, count = count + 1"
    )
    .bind(tag)
    .bind(effort_size)
    .bind(actual_slots)
    .bind(actual_slots)
    .execute(pool)
    .await?;
    Ok(())
}

/// Computes debiased work requirements for a set of tasks.
///
/// For each task, looks up the (tag, effort) pair in Model 1. If ≥5 observations
/// exist, uses the learned mean. Otherwise, uses the raw T-shirt size mapping.
pub fn compute_debiased_w(
    tasks: &[(String, String, i64)], // (task_id, tag, effort)
    model: &HashMap<(String, i64), f64>,
) -> HashMap<String, f64> {
    let mut result = HashMap::new();
    for (id, tag, effort) in tasks {
        let raw_w = crate::scheduler::effort_to_slots(*effort);
        let debiased = model.get(&(tag.clone(), *effort)).copied().unwrap_or(raw_w);
        result.insert(id.clone(), debiased);
    }
    result
}

/// Loads NB Model 2 (tag prediction) from the database.
///
/// Returns:
/// - Word-tag counts: `word → tag → count`
/// - Tag priors: `tag → count`
pub async fn load_tag_model(pool: &SqlitePool) -> Result<(HashMap<String, HashMap<String, i64>>, HashMap<String, i64>)> {
    let word_rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT word, tag, count FROM nb_tags"
    ).fetch_all(pool).await?;

    let prior_rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT tag, count FROM nb_tag_priors"
    ).fetch_all(pool).await?;

    let mut word_tag: HashMap<String, HashMap<String, i64>> = HashMap::new();
    for (word, tag, count) in word_rows {
        word_tag.entry(word).or_default().insert(tag, count);
    }

    let priors: HashMap<String, i64> = prior_rows.into_iter().collect();
    Ok((word_tag, priors))
}

/// Updates NB Model 2 when the user tags a task.
///
/// Increments word-tag counts for each word in the task text, and the tag prior.
pub async fn update_tag_model(
    pool: &SqlitePool,
    text: &str,
    tag: &str,
) -> Result<()> {
    let words = tokenize(text);

    for word in &words {
        sqlx::query(
            "INSERT INTO nb_tags (word, tag, count) VALUES (?, ?, 1) \
             ON CONFLICT(word, tag) DO UPDATE SET count = count + 1"
        )
        .bind(word)
        .bind(tag)
        .execute(pool)
        .await?;
    }

    sqlx::query(
        "INSERT INTO nb_tag_priors (tag, count) VALUES (?, 1) \
         ON CONFLICT(tag) DO UPDATE SET count = count + 1"
    )
    .bind(tag)
    .execute(pool)
    .await?;

    Ok(())
}

/// Predicts tag posterior `p(k | text)` using multinomial Naive Bayes.
///
/// Returns a probability distribution over all known tags.
/// Uses Laplace smoothing (add-1) to avoid zero probabilities.
pub fn predict_tag(
    text: &str,
    word_tag: &HashMap<String, HashMap<String, i64>>,
    priors: &HashMap<String, i64>,
) -> HashMap<String, f64> {
    let words = tokenize(text);
    let tags: Vec<&String> = priors.keys().collect();
    let total_prior: i64 = priors.values().sum();

    if tags.is_empty() || total_prior == 0 {
        return HashMap::new();
    }

    // Vocabulary size for Laplace smoothing
    let vocab_size = word_tag.len() as f64;

    // Log-posterior for each tag (unnormalized)
    let mut log_posteriors: Vec<f64> = vec![];

    for tag in &tags {
        let prior_count = *priors.get(*tag).unwrap_or(&0) as f64;
        let mut log_p = (prior_count / total_prior as f64).ln();

        // Total word count for this tag
        let tag_total: f64 = word_tag.values()
            .filter_map(|m| m.get(*tag))
            .sum::<i64>() as f64;

        for word in &words {
            let word_count = word_tag.get(word)
                .and_then(|m| m.get(*tag))
                .copied()
                .unwrap_or(0) as f64;
            // Laplace-smoothed likelihood
            log_p += ((word_count + 1.0) / (tag_total + vocab_size)).ln();
        }

        log_posteriors.push(log_p);
    }

    // Normalize via log-sum-exp
    let max_log = log_posteriors.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let sum_exp: f64 = log_posteriors.iter().map(|lp| (lp - max_log).exp()).sum();

    let mut result = HashMap::new();
    for (i, tag) in tags.iter().enumerate() {
        let prob = ((log_posteriors[i] - max_log).exp()) / sum_exp;
        result.insert((*tag).clone(), prob);
    }

    result
}
