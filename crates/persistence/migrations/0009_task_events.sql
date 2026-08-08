ALTER TABLE tasks ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0);
ALTER TABLE tasks ADD COLUMN progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100);
ALTER TABLE tasks ADD COLUMN current_step TEXT;
ALTER TABLE tasks ADD COLUMN error_code TEXT;

CREATE TABLE task_events (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled',
                   'interrupted', 'rolling_back', 'rolled_back', 'rollback_failed')
    ),
    progress INTEGER NOT NULL CHECK (progress BETWEEN 0 AND 100),
    current_step TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
    PRIMARY KEY (task_id, sequence)
);

CREATE INDEX idx_task_events_created_at ON task_events(created_at);

CREATE TRIGGER task_events_no_update
BEFORE UPDATE ON task_events
BEGIN
    SELECT RAISE(ABORT, 'task events are append-only');
END;

CREATE TRIGGER task_events_no_delete
BEFORE DELETE ON task_events
BEGIN
    SELECT RAISE(ABORT, 'task events are append-only');
END;
