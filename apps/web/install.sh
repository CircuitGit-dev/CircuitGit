#!/usr/bin/env bash
# CircuitGit local connector one-line installer for macOS & Linux.
# Usage:
#   curl -fsSL https://circuitgit-dev.github.io/CircuitGit/install.sh | bash
# Optional env vars:
#   CIRCUITGIT_DIR=~/CircuitGit     Install directory (interactive prompt if unset on TTY)
#   CIRCUITGIT_AUTOSTART=1          Also enable silent login autostart
set -euo pipefail

REPO_URL="https://github.com/CircuitGit-dev/CircuitGit.git"
DEFAULT_DIR="${HOME}/CircuitGit"

printf '\n==========================================\n'
printf '  CircuitGit 本机连接器 · 一键安装 (macOS / Linux)\n'
printf '==========================================\n\n'

# 1. Choose install directory
INSTALL_DIR="${CIRCUITGIT_DIR:-}"
if [ -z "$INSTALL_DIR" ]; then
  if [ -r /dev/tty ]; then
    printf '安装目录 [默认 %s，直接回车确认，或输入自定义路径]: ' "$DEFAULT_DIR" >/dev/tty
    IFS= read -r USER_DIR </dev/tty || USER_DIR=""
    INSTALL_DIR="${USER_DIR:-$DEFAULT_DIR}"
  else
    INSTALL_DIR="$DEFAULT_DIR"
  fi
fi
# Expand leading ~
case "$INSTALL_DIR" in
  "~") INSTALL_DIR="$HOME" ;;
  "~/"*) INSTALL_DIR="${HOME}/${INSTALL_DIR#~/}" ;;
esac
printf '[1/4] 安装目录：%s\n' "$INSTALL_DIR"

# 2. Check Git & Python 3.11+
if ! command -v git >/dev/null 2>&1; then
  printf '\n[CircuitGit] 未检测到 Git。\n' >&2
  if [ "$(uname -s)" = "Darwin" ]; then
    printf '  请先运行：xcode-select --install\n' >&2
  else
    printf '  请先安装 Git（例如 sudo apt install -y git）后重试。\n' >&2
  fi
  exit 1
fi

PY_BIN=""
for candidate in \
  python3.14 python3.13 python3.12 python3.11 python3 \
  /opt/homebrew/bin/python3.14 /opt/homebrew/bin/python3.13 /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.11 /opt/homebrew/bin/python3 \
  /usr/local/bin/python3.12 /usr/local/bin/python3.11 /usr/local/bin/python3; do
  if command -v "$candidate" >/dev/null 2>&1; then
    resolved="$(command -v "$candidate")"
    if "$resolved" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; then
      PY_BIN="$resolved"
      break
    fi
  fi
done

if [ -z "$PY_BIN" ]; then
  printf '\n[CircuitGit] 需要 Python 3.11+。\n' >&2
  if [ "$(uname -s)" = "Darwin" ]; then
    printf '  推荐安装：brew install python@3.12\n' >&2
    printf '  或前往：https://www.python.org/downloads/macos/\n' >&2
  else
    printf '  请安装 Python 3.11+（例如 sudo apt install -y python3.12 python3.12-venv）后重试。\n' >&2
  fi
  exit 1
fi
printf '[2/4] 环境就绪：Git + %s\n' "$("$PY_BIN" --version 2>&1)"

# 3. Clone or fast-forward update repository
if [ -d "$INSTALL_DIR/.git" ]; then
  printf '[3/4] 检测到已有安装，检查更新…\n'
  if [ -z "$(git -C "$INSTALL_DIR" status --porcelain 2>/dev/null || true)" ]; then
    git -C "$INSTALL_DIR" pull --ff-only origin main || printf '  (跳过自动拉取，保留当前版本)\n'
  else
    printf '  (检测到本地改动，已保留现有目录内容)\n'
  fi
elif [ -e "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" ]; then
  printf '\n[CircuitGit] 目标目录非空且不是 CircuitGit 仓库：%s\n' "$INSTALL_DIR" >&2
  printf '  请重新运行并选择一个空目录或新的文件夹名称。\n' >&2
  exit 1
else
  printf '[3/4] 正在下载 CircuitGit 到 %s …\n' "$INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 --branch main "$REPO_URL" "$INSTALL_DIR"
fi

if [ "$(uname -s)" = "Darwin" ]; then
  xattr -dr com.apple.quarantine "$INSTALL_DIR" >/dev/null 2>&1 || true
fi

# 4. Setup isolated SpiceOwl Python environment + register circuitgit:// + start connector
printf '[4/4] 初始化项目专用 Python 与 SpiceOwl 环境（首次约 1–2 分钟，不改动全局 Python）…\n'
"$PY_BIN" -E -s -B "$INSTALL_DIR/tools/workbench/bootstrap_python.py" --setup-only >/dev/null

AUTOSTART_FLAG=""
if [ "${CIRCUITGIT_AUTOSTART:-0}" = "1" ]; then
  AUTOSTART_FLAG="--autostart"
fi
if [ -n "$AUTOSTART_FLAG" ]; then
  "$PY_BIN" -E -s -B "$INSTALL_DIR/tools/workbench/connector_install.py" install --autostart >/dev/null
else
  "$PY_BIN" -E -s -B "$INSTALL_DIR/tools/workbench/connector_install.py" install >/dev/null
fi

printf '正在后台启动本机连接器…\n'
"$PY_BIN" -E -s -B "$INSTALL_DIR/tools/workbench/connector_install.py" handle-uri "circuitgit://start" >/dev/null

READY=0
for _ in $(seq 1 20); do
  if curl -fsS -H "Origin: https://circuitgit-dev.github.io" "http://127.0.0.1:8767/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.5
done

printf '\n==========================================\n'
if [ "$READY" = "1" ]; then
  printf '  ✓ 安装完成！CircuitGit 本机连接器已在后台运行。\n'
else
  printf '  ✓ 安装完成！连接器正在后台启动。\n'
fi
printf '  安装路径：%s\n' "$INSTALL_DIR"
printf '  已注册 circuitgit:// 协议，以后可直接在网页点击连接。\n'
printf '  请切回浏览器：https://circuitgit-dev.github.io/CircuitGit/\n'
printf '  点击弹窗中的「我已启动，重新连接」或「立即授权并连接」即可开始使用！\n'
printf '==========================================\n\n'
