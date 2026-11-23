#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  echo '需要 Python 3.10+。请安装后重新打开此启动器。'
  read -r -p '按回车关闭。'
  exit 1
fi
python3 -B tools/workbench/connect_browser.py
if [ "$?" -ne 0 ]; then
  read -r -p '未能启动。请查看上方提示，按回车关闭。'
fi
