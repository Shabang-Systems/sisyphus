-- Indexes for on-the-fly Dirichlet and NB model computation.
-- These replace the separate dirichlet_state / nb_tags / nb_tag_priors tables.

CREATE INDEX IF NOT EXISTS idx_tasks_completed_at
    ON tasks(completed_at) WHERE completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_tags
    ON tasks(tags) WHERE tags != '[]' AND tags != '';
