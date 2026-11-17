# 0004 — 可空 `secret_ref` 与“凭据待配置”状态

## Status

**Accepted** — 2026-11-18

## Context

Issue #1 的 SQLite v2 schema 把 `servers.secret_ref` 定义为 `NOT NULL`。但 SSH Config 导入（任务单 #8）要求：导入只复制 `Host`、`HostName`、`Port`、`User`，不复制 `IdentityFile` 内容，也不创建系统凭据。

如果坚持 `NOT NULL`，导入只能：

1. 伪造一个不存在的 `secret_ref`，让服务器看起来“有凭据”，连接时才以 `SECRET_UNAVAILABLE` 失败；
2. 导入时要求用户逐台补凭据，失去“一次性带入现有服务器”的价值；
3. 不导入缺少凭据的主机，与验收标准冲突。

## Decision

`servers.secret_ref` 改为可空：

- `NULL` 只表示“凭据待配置”，不得写入空字符串或占位引用；
- 连接前若为 `NULL`，以 `SECRET_UNAVAILABLE` 失败关闭，并提示用户补充凭据；
- SSH Config 导入以 `NULL` 写入，前端把这类服务器标记为“待配置凭据”；
- 迁移 `0002_nullable_server_secret_ref.sql` 在同一事务内重建 `servers` 并备份/恢复 `known_host_keys`，避免级联丢失已信任指纹；
- `SecretRef::from_persisted` 仍拒绝空字符串与非法格式。

本 ADR 覆盖 Issue #1 schema 中的 `NOT NULL`。

## Consequences

### 正面

- 导入不需要伪造凭据，语义诚实；
- 用户可以先整理目录，再逐台补密码或私钥；
- 连接路径的失败关闭点明确。

### 负面

- 数据模型多了一个“待配置”状态，所有读取 `secret_ref` 的代码必须处理 `NULL`；
- 旧 `NOT NULL` 约束的迁移需要重建表，必须验证 `known_host_keys` 不丢失。

### 验证

- `crates/persistence/tests/` 覆盖迁移后 `secret_ref` 可空、`known_host_keys` 保留；
- `connection_auth` 对 `NULL` 返回 `SECRET_UNAVAILABLE`；
- 导入测试断言新服务器以 `NULL` 进入目录。
