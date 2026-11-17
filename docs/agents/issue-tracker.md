# Issue tracker

议题保存在本仓库的 GitHub Issues 中，使用 `gh` CLI 读写。

- 仓库：`SupremacySakura/ssh-ops-desktop`
- 默认分支：`master`

## 常用命令

```bash
gh issue list                                # 列出议题
gh issue view <number>                       # 查看议题详情
gh issue create --title "..." --body "..."   # 创建议题
gh issue edit <number> --add-label <label>   # 加标签
gh issue close <number>                      # 关闭议题
```

## 标签

使用 `docs/agents/triage-labels.md` 中定义的五个规范标签，对应五种分诊角色。

## PR 作为请求入口

**关闭**。外部 PR 不进入分诊队列；如需启用，请编辑本文件并明确流程。
