#!/usr/bin/env bash
# TuttiKit pre-commit guard：拦敏感文件 + 密钥泄漏。
#
# 安装：
#   ln -sf ../../scripts/pre-commit.sh .git/hooks/pre-commit
#   chmod +x scripts/pre-commit.sh
#
# 临时绕过（自担风险）：git commit --no-verify

set -e

RED="$(printf '\033[31m')"
YELLOW="$(printf '\033[33m')"
RESET="$(printf '\033[0m')"
GREEN="$(printf '\033[32m')"

violations=0

# ───────── 1. 文件名拦截 ─────────
# staged 文件（添加 + 修改 + 重命名后的新名字）
# core.quotepath=false：让非 ASCII 文件名（中文 / emoji）以 UTF-8 原样输出而不是 \345\260\217 转义
staged_files=$(git -c core.quotepath=false diff --cached --name-only --diff-filter=ACMR)

if [ -n "$staged_files" ]; then
  blocked_files=$(echo "$staged_files" | grep -E '(^|/)(小红书|公众号|草稿|drafts/|\.private/|secret|\.pem$|\.key$|\.env$|\.env\.local$|\.mcp\.json$)' || true)
  if [ -n "$blocked_files" ]; then
    echo "${RED}✗ pre-commit: 检测到敏感文件被 staged：${RESET}"
    echo "$blocked_files" | sed 's/^/    /'
    echo
    echo "  这些路径在 .gitignore 里就该被排除，可能是 git add -f 强加进来的。"
    echo "  确认要提交：git commit --no-verify （强烈不建议）"
    violations=1
  fi
fi

# ───────── 2. 内容扫描：API key / secret 字面量 ─────────
# 只扫被 staged 的文本内容（不扫 binary）
if [ -n "$staged_files" ]; then
  # 给 git diff 加 -U0：只看 + 的新增行
  patches=$(git diff --cached --unified=0 --diff-filter=ACM 2>/dev/null || true)
  if [ -n "$patches" ]; then
    # 排除合理白名单：.env.example、docs、test fixtures
    added_lines=$(echo "$patches" | grep -E '^\+[^+]' || true)

    # 各种 API key 前缀（Anthropic / OpenAI / 通用）
    leaks=$(echo "$added_lines" | grep -E '(sk-(ant-|proj-)?[A-Za-z0-9_-]{30,}|AIza[0-9A-Za-z_-]{30,}|xox[bpas]-[0-9A-Za-z]{10,}|ghp_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{50,})' || true)
    if [ -n "$leaks" ]; then
      echo "${RED}✗ pre-commit: diff 中疑似 API key / token：${RESET}"
      echo "$leaks" | head -5 | sed 's/^/    /'
      [ "$(echo "$leaks" | wc -l)" -gt 5 ] && echo "    ... ($(echo "$leaks" | wc -l | tr -d ' ') 行)"
      echo
      echo "  把 key 写到 .env，并 git restore --staged 这些文件"
      violations=1
    fi

    # 明文密码字段（password=、api_key=）
    passwords=$(echo "$added_lines" | grep -iE '^\+.*(password|passwd|api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*["'\'']?[a-zA-Z0-9_/@.+=-]{8,}' \
      | grep -vE '(your[_-]?(api[_-]?key|password)|REPLACE_ME|example|<.*>|\.\.\.|placeholder|YOUR_KEY)' \
      || true)
    if [ -n "$passwords" ]; then
      echo "${YELLOW}⚠ pre-commit: 看着像硬编码的密码 / API key：${RESET}"
      echo "$passwords" | head -5 | sed 's/^/    /'
      echo
      echo "  如果是占位符（YOUR_KEY 等）就放心提交（这条仅警告，不阻塞）"
      # 仅警告，不计入 violations
    fi
  fi
fi

if [ "$violations" -gt 0 ]; then
  echo "${RED}commit 被阻止。${RESET}"
  exit 1
fi
echo "${GREEN}✓ pre-commit 通过${RESET}" >&2
exit 0
