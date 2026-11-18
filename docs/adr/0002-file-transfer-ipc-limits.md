# 0002 — 文件传输的 IPC 硬上限

## Status

**Accepted** — 2026-11-18

## Context

Issue #1 的用户故事 #13 与任务单 #5/#6 只要求“大文件有明确提示”。实现中，`file_download`、`file_upload` 与 `file_write` 通过 Tauri IPC 传递完整字节数组，WebView 与 Rust 进程都会为单个文件持有完整副本。

实测边界：

- 单文件上传/下载各 16 MiB，整批上传 16 MiB、最多 32 个文件；
- 在线编辑读取 1 MiB、保存 4 MiB；
- 超过 4 MiB 先给出确认提示，超过硬上限直接拒绝，且拒绝发生在读取文件之前。

如果把上限改成“只警告”，一次 200 MiB 的下载会在 WebView 中同时存在 JSON 数组、`Uint8Array` 与 `Blob` 三份副本，足以让桌面窗口崩溃。真正的“只警告”需要分块传输：Rust 侧按偏移读写、前端按 `Blob.slice()` 组装、上传需要服务端暂存句柄与清理协议。

## Decision

v1 保留 **16 MiB 硬上限**，并把它作为显式产品约束记录：

- 4 MiB 以上要求用户确认，文案说明内存与 IPC 成本；
- 16 MiB 以上在读取文件前拒绝，文案说明这是 Harbor 的传输上限，而不是远端文件错误；
- Rust、`packages/contracts` 与 UI 共用同一组常量，`tests/integration/dto-contract.test.ts` 校验两侧一致；
- 不在 v1 实现分块传输。

本 ADR 覆盖 Issue #1 中“只警告”的措辞；任务单 #5/#6 的“大文件提示”由 4 MiB 确认与 16 MiB 拒绝共同满足。

## Consequences

### 正面

- 峰值内存可预测，不会因单个文件拖垮 WebView；
- 超限在读取前失败，不会先消耗网络与内存再报错；
- 常量在 Rust、契约与 UI 三处有自动化一致性测试。

### 负面

- 无法通过 Harbor 传输大于 16 MiB 的文件；用户需要 `scp`/`rsync` 或后续版本的分块传输；
- “大文件警告”在产品语义上弱于“允许继续”，验收矩阵必须如实标注。

### 后续动作

- 若未来实现分块传输，新增 `file_download_chunk` / 上传暂存协议时必须保持路径校验、no-clobber 提交与回滚语义；
- 删除本 ADR 前先更新 Issue #1 与验收矩阵。
