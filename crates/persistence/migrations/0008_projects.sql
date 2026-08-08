CREATE TABLE projects (
    id TEXT PRIMARY KEY NOT NULL,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    root_path TEXT NOT NULL CHECK (substr(root_path, 1, 1) = '/'),
    repository_url TEXT,
    runtime_type TEXT NOT NULL CHECK (
        runtime_type IN ('docker_compose', 'static_site', 'node_js', 'go', 'python', 'generic')
    ),
    deploy_strategy TEXT NOT NULL CHECK (
        deploy_strategy IN ('in_place', 'release_symlink', 'docker_compose', 'static_atomic')
    ),
    created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
    UNIQUE (server_id, root_path),
    UNIQUE (server_id, name)
);

CREATE TABLE project_env_refs (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    value TEXT,
    secret_ref TEXT REFERENCES secret_refs(ref) ON DELETE RESTRICT,
    created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
    PRIMARY KEY (project_id, name),
    CHECK ((value IS NULL) <> (secret_ref IS NULL))
);

CREATE INDEX idx_projects_server_id ON projects(server_id);
CREATE INDEX idx_project_env_refs_secret_ref ON project_env_refs(secret_ref);
