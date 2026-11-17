PRAGMA defer_foreign_keys = ON;

CREATE TABLE known_host_keys_backup AS
SELECT * FROM known_host_keys;

CREATE TABLE servers_next (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    host TEXT NOT NULL CHECK (length(trim(host)) > 0),
    port INTEGER NOT NULL DEFAULT 22 CHECK (port BETWEEN 1 AND 65535),
    user TEXT NOT NULL CHECK (length(trim(user)) > 0),
    auth_type TEXT NOT NULL CHECK (auth_type IN ('password', 'key')),
    secret_ref TEXT CHECK (secret_ref IS NULL OR length(trim(secret_ref)) > 0),
    group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
    favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
    last_connected_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (host, port, user)
);

INSERT INTO servers_next (
    id, name, host, port, user, auth_type, secret_ref, group_id,
    favorite, last_connected_at, created_at
)
SELECT
    id, name, host, port, user, auth_type, secret_ref, group_id,
    favorite, last_connected_at, created_at
FROM servers;

DROP TABLE servers;
ALTER TABLE servers_next RENAME TO servers;

INSERT INTO known_host_keys (
    server_id, host, port, algorithm, public_key_base64, sha256, trusted_at
)
SELECT
    server_id, host, port, algorithm, public_key_base64, sha256, trusted_at
FROM known_host_keys_backup;

DROP TABLE known_host_keys_backup;

CREATE INDEX idx_servers_group_id ON servers(group_id);
