CREATE TABLE model_profiles (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    provider TEXT NOT NULL CHECK (provider = 'openai-compatible'),
    base_url TEXT NOT NULL CHECK (length(trim(base_url)) > 0),
    model TEXT NOT NULL CHECK (length(trim(model)) > 0),
    timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 1000 AND 300000),
    api_key_secret_ref TEXT UNIQUE REFERENCES secret_refs(ref) ON DELETE RESTRICT,
    is_default INTEGER NOT NULL CHECK (is_default IN (0, 1)),
    created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL)
);

CREATE UNIQUE INDEX idx_model_profiles_one_default
ON model_profiles(is_default) WHERE is_default = 1;
