#!/usr/bin/env bash
set -euo pipefail

: "${FEISHU_DOCUMENT_ID:?请先设置 FEISHU_DOCUMENT_ID 为目标飞书文档 ID}"
document_id="$FEISHU_DOCUMENT_ID"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source_file="$script_dir/SSH服务器运维桌面软件-完整产品与技术设计文档-V1.1.md"
tmp_root="${TMPDIR:-/tmp}"
payload_file="$(mktemp "${tmp_root%/}/ssh-ops-feishu-section.XXXXXX")"
trap 'rm -f -- "$payload_file"' EXIT
user_token="$(feishu-cli auth token --as user)"

extract_section() {
  local title="$1"
  local level="${title%% *}"
  local level_length="${#level}"

  awk -v target="$title" -v max_level="$level_length" '
    $0 == target {
      capturing = 1
      print
      next
    }
    capturing {
      if (match($0, /^#+/) && RLENGTH <= max_level) {
        exit
      }
      print
    }
  ' "$source_file" > "$payload_file"

  if [[ ! -s "$payload_file" ]]; then
    printf '未找到章节: %s\n' "$title" >&2
    exit 1
  fi
}

replace_section() {
  local title="$1"
  local response

  extract_section "$title"
  if ! response="$(feishu-cli doc content-update "$document_id" \
    --mode replace_range \
    --selection-by-title "$title" \
    --markdown-file "$payload_file" \
    --table-column-width auto \
    --user-access-token "$user_token" \
    -o json 2>&1)"; then
    printf '章节更新失败: %s\n%s\n' "$title" "$response" >&2
    exit 1
  fi
  printf '已更新: %s\n' "$title"
}

old_version="文档版本：V1.0｜日期：2026-08-06｜定位：macOS / Windows 本地优先的 SSH 与服务器项目管理工具"
new_version="文档版本：V1.1｜日期：2026-08-06｜定位：macOS / Windows 本地优先、AI Agent 驱动的 SSH 与服务器项目管理工具"
version_response="$(feishu-cli doc content-update "$document_id" \
  --mode replace_all \
  --selection-with-ellipsis "$old_version" \
  --markdown "$new_version" \
  --user-access-token "$user_token" \
  -o json 2>&1)" || {
    printf '版本信息更新失败:\n%s\n' "$version_response" >&2
    exit 1
  }
printf '已更新: 文档版本 V1.1\n'

sections=(
  "## 0. 执行摘要"
  "## 5. 总体架构"
  "## 6. 产品功能架构"
  "## 7. 详细功能设计"
  "## 9. 推荐技术栈"
  "## 10. 核心技术流程"
  "## 11. 本地数据模型"
  "## 12. Core API 与事件设计"
  "## 13. 安全设计"
  "## 14. 可靠性、错误处理与回滚"
  "## 16. 非功能要求与目标"
  "## 17. 测试策略"
  "## 18. 构建、发布与更新"
  "## 19. 版本规划"
  "## 20. MVP 验收标准"
  "## 21. 主要风险与对策"
  "## 22. 商业化与扩展方向"
  "## 23. 推荐仓库结构"
  "## 24. 关键架构决策记录"
  "## 25. 参考依据"
  "## 附录 A：操作风险分级"
  "## 附录 B：MVP Backlog（按优先级）"
)

for section in "${sections[@]}"; do
  replace_section "$section"
done

printf '全部章节更新完成。\n'
