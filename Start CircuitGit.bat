@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>&1
cd /d "%~dp0" || exit /b 1

set "PY_CMD="
set "PY_ARG="

if exist ".venv\Scripts\python.exe" (
  set "PY_CMD=.venv\Scripts\python.exe"
  goto :launch
)

where py >nul 2>&1
if %ERRORLEVEL%==0 (
  for %%V in (3.14 3.13 3.12 3.11 3) do (
    py -%%V -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1
    if not errorlevel 1 (
      set "PY_CMD=py"
      set "PY_ARG=-%%V"
      goto :launch
    )
  )
)

for %%C in (python3.exe python.exe) do (
  where %%C >nul 2>&1
  if not errorlevel 1 (
    %%C -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1
    if not errorlevel 1 (
      set "PY_CMD=%%C"
      goto :launch
    )
  )
)

for %%V in (314 313 312 311) do (
  if exist "%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe" (
    set "PY_CMD=%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe"
    goto :launch
  )
  if exist "%ProgramFiles%\Python%%V\python.exe" (
    set "PY_CMD=%ProgramFiles%\Python%%V\python.exe"
    goto :launch
  )
)

echo 需要 Python 3.11+。请从 https://www.python.org/downloads/windows/ 安装并勾选 Add Python to PATH，然后重新双击此启动器。
pause
exit /b 1

:launch
if defined PY_ARG (
  "%PY_CMD%" %PY_ARG% -E -s -B tools\workbench\bootstrap_python.py %*
) else (
  "%PY_CMD%" -E -s -B tools\workbench\bootstrap_python.py %*
)
set "LAUNCH_STATUS=%ERRORLEVEL%"
if not "%LAUNCH_STATUS%"=="0" (
  echo.
  echo 未能启动。请查看上方提示信息。
  pause
)
exit /b %LAUNCH_STATUS%
