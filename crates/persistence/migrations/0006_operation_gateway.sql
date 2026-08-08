CREATE TABLE tool_calls (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL,
    server_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    args_json TEXT NOT NULL CHECK (json_valid(args_json)),
    args_digest TEXT NOT NULL CHECK (length(args_digest) = 64),
    actor_type TEXT NOT NULL CHECK (actor_type IN ('manual', 'agent')),
    actor_id TEXT NOT NULL CHECK (length(trim(actor_id)) > 0),
    state TEXT NOT NULL CHECK (state IN ('prepared', 'read_completed', 'blocked')),
    created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL)
);

CREATE TABLE approvals (
    id TEXT PRIMARY KEY NOT NULL,
    tool_call_id TEXT NOT NULL UNIQUE REFERENCES tool_calls(id) ON DELETE RESTRICT,
    args_digest TEXT NOT NULL CHECK (length(args_digest) = 64),
    risk_level TEXT NOT NULL CHECK (risk_level IN ('L1', 'L2', 'L3')),
    snapshot_required INTEGER NOT NULL CHECK (snapshot_required IN (0, 1)),
    target_label TEXT NOT NULL CHECK (length(trim(target_label)) > 0),
    confirmation_target TEXT,
    confirmation_text TEXT,
    policy_version INTEGER NOT NULL CHECK (policy_version > 0),
    expires_at TEXT NOT NULL CHECK (julianday(expires_at) IS NOT NULL),
    state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'expired')),
    task_id TEXT UNIQUE,
    created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL)
);

CREATE TABLE tasks (
    id TEXT PRIMARY KEY NOT NULL,
    tool_call_id TEXT NOT NULL UNIQUE REFERENCES tool_calls(id) ON DELETE RESTRICT,
    args_digest TEXT NOT NULL CHECK (length(args_digest) = 64),
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled',
                   'interrupted', 'rolling_back', 'rolled_back', 'rollback_failed')
    ),
    retry_of_tool_call_id TEXT REFERENCES tool_calls(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL)
);

CREATE INDEX idx_tool_calls_run_id ON tool_calls(run_id);
CREATE INDEX idx_tool_calls_server_id ON tool_calls(server_id);
CREATE INDEX idx_tasks_status ON tasks(status);

CREATE TRIGGER tool_calls_immutable_identity
BEFORE UPDATE OF id, run_id, server_id, name, schema_version, args_json, args_digest,
                 actor_type, actor_id, created_at ON tool_calls
BEGIN
    SELECT RAISE(ABORT, 'tool-call identity and arguments are immutable');
END;

CREATE TRIGGER tool_calls_no_delete
BEFORE DELETE ON tool_calls
BEGIN
    SELECT RAISE(ABORT, 'tool_calls are immutable');
END;
