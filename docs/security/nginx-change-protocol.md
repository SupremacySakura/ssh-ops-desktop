# Nginx 安全变更协议

OpsPilot 不提供直达 Nginx 写命令。所有变更必须以不可变 `ToolCall` 进入统一 Operation Gateway，并按 L3 操作要求绑定参数摘要、远端路径和逐字确认。

执行顺序固定为：保留 owner/mode 创建快照；在 live 文件同目录创建候选文件；使用目标 `nginx -t -c` 验证；同文件系统原子替换；reload；可选健康检查。语法验证失败时 live 文件不发生替换；reload 或健康检查失败时，Core 从快照原子恢复并再次 reload。快照文件名由 `toolCallId` 决定，便于从任务和审计记录反查。

候选配置最大 1 MiB。路径必须为无 `..` 的绝对路径，健康地址只允许无凭据的 HTTP(S) URL。命令由固定 program 和逐参数 POSIX 编码器构造，Nginx 写适配器不会注册为独立 Tauri command。
