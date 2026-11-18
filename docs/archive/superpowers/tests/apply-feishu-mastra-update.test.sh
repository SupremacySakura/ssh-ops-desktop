#!/usr/bin/env bash
set -euo pipefail

test_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
target_script="$test_dir/../apply-feishu-mastra-update.sh"
fixture_bin="$test_dir/fixtures"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/apply-feishu-mastra-update-test.XXXXXX")"
cli_log="$test_root/feishu-cli.log"
command_output="$test_root/command-output.log"
trap 'rm -rf -- "$test_root"' EXIT

touch "$cli_log"

if PATH="$fixture_bin:$PATH" \
  FEISHU_CLI_TEST_LOG="$cli_log" \
  "$target_script" > "$command_output" 2>&1; then
  printf 'FAIL: 未设置 FEISHU_DOCUMENT_ID 时脚本仍然执行成功\n' >&2
  exit 1
fi

if ! grep -q 'FEISHU_DOCUMENT_ID' "$command_output"; then
  printf 'FAIL: 缺少 FEISHU_DOCUMENT_ID 时未返回可操作的错误信息\n' >&2
  exit 1
fi

: > "$cli_log"

PATH="$fixture_bin:$PATH" \
  FEISHU_CLI_TEST_LOG="$cli_log" \
  FEISHU_DOCUMENT_ID="fixture-document-id" \
  "$target_script" > "$command_output"

update_count="$(wc -l < "$cli_log" | tr -d ' ')"
if [[ "$update_count" != "23" ]]; then
  printf 'FAIL: 预期执行 23 次文档更新，实际为 %s 次\n' "$update_count" >&2
  exit 1
fi

while IFS= read -r actual_document_id; do
  if [[ "$actual_document_id" != "fixture-document-id" ]]; then
    printf 'FAIL: 文档更新使用了错误的 document ID: %s\n' "$actual_document_id" >&2
    exit 1
  fi
done < "$cli_log"

printf 'PASS: 飞书更新脚本强制使用调用方提供的 document ID\n'
