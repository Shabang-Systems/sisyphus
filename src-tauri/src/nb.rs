//! # Naive Bayes Tag Prediction
//!
//! Predicts tag class for untagged tasks from bag-of-words of task text.
//! Multinomial Naive Bayes produces a full posterior `p(k | b_i) ∈ Δ^{K-1}`.
//!
//! Model is derived on-the-fly from tagged tasks in the database.
//! No separate state tables or batch retraining required.

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

/// Derives NB tag model from tagged tasks in the database.
///
/// Returns:
/// - Word-tag counts: `word → tag → count`
/// - Tag priors: `tag → count`
pub async fn load_tag_model(pool: &SqlitePool) -> Result<(HashMap<String, HashMap<String, i64>>, HashMap<String, i64>)> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT content, tags FROM tasks WHERE tags != '[]' AND tags != ''"
    ).fetch_all(pool).await?;

    let text_re = regex::Regex::new(r#""text"\s*:\s*"([^"]+)""#).unwrap();
    let mut word_tag: HashMap<String, HashMap<String, i64>> = HashMap::new();
    let mut priors: HashMap<String, i64> = HashMap::new();

    for (content, tags_json) in rows {
        let tags: Vec<String> = match serde_json::from_str(&tags_json) {
            Ok(t) => t,
            Err(_) => continue,
        };

        let text: String = text_re.captures_iter(&content)
            .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
            .collect::<Vec<_>>()
            .join(" ");

        if text.is_empty() { continue; }

        let words = tokenize(&text);

        for tag in &tags {
            *priors.entry(tag.clone()).or_insert(0) += 1;

            for word in &words {
                *word_tag.entry(word.clone())
                    .or_default()
                    .entry(tag.clone())
                    .or_insert(0) += 1;
            }
        }
    }

    Ok((word_tag, priors))
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
