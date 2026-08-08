CREATE UNIQUE INDEX idx_servers_unique_secret_ref
ON servers(secret_ref)
WHERE secret_ref IS NOT NULL;
