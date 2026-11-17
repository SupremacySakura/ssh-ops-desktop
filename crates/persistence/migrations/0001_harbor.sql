CREATE TABLE groups (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE servers (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    host TEXT NOT NULL CHECK (length(trim(host)) > 0),
    port INTEGER NOT NULL DEFAULT 22 CHECK (port BETWEEN 1 AND 65535),
    user TEXT NOT NULL CHECK (length(trim(user)) > 0),
    auth_type TEXT NOT NULL CHECK (auth_type IN ('password', 'key')),
    secret_ref TEXT NOT NULL CHECK (length(trim(secret_ref)) > 0),
    group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
    favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
    last_connected_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (host, port, user)
);

CREATE INDEX idx_servers_group_id ON servers(group_id);

CREATE TABLE known_host_keys (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    host TEXT NOT NULL CHECK (length(trim(host)) > 0),
    port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
    algorithm TEXT NOT NULL CHECK (length(trim(algorithm)) > 0),
    public_key_base64 TEXT NOT NULL CHECK (length(public_key_base64) > 0),
    sha256 TEXT NOT NULL CHECK (sha256 LIKE 'SHA256:%'),
    trusted_at TEXT NOT NULL CHECK (julianday(trusted_at) IS NOT NULL),
    PRIMARY KEY (server_id, host, port)
);
