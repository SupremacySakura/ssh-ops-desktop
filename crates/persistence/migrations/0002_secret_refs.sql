PRAGMA defer_foreign_keys = ON;

CREATE TABLE secret_refs (
    ref TEXT PRIMARY KEY NOT NULL CHECK (length(trim(ref)) > 0),
    kind TEXT NOT NULL CHECK (
        kind IN ('password', 'private_key', 'passphrase', 'model_api_key', 'certificate')
    ),
    owner_type TEXT NOT NULL CHECK (length(trim(owner_type)) > 0),
    owner_id TEXT NOT NULL CHECK (length(trim(owner_id)) > 0),
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
    UNIQUE (owner_type, owner_id, kind)
);

INSERT INTO secret_refs (ref, kind, owner_type, owner_id, created_at, updated_at)
SELECT
    secret_ref,
    CASE auth_type
        WHEN 'password' THEN 'password'
        WHEN 'private_key' THEN 'private_key'
        WHEN 'certificate' THEN 'certificate'
        ELSE 'invalid'
    END,
    'server',
    id,
    created_at,
    updated_at
FROM servers
WHERE secret_ref IS NOT NULL;

CREATE TABLE server_tags_backup AS
SELECT server_id, tag_id, created_at
FROM server_tags;

CREATE TABLE servers_new (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    host TEXT NOT NULL CHECK (length(trim(host)) > 0),
    port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
    username TEXT NOT NULL,
    auth_type TEXT NOT NULL CHECK (
        auth_type IN ('password', 'private_key', 'ssh_agent', 'certificate')
    ),
    secret_ref TEXT REFERENCES secret_refs(ref) ON DELETE RESTRICT,
    group_id TEXT REFERENCES server_groups(id) ON DELETE SET NULL,
    jump_host_id TEXT REFERENCES servers_new(id) ON DELETE SET NULL
        DEFERRABLE INITIALLY DEFERRED,
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

INSERT INTO servers_new (
    id,
    name,
    host,
    port,
    username,
    auth_type,
    secret_ref,
    group_id,
    jump_host_id,
    host_key_fingerprint,
    created_at,
    updated_at,
    last_connected_at
)
SELECT
    id,
    name,
    host,
    port,
    username,
    auth_type,
    secret_ref,
    group_id,
    jump_host_id,
    host_key_fingerprint,
    created_at,
    updated_at,
    last_connected_at
FROM servers;

DROP TABLE servers;
ALTER TABLE servers_new RENAME TO servers;

INSERT INTO server_tags (server_id, tag_id, created_at)
SELECT server_id, tag_id, created_at
FROM server_tags_backup;

DROP TABLE server_tags_backup;

CREATE INDEX idx_servers_group_id ON servers(group_id);
CREATE INDEX idx_servers_jump_host_id ON servers(jump_host_id);
CREATE INDEX idx_servers_secret_ref ON servers(secret_ref);

-- Diagnostic output for manual migration runs. SQLx discards these rows; the
-- enforced safety boundary is the deferred foreign-key check at transaction commit.
PRAGMA foreign_key_check;
