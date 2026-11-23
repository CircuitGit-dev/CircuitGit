#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1
bootstrap_python=''
for candidate in .venv/bin/python python3 python3.14 python3.13 python3.12 python3.11 \
  /opt/homebrew/bin/python3{,.14,.13,.12,.11} /usr/local/bin/python3{,.14,.13,.12,.11}; do
  if command -v "$candidate" >/dev/null 2>&1; then
    bootstrap_python="$candidate"
    break
  fi
done
if [ -z "$bootstrap_python" ]; then
  echo '需要 Python 3.11+。请安装后重新打开此启动器。'
  read -r -p '按回车关闭。'
  exit 1
fi
"$bootstrap_python" -E -s -B tools/workbench/bootstrap_python.py "$@"
launch_status=$?
if [ "$launch_status" -ne 0 ]; then
  read -r -p '未能启动。请查看上方提示，按回车关闭。'
fi
exit "$launch_status"
