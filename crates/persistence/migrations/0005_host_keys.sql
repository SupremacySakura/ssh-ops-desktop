CREATE TABLE known_host_keys (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    host TEXT NOT NULL CHECK (length(trim(host)) > 0),
    port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
    algorithm TEXT NOT NULL CHECK (length(trim(algorithm)) > 0),
    public_key_base64 TEXT NOT NULL CHECK (length(public_key_base64) > 0),
    sha256 TEXT NOT NULL CHECK (sha256 LIKE 'SHA256:%'),
    trusted_at TEXT NOT NULL CHECK (
        julianday(trusted_at) IS NOT NULL
        AND date(trusted_at, '+0 days') = substr(trusted_at, 1, 10)
    ),
    PRIMARY KEY (server_id, host, port)
);
