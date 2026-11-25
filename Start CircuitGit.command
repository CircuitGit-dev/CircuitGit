#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1

echo '=========================================='
echo '  CircuitGit (macOS 启动器)'
echo '=========================================='

bootstrap_python=''
for candidate in .venv/bin/python \
  /opt/homebrew/bin/python3.14 /opt/homebrew/bin/python3.13 /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.11 /opt/homebrew/bin/python3 \
  /usr/local/bin/python3.14 /usr/local/bin/python3.13 /usr/local/bin/python3.12 /usr/local/bin/python3.11 /usr/local/bin/python3 \
  python3.14 python3.13 python3.12 python3.11 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then
    if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; then
      bootstrap_python="$candidate"
      break
    fi
  fi
done

if [ -z "$bootstrap_python" ]; then
  echo '[CircuitGit] 需要 Python 3.11+（未找到符合版本的解释器）。'
  echo '  推荐安装方式：brew install python@3.12'
  echo '  或从官网下载：https://www.python.org/downloads/macos/'
  read -r -p '按回车关闭。'
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo '[CircuitGit] 需要 Git 才能管理电路版本与安装依赖。'
  echo '  推荐安装方式：xcode-select --install  或  brew install git'
  read -r -p '按回车关闭。'
  exit 1
fi

py_ver="$("$bootstrap_python" -c 'import sys; print(".".join(map(str, sys.version_info[:3])))' 2>/dev/null)"
git_ver="$(git --version 2>/dev/null)"
echo "[CircuitGit] Python ${py_ver:-3.11+} (${bootstrap_python}) · ${git_ver:-git}"
echo '[CircuitGit] 正在启动本机工作台助手，启动后请保持此窗口运行…'
echo

"$bootstrap_python" -E -s -B tools/workbench/bootstrap_python.py "$@"
launch_status=$?
if [ "$launch_status" -ne 0 ]; then
  echo
  read -r -p '未能启动。请查看上方提示，按回车关闭。'
fi
exit "$launch_status"
