ALTER TABLE servers ADD COLUMN environment TEXT NOT NULL DEFAULT 'other'
    CHECK (environment IN ('development', 'staging', 'production', 'other'));

CREATE UNIQUE INDEX idx_servers_normalized_identity
ON servers(lower(trim(host)), port, trim(username));
