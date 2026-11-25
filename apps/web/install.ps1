# CircuitGit local connector one-line installer for Windows (PowerShell).
# Usage:
#   irm https://circuitgit-dev.github.io/CircuitGit/install.ps1 | iex
# Optional env vars:
#   $env:CIRCUITGIT_DIR = "$env:USERPROFILE\CircuitGit"
#   $env:CIRCUITGIT_AUTOSTART = "1"
$ErrorActionPreference = 'Stop'

$RepoUrl = 'https://github.com/CircuitGit-dev/CircuitGit.git'
$DefaultDir = Join-Path $env:USERPROFILE 'CircuitGit'

Write-Host ''
Write-Host '=========================================='
Write-Host '  CircuitGit 本机连接器 · 一键安装 (Windows)'
Write-Host '=========================================='
Write-Host ''

# 1. Choose install directory
$InstallDir = $env:CIRCUITGIT_DIR
if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  try {
    $UserInput = Read-Host "安装目录 [默认 $DefaultDir，直接回车确认，或输入自定义路径]"
    if ([string]::IsNullOrWhiteSpace($UserInput)) {
      $InstallDir = $DefaultDir
    } else {
      $InstallDir = $UserInput.Trim()
    }
  } catch {
    $InstallDir = $DefaultDir
  }
}
$InstallDir = [Environment]::ExpandEnvironmentVariables($InstallDir)
if ($InstallDir.StartsWith('~/') -or $InstallDir.StartsWith('~\')) {
  $InstallDir = Join-Path $env:USERPROFILE $InstallDir.Substring(2)
}
Write-Host "[1/4] 安装目录：$InstallDir"

# 2. Check Git & Python 3.11+
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Error "未检测到 Git。请先运行：winget install Git.Git （或从 https://git-scm.com/download/win 安装）后重试。"
  exit 1
}

$PyCmd = $null
$PyArgs = @()
if (Get-Command py -ErrorAction SilentlyContinue) {
  foreach ($ver in @('-3.14', '-3.13', '-3.12', '-3.11', '-3')) {
    & py $ver -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" *> $null
    if ($LASTEXITCODE -eq 0) {
      $PyCmd = 'py'
      $PyArgs = @($ver)
      break
    }
  }
}
if (-not $PyCmd) {
  foreach ($cand in @('python3', 'python')) {
    $found = Get-Command $cand -ErrorAction SilentlyContinue
    if ($found) {
      & $found.Source -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" *> $null
      if ($LASTEXITCODE -eq 0) {
        $PyCmd = $found.Source
        break
      }
    }
  }
}
if (-not $PyCmd) {
  foreach ($minor in @('314', '313', '312', '311')) {
    foreach ($base in @("$env:LOCALAPPDATA\Programs\Python\Python$minor\python.exe", "$env:ProgramFiles\Python$minor\python.exe")) {
      if (Test-Path $base) {
        $PyCmd = $base
        break
      }
    }
    if ($PyCmd) { break }
  }
}
if (-not $PyCmd) {
  Write-Error "需要 Python 3.11+。请先运行：winget install Python.Python.3.12 （或从 https://www.python.org/downloads/windows/ 安装）后重试。"
  exit 1
}
$PyVer = & $PyCmd @PyArgs --version 2>&1
Write-Host "[2/4] 环境就绪：Git + $PyVer"

# 3. Clone or fast-forward update repository
if (Test-Path (Join-Path $InstallDir '.git')) {
  Write-Host '[3/4] 检测到已有安装，检查更新…'
  $Dirty = & git -C $InstallDir status --porcelain 2>$null
  if ([string]::IsNullOrWhiteSpace(($Dirty -join ''))) {
    & git -C $InstallDir pull --ff-only origin main
  } else {
    Write-Host '  (检测到本地改动，已保留现有目录内容)'
  }
} elseif ((Test-Path $InstallDir) -and ((Get-ChildItem -Force $InstallDir | Measure-Object).Count -gt 0)) {
  Write-Error "目标目录非空且不是 CircuitGit 仓库：$InstallDir 。请重新运行并选择新的文件夹。"
  exit 1
} else {
  Write-Host "[3/4] 正在下载 CircuitGit 到 $InstallDir …"
  $ParentDir = Split-Path -Parent $InstallDir
  if ($ParentDir -and -not (Test-Path $ParentDir)) {
    New-Item -ItemType Directory -Path $ParentDir -Force | Out-Null
  }
  & git clone --depth 1 --branch main $RepoUrl $InstallDir
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

# 4. Setup isolated SpiceOwl Python environment + register circuitgit:// + start connector
Write-Host '[4/4] 初始化项目专用 Python 与 SpiceOwl 环境（首次约 1–2 分钟，不改动全局 Python）…'
$BootstrapScript = Join-Path $InstallDir 'tools\workbench\bootstrap_python.py'
$InstallerScript = Join-Path $InstallDir 'tools\workbench\connector_install.py'

& $PyCmd @PyArgs -E -s -B $BootstrapScript --setup-only | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Error '初始化 Python / SpiceOwl 环境失败，请检查网络或上方错误提示。'
  exit $LASTEXITCODE
}

if ($env:CIRCUITGIT_AUTOSTART -eq '1') {
  & $PyCmd @PyArgs -E -s -B $InstallerScript install --autostart | Out-Null
} else {
  & $PyCmd @PyArgs -E -s -B $InstallerScript install | Out-Null
}

Write-Host '正在后台启动本机连接器…'
& $PyCmd @PyArgs -E -s -B $InstallerScript handle-uri 'circuitgit://start' | Out-Null

$Ready = $false
for ($i = 0; $i -lt 20; $i++) {
  try {
    $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:8767/health' -Headers @{ Origin = 'https://circuitgit-dev.github.io' } -TimeoutSec 1
    if ($resp.ok -eq $true) { $Ready = $true; break }
  } catch {}
  Start-Sleep -Milliseconds 500
}

Write-Host ''
Write-Host '=========================================='
if ($Ready) {
  Write-Host '  ✓ 安装完成！CircuitGit 本机连接器已在后台运行。'
} else {
  Write-Host '  ✓ 安装完成！连接器正在后台启动。'
}
Write-Host "  安装路径：$InstallDir"
Write-Host '  已注册 circuitgit:// 协议，以后可直接在网页点击连接。'
Write-Host '  请切回浏览器：https://circuitgit-dev.github.io/CircuitGit/'
Write-Host '  点击弹窗中的「我已启动，重新连接」或「立即授权并连接」即可开始使用！'
Write-Host '=========================================='
Write-Host ''
