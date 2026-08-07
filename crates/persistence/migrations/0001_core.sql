CREATE TABLE server_groups (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL CHECK (
        julianday(created_at) IS NOT NULL
        AND date(created_at, '+0 days') = substr(created_at, 1, 10)
        AND (
            created_at LIKE '____-__-__T__:__:__Z'
            OR created_at LIKE '____-__-__T__:__:__.%Z'
            OR created_at LIKE '____-__-__T__:__:__+00:00'
            OR created_at LIKE '____-__-__T__:__:__.%+00:00'
        )
    ),
    updated_at TEXT NOT NULL CHECK (
        julianday(updated_at) IS NOT NULL
        AND date(updated_at, '+0 days') = substr(updated_at, 1, 10)
        AND (
            updated_at LIKE '____-__-__T__:__:__Z'
            OR updated_at LIKE '____-__-__T__:__:__.%Z'
            OR updated_at LIKE '____-__-__T__:__:__+00:00'
            OR updated_at LIKE '____-__-__T__:__:__.%+00:00'
        )
    )
);

CREATE TABLE servers (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    host TEXT NOT NULL CHECK (length(trim(host)) > 0),
    port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
    username TEXT NOT NULL,
    auth_type TEXT NOT NULL CHECK (
        auth_type IN ('password', 'private_key', 'ssh_agent', 'certificate')
    ),
    secret_ref TEXT,
    group_id TEXT REFERENCES server_groups(id) ON DELETE SET NULL,
    jump_host_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
    host_key_fingerprint TEXT,
    created_at TEXT NOT NULL CHECK (
        julianday(created_at) IS NOT NULL
        AND date(created_at, '+0 days') = substr(created_at, 1, 10)
        AND (
            created_at LIKE '____-__-__T__:__:__Z'
            OR created_at LIKE '____-__-__T__:__:__.%Z'
            OR created_at LIKE '____-__-__T__:__:__+00:00'
            OR created_at LIKE '____-__-__T__:__:__.%+00:00'
        )
    ),
    updated_at TEXT NOT NULL CHECK (
        julianday(updated_at) IS NOT NULL
        AND date(updated_at, '+0 days') = substr(updated_at, 1, 10)
        AND (
            updated_at LIKE '____-__-__T__:__:__Z'
            OR updated_at LIKE '____-__-__T__:__:__.%Z'
            OR updated_at LIKE '____-__-__T__:__:__+00:00'
            OR updated_at LIKE '____-__-__T__:__:__.%+00:00'
        )
    ),
    last_connected_at TEXT CHECK (
        last_connected_at IS NULL
        OR (
            julianday(last_connected_at) IS NOT NULL
            AND date(last_connected_at, '+0 days') = substr(last_connected_at, 1, 10)
            AND (
                last_connected_at LIKE '____-__-__T__:__:__Z'
                OR last_connected_at LIKE '____-__-__T__:__:__.%Z'
                OR last_connected_at LIKE '____-__-__T__:__:__+00:00'
                OR last_connected_at LIKE '____-__-__T__:__:__.%+00:00'
            )
        )
    )
);

CREATE INDEX idx_servers_group_id ON servers(group_id);
CREATE INDEX idx_servers_jump_host_id ON servers(jump_host_id);

CREATE TABLE tags (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
    created_at TEXT NOT NULL CHECK (
        julianday(created_at) IS NOT NULL
        AND date(created_at, '+0 days') = substr(created_at, 1, 10)
        AND (
            created_at LIKE '____-__-__T__:__:__Z'
            OR created_at LIKE '____-__-__T__:__:__.%Z'
            OR created_at LIKE '____-__-__T__:__:__+00:00'
            OR created_at LIKE '____-__-__T__:__:__.%+00:00'
        )
    ),
    updated_at TEXT NOT NULL CHECK (
        julianday(updated_at) IS NOT NULL
        AND date(updated_at, '+0 days') = substr(updated_at, 1, 10)
        AND (
            updated_at LIKE '____-__-__T__:__:__Z'
            OR updated_at LIKE '____-__-__T__:__:__.%Z'
            OR updated_at LIKE '____-__-__T__:__:__+00:00'
            OR updated_at LIKE '____-__-__T__:__:__.%+00:00'
        )
    )
);

CREATE TABLE server_tags (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL CHECK (
        julianday(created_at) IS NOT NULL
        AND date(created_at, '+0 days') = substr(created_at, 1, 10)
        AND (
            created_at LIKE '____-__-__T__:__:__Z'
            OR created_at LIKE '____-__-__T__:__:__.%Z'
            OR created_at LIKE '____-__-__T__:__:__+00:00'
            OR created_at LIKE '____-__-__T__:__:__.%+00:00'
        )
    ),
    PRIMARY KEY (server_id, tag_id)
);

CREATE INDEX idx_server_tags_tag_id ON server_tags(tag_id);

CREATE TABLE app_settings (
    key TEXT PRIMARY KEY NOT NULL CHECK (length(trim(key)) > 0),
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    updated_at TEXT NOT NULL CHECK (
        julianday(updated_at) IS NOT NULL
        AND date(updated_at, '+0 days') = substr(updated_at, 1, 10)
        AND (
            updated_at LIKE '____-__-__T__:__:__Z'
            OR updated_at LIKE '____-__-__T__:__:__.%Z'
            OR updated_at LIKE '____-__-__T__:__:__+00:00'
            OR updated_at LIKE '____-__-__T__:__:__.%+00:00'
        )
    )
);

CREATE TABLE audit_logs (
    id TEXT PRIMARY KEY NOT NULL,
    action TEXT NOT NULL CHECK (length(trim(action)) > 0),
    resource_type TEXT NOT NULL CHECK (length(trim(resource_type)) > 0),
    resource_id TEXT,
    server_id TEXT,
    result TEXT NOT NULL CHECK (length(trim(result)) > 0),
    redacted_payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(redacted_payload)),
    created_at TEXT NOT NULL CHECK (
        julianday(created_at) IS NOT NULL
        AND date(created_at, '+0 days') = substr(created_at, 1, 10)
        AND (
            created_at LIKE '____-__-__T__:__:__Z'
            OR created_at LIKE '____-__-__T__:__:__.%Z'
            OR created_at LIKE '____-__-__T__:__:__+00:00'
            OR created_at LIKE '____-__-__T__:__:__.%+00:00'
        )
    )
);

CREATE TRIGGER audit_logs_no_update
BEFORE UPDATE ON audit_logs
BEGIN
    SELECT RAISE(ABORT, 'audit_logs is append-only');
END;

CREATE TRIGGER audit_logs_no_delete
BEFORE DELETE ON audit_logs
BEGIN
    SELECT RAISE(ABORT, 'audit_logs is append-only');
END;
