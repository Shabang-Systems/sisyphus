-- Migrate dirichlet_state from chunk-position-based key (1–6) to wall-clock
-- hour key (0, 4, 8, ...). This decouples the Dirichlet model from the number
-- of chunks per day, so changing the grid doesn't invalidate training data.
--
-- Existing data assumes the original 6 chunks/day (4h each):
--   chunk 1 → hour 0,  chunk 2 → hour 4,  chunk 3 → hour 8,
--   chunk 4 → hour 12, chunk 5 → hour 16, chunk 6 → hour 20

CREATE TABLE dirichlet_state_new (
    dow INTEGER NOT NULL,
    hour INTEGER NOT NULL,
    tag TEXT NOT NULL,
    xi REAL NOT NULL DEFAULT 1.0,
    PRIMARY KEY (dow, hour, tag)
);

INSERT INTO dirichlet_state_new (dow, hour, tag, xi)
SELECT dow, (chunk - 1) * 4, tag, xi
FROM dirichlet_state;

DROP TABLE dirichlet_state;
ALTER TABLE dirichlet_state_new RENAME TO dirichlet_state;
