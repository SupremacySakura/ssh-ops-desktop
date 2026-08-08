CREATE TABLE agent_threads (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    context_summary TEXT NOT NULL DEFAULT '',
    summary_version INTEGER NOT NULL DEFAULT 1 CHECK (summary_version > 0),
    created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL)
);

CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
    model_profile_id TEXT REFERENCES model_profiles(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (
        status IN ('planning', 'awaiting_tool', 'awaiting_approval', 'executing',
                   'summarizing', 'succeeded', 'failed', 'cancelled', 'recovery_required')
    ),
    sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0),
    input_summary TEXT NOT NULL CHECK (length(input_summary) <= 4096),
    output_summary TEXT CHECK (length(output_summary) <= 8192),
    created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL)
);

CREATE TABLE agent_run_events (
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    status TEXT NOT NULL,
    summary TEXT NOT NULL CHECK (length(summary) <= 4096),
    created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
    PRIMARY KEY (run_id, sequence)
);

CREATE INDEX idx_agent_runs_thread_id ON agent_runs(thread_id, created_at);
