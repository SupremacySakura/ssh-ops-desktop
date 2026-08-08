CREATE TABLE tunnel_rules (
    id TEXT PRIMARY KEY NOT NULL,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('local', 'remote', 'dynamic')),
    bind_host TEXT NOT NULL CHECK (length(trim(bind_host)) > 0),
    bind_port INTEGER NOT NULL CHECK (bind_port BETWEEN 0 AND 65535),
    target_host TEXT,
    target_port INTEGER CHECK (target_port BETWEEN 1 AND 65535),
    created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
    CHECK (
        (direction = 'dynamic' AND target_host IS NULL AND target_port IS NULL) OR
        (direction IN ('local', 'remote') AND length(trim(target_host)) > 0 AND target_port IS NOT NULL)
    )
);

CREATE TABLE terminal_profiles (
    id TEXT PRIMARY KEY NOT NULL,
    server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    terminal_type TEXT NOT NULL DEFAULT 'xterm-256color'
        CHECK (terminal_type IN ('xterm', 'xterm-256color', 'screen', 'screen-256color')),
    columns INTEGER NOT NULL DEFAULT 120 CHECK (columns BETWEEN 2 AND 1000),
    rows INTEGER NOT NULL DEFAULT 32 CHECK (rows BETWEEN 2 AND 1000),
    created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
    UNIQUE (server_id, name)
);

CREATE INDEX idx_tunnel_rules_server_id ON tunnel_rules(server_id);
CREATE INDEX idx_terminal_profiles_server_id ON terminal_profiles(server_id);
