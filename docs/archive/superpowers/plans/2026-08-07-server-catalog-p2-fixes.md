# Server Catalog P2 Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复服务器目录的约束错误误报、0003 旧库重复数据升级失败，以及服务器删除后遗留不可追踪系统凭据的问题。

**Architecture:** 持久化层用 SQLx 约束类型和语句上下文建立准确错误边界；数据库启动时在 migrator 前只读检查旧身份冲突；删除命令采用“解析目标 → 幂等删除凭据 → 条件事务删除数据库 → 脱敏审计”的可重试流程。SQLite 与 keyring 不做伪原子事务，依靠保留可见数据库记录和幂等重试收敛；0004 partial unique index 保证非空 `secret_ref` 只有一个服务器所有者，关闭删除准备阶段的共享引用竞态。

**Tech Stack:** Rust 2024、Tokio、SQLx 0.9、SQLite migrations、Tauri 2、keyring、现有 `CoreError`/`AuditWriter`/`SecretStore` 边界。

## Global Constraints

- 不自动合并或删除旧库中的重复服务器。
- 不修改 `0003_server_catalog.sql`，避免已运行迁移的 checksum 变化。
- 错误和审计不得包含 secret value 或作为 keyring account 的 `secret_ref`。
- `SecretStore.delete` 必须幂等；`NoEntry` 是成功，真实后端故障仍是 `SecretUnavailable`。
- 凭据删除失败时不得修改服务器、关系或 `secret_refs` 元数据。
- 当前工作树已有用户暂存内容；不得 reset、checkout、重新暂存或提交。提交必须走用户单独确认流程。

---

## File Map

- `crates/domain/src/server.rs`：在领域入口拒绝重复 tag ID。
- `crates/persistence/src/server_repository.rs`：上下文化约束错误、删除目标校验和条件删除事务。
- `crates/persistence/src/database.rs`：migrator 前的旧服务器身份预检。
- `crates/persistence/migrations/0004_unique_server_secret_refs.sql`：服务器凭据引用唯一约束。
- `crates/persistence/tests/server_repository.rs`：标签冲突、关系错误、共享凭据与删除条件测试。
- `crates/persistence/tests/server_catalog_migration.rs`：v2 → v3 重复预检和修复后重试测试。
- `crates/secrets/src/memory_store.rs`：幂等内存删除。
- `crates/secrets/src/keyring_store.rs`：把 keyring `NoEntry` 归类为删除完成。
- `crates/secrets/tests/store_contract.rs`：跨 SecretStore 的幂等删除契约。
- `src-tauri/src/commands/server.rs`：凭据优先的删除编排和故障审计测试。

---

### Task 1: 准确映射服务器目录约束错误

**Files:**
- Modify: `crates/domain/src/server.rs`
- Modify: `crates/persistence/src/server_repository.rs`
- Test: `crates/persistence/tests/server_repository.rs`

**Interfaces:**
- Consumes: `sqlx::Error::as_database_error()`、`DatabaseError::is_unique_violation()`、`DatabaseError::is_foreign_key_violation()`。
- Produces: `ServerInput::try_new` 的唯一 tag ID 不变量，以及按服务器 identity、tag name、tag link、secret metadata 区分的错误 mapper。

- [ ] **Step 1: 写入会失败的领域与 repository 测试**

在 `crates/domain/src/server.rs` 的 `#[cfg(test)]` 模块中构造两个相同 `Id`，断言 `ServerInput::try_new(..., vec![tag_id, tag_id])` 返回 `Validation` 且消息含 `tag IDs must not contain duplicates`。

在 `crates/persistence/tests/server_repository.rs` 增加以下真实 SQLite 行为测试：

```rust
#[tokio::test]
async fn reports_tag_name_conflicts_as_tag_conflicts() {
    let database = Database::open(":memory:").await.unwrap();
    let repository = ServerRepository::new(database);
    repository.create_tag("edge").await.unwrap();

    let error = repository.create_tag("edge").await.unwrap_err();
    assert_eq!(error.code(), CoreErrorCode::Conflict);
    assert!(error.message().contains("server tag"));
    assert!(!error.message().contains("host, port, and username"));
}
```

另加 update tag 重名测试、未知 group/tag 仍为 `Validation` 的消息断言，以及两个服务器直接共享一个 `secret_ref` 时 repository 删除返回 `Internal`、两条服务器和元数据均保留的测试。

- [ ] **Step 2: 验证 RED**

Run:

```bash
cargo test -p opspilot-domain server::tests --offline
cargo test -p opspilot-persistence --test server_repository --offline
```

Expected: 重复 tag ID 当前被接受；标签重名和共享凭据分别收到错误的服务器 identity、unknown group/tag 消息。

- [ ] **Step 3: 在领域层拒绝重复 tag ID**

在 `ServerInput::try_new` 构造返回值前使用 `HashSet<Id>` 检查：

```rust
let unique_tag_ids = tag_ids.iter().copied().collect::<HashSet<_>>();
if unique_tag_ids.len() != tag_ids.len() {
    return Err(validation_error("tag IDs must not contain duplicates"));
}
```

保留调用方给出的 tag 顺序，不排序、不自动去重。

- [ ] **Step 4: 用约束类型和语句上下文替换全局消息映射**

删除字符串匹配的全局 `map_write_error`，建立窄 helper：

```rust
fn is_unique_violation(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .is_some_and(|database_error| database_error.is_unique_violation())
}

fn is_foreign_key_violation(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .is_some_and(|database_error| database_error.is_foreign_key_violation())
}
```

服务器 insert/update 使用 identity conflict mapper；`server_tags` insert 使用 duplicate-link/unknown-tag mapper；tag create/update 使用 tag-name conflict mapper；删除仍被引用的 `secret_refs` 使用 `Internal` 的 credential metadata invariant mapper；group/tag 普通删除和其他错误使用带操作名的 `repository_error`。

- [ ] **Step 5: 验证 GREEN 和回归**

Run:

```bash
cargo test -p opspilot-domain server::tests --offline
cargo test -p opspilot-persistence --test server_repository --offline
```

Expected: 所有新增测试通过，已有 identity 冲突和事务回滚测试继续通过。

- [ ] **Step 6: 工作树检查点**

运行 `git diff --check` 并记录 Task 1 文件；不要暂存或提交。

---

### Task 2: 在 0003 前预检旧服务器身份重复

**Files:**
- Modify: `crates/persistence/src/database.rs`
- Create: `crates/persistence/tests/server_catalog_migration.rs`

**Interfaces:**
- Consumes: `Database::open`、SQLx `_sqlx_migrations` 管理、0003 的 `lower(trim(host)), port, trim(username)` 规则。
- Produces: `validate_legacy_server_identities(pool: &SqlitePool) -> Result<(), CoreError>`。

- [ ] **Step 1: 创建 v2 重复数据库的失败测试**

测试内声明 `static MIGRATOR: Migrator = sqlx::migrate!("./migrations")`，用 `run_to(2)` 创建临时库，插入：

```text
legacy-a: " EXAMPLE.com ", 22, " deploy "
legacy-b: "example.COM", 22, "deploy"
```

关闭旧连接后调用 `Database::open`，断言错误码为 `Validation`，消息含 `legacy-a`、`legacy-b`、`example.com`、`22`、`deploy` 和 `modify or delete`。当前实现应返回不含这些诊断的 `Internal`。

- [ ] **Step 2: 验证 RED**

Run:

```bash
cargo test -p opspilot-persistence --test server_catalog_migration --offline
```

Expected: FAIL，因为唯一索引创建错误仍被映射成通用 migration `Internal`。

- [ ] **Step 3: 实现只读预检**

在 `MIGRATOR.run(&pool)` 之前调用新函数。先查询 `servers` 表存在且归一化索引不存在，再执行稳定分组查询：

```sql
SELECT normalized_host, port, normalized_username, group_concat(id, ', ')
FROM (
  SELECT id, lower(trim(host)) AS normalized_host, port,
         trim(username) AS normalized_username
  FROM servers
  ORDER BY id
)
GROUP BY normalized_host, port, normalized_username
HAVING COUNT(*) > 1
ORDER BY normalized_host, port, normalized_username
LIMIT 1
```

发现重复时返回 `CoreErrorCode::Validation`；消息列出身份、全部 ID，并要求 `modify or delete the duplicate records before retrying`。

- [ ] **Step 4: 增加修正后可重试测试**

首次打开得到诊断后，用原始 SQLx 连接把 `legacy-b.host` 改为 `other.example.com`，再次 `Database::open`。断言：两条服务器均保留、`environment = 'other'`、`idx_servers_normalized_identity` 存在且迁移继续完成到当前最新版本。

- [ ] **Step 5: 验证 GREEN 和相邻迁移测试**

Run:

```bash
cargo test -p opspilot-persistence --test server_catalog_migration --offline
cargo test -p opspilot-persistence --test secret_refs --offline
cargo test -p opspilot-persistence --test database --offline
```

Expected: 新旧迁移测试全部通过，0003 文件无改动。

- [ ] **Step 6: 工作树检查点**

运行 `git diff --check`，确认 `crates/persistence/migrations/0003_server_catalog.sql` 没有新的未暂存修改；不要暂存或提交。

---

### Task 3: 统一 SecretStore 幂等删除契约

**Files:**
- Modify: `crates/secrets/src/memory_store.rs`
- Modify: `crates/secrets/src/keyring_store.rs`
- Modify: `crates/secrets/tests/store_contract.rs`

**Interfaces:**
- Consumes: `SecretStore::delete(&SecretRef)`、`keyring::Error::NoEntry`。
- Produces: 删除已不存在引用仍返回 `Ok(())` 的跨实现契约，以及 `classify_delete` 的 keyring 错误分类。

- [ ] **Step 1: 扩展 store contract 和 keyring 单元测试**

在共享 contract 中，对刚删除的同一 `secret_ref` 再调用一次 `delete` 并断言成功；之后 `get` 仍必须返回 `SecretUnavailable`。

在 keyring_store 单元测试中增加：

```rust
assert!(classify_delete(Err(keyring::Error::NoEntry)).is_ok());
assert!(matches!(
    classify_delete(Err(keyring::Error::NoDefaultStore)),
    Err(keyring::Error::NoDefaultStore)
));
```

- [ ] **Step 2: 验证 RED**

Run:

```bash
cargo test -p opspilot-secrets --offline
```

Expected: MemorySecretStore 第二次删除返回 `SecretUnavailable`；`classify_delete` 尚不存在。

- [ ] **Step 3: 实现幂等删除**

MemorySecretStore 删除时无论 map 中是否存在都返回 `Ok(())`。KeyringSecretStore 在阻塞闭包内调用：

```rust
fn classify_delete(result: keyring::Result<()>) -> keyring::Result<()> {
    match result {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error),
    }
}
```

其他错误继续经过 `run_keyring` 映射为 `SecretUnavailable`。

- [ ] **Step 4: 验证 GREEN**

Run:

```bash
cargo test -p opspilot-secrets --offline
```

Expected: 内存 contract 和 keyring 分类测试通过；操作系统 contract 仍保持 ignored，除非显式启用。

- [ ] **Step 5: 工作树检查点**

运行 `git diff --check`；不要暂存或提交。

---

### Task 4: 以凭据优先、条件数据库删除重写 server_delete

**Files:**
- Modify: `crates/persistence/src/server_repository.rs`
- Modify: `crates/persistence/tests/server_repository.rs`
- Modify: `src-tauri/src/commands/server.rs`

**Interfaces:**
- Consumes: Task 1 的 credential invariant mapper、Task 3 的幂等 `SecretStore.delete`。
- Produces: `ServerRepository::deletion_secret_ref(id: Id) -> Result<Option<SecretRef>, CoreError>`，以及 `ServerRepository::delete(id: Id, expected_secret_ref: Option<&SecretRef>) -> Result<(), CoreError>`。

- [ ] **Step 1: 写凭据后端失败不改数据库的命令测试**

创建测试专用 `UnavailableDeleteSecretStore`，仅把外部 SecretStore 边界固定为 `SecretUnavailable`；断言真实 repository 和 audit 行为，不断言 mock 调用次数。给服务器插入合法 `secret_refs` 元数据后调用 `delete_server`，断言：服务器仍可读取、元数据计数为 1、审计为 failure 且没有 success。

修改当前固化错误行为的 `command_mutations_audit_only_redacted_outcomes_and_never_false_success`：删除失败后期望服务器存在，而不是 `NotFound`。

- [ ] **Step 2: 写数据库失败后可重试的命令测试**

用真实 MemorySecretStore `put` 生成 ref 并关联服务器；创建 SQLite `BEFORE DELETE ON servers` trigger，以 `RAISE(ABORT, 'delete fixture')` 注入数据库失败。第一次删除断言凭据已不存在、服务器和元数据仍在、审计 failure。删除 trigger 后再次调用，依靠幂等 SecretStore 删除成功，最终断言服务器和元数据均不存在、最后一次审计 success。

- [ ] **Step 3: 验证 RED**

Run:

```bash
cargo test -p opspilot-desktop commands::server::tests --offline
```

Expected: 当前 DB-first 实现会在凭据失败后丢失服务器；当前 repository API 也没有预读/条件删除接口。

- [ ] **Step 4: 实现删除目标预读和不变量校验**

`deletion_secret_ref` 先读取服务器和可选 ref；对非空 ref 验证：

- `secret_refs.owner_type = 'server'`；
- `secret_refs.owner_id` 等于服务器 ID；
- 恰好一台服务器引用该 ref。

非法或共享状态返回 `Internal`，且消息不含 ref 字符串。`SecretRef::from_persisted` 必须在任何删除前执行。

- [ ] **Step 5: 实现条件数据库删除**

把 repository delete 改成接收预期 ref，并在事务中执行 null-safe 条件：

```sql
DELETE FROM servers
WHERE id = ? AND secret_ref IS ?
```

若影响行数为 0，返回 `Conflict`，提示删除目标在准备后发生变化并可重试；不得删除 `secret_refs`。服务器删除成功后，才删除 owner_type/owner_id/ref 都匹配的元数据并提交事务。

- [ ] **Step 6: 重排命令编排**

`delete_server` 的 operation 必须是：

```rust
let result = async {
    let secret_ref = repository.deletion_secret_ref(server_id).await?;
    if let Some(secret_ref) = &secret_ref {
        secret_store.delete(secret_ref).await?;
    }
    repository.delete(server_id, secret_ref.as_ref()).await
}
.await;
```

随后复用 `audit_server_outcome`；仅 `result.is_ok()` 写 success。确认取消分支仍在任何 DB/keyring 操作前返回。

- [ ] **Step 7: 验证 GREEN 和 repository 回归**

Run:

```bash
cargo test -p opspilot-desktop commands::server::tests --offline
cargo test -p opspilot-persistence --test server_repository --offline
```

Expected: 凭据失败保留 DB、数据库失败可重试收敛、正常删除同时清理三处状态。

- [ ] **Step 8: 工作树检查点**

运行 `git diff --check`；不要暂存或提交。

---

### Task 5: 关闭共享凭据引用的并发竞态

**Files:**
- Create: `crates/persistence/migrations/0004_unique_server_secret_refs.sql`
- Modify: `crates/persistence/src/database.rs`
- Modify: `crates/persistence/tests/server_catalog_migration.rs`
- Modify: `crates/persistence/tests/server_repository.rs`

- [ ] **Step 1: 写 v3 存量共享引用和数据库唯一约束测试**

用 `run_to(3)` 创建临时库，让两台服务器共享一个 ref；断言 `Database::open` 返回不包含 ref、
但包含两台服务器 ID 和修复动作的 `Validation`。另断言已迁移数据库拒绝把同一 ref 写给
第二台服务器。

- [ ] **Step 2: 验证 RED**

```bash
cargo test -p opspilot-persistence --test server_catalog_migration --offline
```

Expected: 当前 v3 库直接打开，且迁移版本仍为 3。

- [ ] **Step 3: 新增 0004 与迁移前预检**

创建 partial unique index：

```sql
CREATE UNIQUE INDEX idx_servers_unique_secret_ref
ON servers(secret_ref)
WHERE secret_ref IS NOT NULL;
```

迁移前在该索引缺失时稳定列出第一组共享引用的服务器 ID；迁移后验证索引为预期的 unique
partial index，schema drift 时拒绝启动。

- [ ] **Step 4: 验证 GREEN**

```bash
cargo test -p opspilot-persistence --test server_catalog_migration --offline
cargo test -p opspilot-persistence --test server_repository --offline
```

Expected: v3 诊断、修复后升级、运行时唯一约束和损坏数据删除保护全部通过。

---

### Task 6: 全量验证与独立复审

**Files:**
- Verify only: entire workspace

**Interfaces:**
- Consumes: Tasks 1–5 的最终工作树。
- Produces: 可交付的测试证据和无 Critical/Important 的独立代码审查结论。

- [ ] **Step 1: 运行 Rust 全量测试**

```bash
cargo test --workspace --all-targets --offline
```

Expected: 全部非 ignored 测试通过。

- [ ] **Step 2: 运行工作区测试和静态验证**

```bash
pnpm test
pnpm verify:static
```

Expected: package、smoke、lint、typecheck、format、clippy 全部通过且无 warning。

- [ ] **Step 3: 检查差异边界**

运行 `git diff --check`、`git status --short` 和针对本计划文件的 diff。确认没有改动 0003 migration、没有清除用户暂存内容、没有 secret value/ref 出现在错误或审计 fixture 输出。

- [ ] **Step 4: 请求独立代码审查**

审查范围限定为本计划产生的未暂存 diff；要求核对错误码/消息、迁移可重试性、凭据删除故障矩阵、测试真实性和数据泄漏。Critical/Important 必须在交付前修复并重新验证。

- [ ] **Step 5: 交付但不提交**

报告修改、验证结果和仍未暂存的文件。实际 `git add`/`git commit` 仅在用户后续明确要求并确认提交信息后执行。
