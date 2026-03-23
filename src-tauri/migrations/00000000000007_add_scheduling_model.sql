CREATE TABLE IF NOT EXISTS dirichlet_state (
    dow INTEGER NOT NULL,
    chunk INTEGER NOT NULL,
    tag TEXT NOT NULL,
    xi REAL NOT NULL DEFAULT 1.0,
    PRIMARY KEY (dow, chunk, tag)
);

CREATE TABLE IF NOT EXISTS nb_duration (
    tag TEXT NOT NULL,
    size INTEGER NOT NULL,
    total_observed REAL NOT NULL DEFAULT 0.0,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tag, size)
);

CREATE TABLE IF NOT EXISTS nb_tags (
    word TEXT NOT NULL,
    tag TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (word, tag)
);

CREATE TABLE IF NOT EXISTS nb_tag_priors (
    tag TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0
);
