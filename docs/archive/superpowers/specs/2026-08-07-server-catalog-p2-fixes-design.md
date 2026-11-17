# Server Catalog P2 修复设计

日期：2026-08-07

## 目标与范围

本次修复覆盖服务器目录首轮实现中的三个一致性问题：

1. 持久化层必须根据实际资源和操作返回准确的约束错误，不能把标签或凭据元数据问题误报为服务器连接身份冲突。
2. 旧版 v1/v2 数据库升级到 0003 前，必须识别归一化后重复的服务器身份，并返回可操作的诊断，不能让唯一索引以底层 SQLite 错误阻断启动。
3. 删除带凭据的服务器时，必须先完成系统凭据清理，再删除数据库记录；凭据后端失败时不得提交数据库删除。

不在本次范围内：自动合并旧库重复服务器、通用迁移修复 UI、持久化凭据清理队列，以及跨 SQLite 与系统 keyring 的完全分布式事务。

## CR-002：上下文化约束错误

持久化层不再使用一个全局 `map_write_error` 把所有唯一键和外键错误映射成固定消息。约束类别通过 SQLx 数据库错误类型判断，不再依赖 SQLite 英文错误字符串；具体错误码和消息由执行语句的上下文决定：

- 服务器归一化身份冲突：`Conflict`，说明 host、port、username 组合已存在。
- 标签名称冲突：`Conflict`，说明标签名称已存在。
- 未知 group/tag：`Validation`，说明服务器引用不存在的目录项。
- 重复 `tagIds`：在 `ServerInput::try_new` 中直接返回 `Validation`，不进入数据库事务。
- 共享或不一致的凭据引用：视为已持久化数据不变量破坏，返回带凭据元数据上下文的 `Internal`，不得误报为未知 group/tag。
- 其他数据库错误：保留操作上下文并映射为 `Internal`。

错误中不得包含 secret value 或 keyring account；允许包含非敏感资源类型和服务器 ID。

## CR-003：0003 迁移前重复预检

`Database::connect` 在运行 SQLx migrator 前增加旧服务器身份预检，并复用现有 `validate_legacy_secret_references` 的失败策略。

预检只在 `servers` 表存在且 `idx_servers_normalized_identity` 尚不存在时执行。查询按照 0003 索引的同一规则分组：`lower(trim(host))`、`port`、`trim(username)`。发现第一组重复时返回 `CoreErrorCode::Validation`，消息包含：

- 归一化 host、port、username；
- 该组全部服务器 ID，顺序稳定；
- 明确的恢复动作：修改或删除重复记录后重试。

预检不自动选择保留项、不修改数据，也不改写 0003 migration。这样不会引入数据丢失，也不会改变已经运行过 0003 的数据库 checksum。用户修正旧库后再次打开，迁移应正常完成并把 `environment` 回填为 `other`。

## CR-004：凭据优先的幂等删除

删除流程采用以下顺序：

1. 数据库只读解析删除目标和可选 `secret_ref`；服务器不存在或引用非法时立即失败，不产生外部副作用。
2. 若有 `secret_ref`，调用 `SecretStore.delete`。
3. 凭据删除成功后，以服务器 ID 和预期 `secret_ref` 为条件，在一个 SQLite 事务中删除服务器及其 `secret_refs` 元数据。
4. 根据最终结果写入脱敏审计。

`deletion_secret_ref` 的只读检查与外部 keyring 删除不能共享 SQLite 事务，因此新增
`0004_unique_server_secret_refs.sql`，以 partial unique index 在数据库层保证每个非空
`secret_ref` 最多被一台服务器引用。这样即使并发写入发生在检查之后，第二个所有者也会在
keyring 删除前被数据库拒绝，不会形成“共享引用已指向被删除凭据”的不可恢复状态。0004
执行前会诊断 v3 存量共享引用；错误只列服务器 ID，不回显作为 keyring account 的 ref。

`SecretStore.delete` 定义为幂等的目标状态操作：目标不存在等价于已经删除，应返回成功；操作系统凭据后端不可用、权限错误或其他真实失败仍返回 `SecretUnavailable`。内存实现和 keyring 实现遵循同一契约。

故障语义如下：

- 凭据删除失败：服务器、关系和 `secret_refs` 元数据完整保留，审计为 failure，可安全重试。
- 凭据已删除、数据库删除失败：数据库记录保留，审计为 failure；再次删除时凭据的幂等删除成功，然后重试数据库步骤，最终收敛。
- 两步均成功：数据库和 keyring 均不再持有该服务器的引用，审计为 success。

删除前必须拒绝共享或 owner 不一致的 `secret_ref`，避免在已损坏数据上先删除仍被其他服务器需要的凭据。
SQLite 还必须拒绝把同一非空 `secret_ref` 关联给第二台服务器；v3 存量共享引用必须先人工
修复，之后才运行 0004。

## 测试设计

所有行为变更使用 red-green TDD：测试先在当前实现上以预期原因失败，再写最小实现。

### 领域与持久化

- `ServerInput` 拒绝重复 `tagIds`，错误码为 `Validation`。
- 创建和更新同名标签返回标签冲突，而非服务器身份冲突。
- 未知 group/tag 保持 `Validation` 且事务无部分写入。
- 共享凭据引用删除返回不变量错误，服务器和元数据均保留。
- v2 临时数据库包含两条归一化重复服务器时，`Database::open` 返回 `Validation`，诊断包含两个 ID 和归一化身份。
- 修正其中一条记录后重试，0003 迁移成功、两条数据均保留且唯一索引存在。
- v3 存在共享凭据引用时，0004 前返回不泄露 ref 的可操作诊断；修正后迁移成功并创建
  `idx_servers_unique_secret_ref`。
- 数据库唯一约束拒绝第二台服务器抢占同一 `secret_ref`，关闭删除准备与 keyring 删除之间
  的 TOCTOU 窗口。

### SecretStore 与命令层

- MemorySecretStore 连续删除同一引用两次均成功；删除后读取仍返回 `SecretUnavailable`。
- keyring `NoEntry` 被归类为删除成功，其他后端错误保持失败。
- 注入凭据删除失败时，服务器、标签关系和 `secret_refs` 元数据均保留，只写 failure 审计。
- 凭据删除成功后注入数据库删除失败，数据库记录保留；移除故障后重试可完成清理。
- 正常删除最终同时移除凭据、服务器记录和引用元数据，只写 success 审计。

## 风险控制与验收

系统 keyring 和 SQLite 无法提供共同原子事务。本设计选择凭据优先并依赖幂等重试收敛，避免产生不可定位的外部孤儿凭据；极端情况下可能短暂保留一个指向已删除凭据的可见服务器记录，但该状态可诊断、可重试，优于服务器消失后永久丢失凭据定位信息。

验收要求：目标测试、完整 Rust 测试、工作区测试、lint、typecheck、format 和 clippy 全部通过；代码审查不得存在 Critical 或 Important 问题。
