# Cyber-Fly 大脑 · 本机一键启动（Windows / 开热点的这台电脑）
#
# 目的：整套大脑可以跑在本地电脑上，完全不占那台还挂着 2~3 个项目的云服务器。
#       板子连这台电脑的 2.4 GHz 移动热点，HOST 填本机在热点网段的 IPv4。
#
# 用法（在本文件所在目录，或任意目录用绝对路径）：
#   powershell -ExecutionPolicy Bypass -File start_local.ps1                 # 轻量档：2 个进程
#   powershell -ExecutionPolicy Bypass -File start_local.ps1 -WithDashboard  # 加看板，可调感官参数
#   powershell -ExecutionPolicy Bypass -File start_local.ps1 -Offset 1000    # 整套端口 +1000，避开别的项目
#
# 停止：powershell -ExecutionPolicy Bypass -File stop_local.ps1
#
# 进程用 -WindowStyle Hidden 启动，不会一直弹命令框；日志写在 D:\ESP\local\brain-*.log。

param(
    [int]$Offset = 0,                 # 端口整体偏移，例如 1000 -> 34333 / 34335 / 34338 / 9080
    [switch]$WithDashboard,           # 附带诊断 + 8080 看板（多 2 个进程、多一次影子脑开销）
    [switch]$Lite,                    # 轻量档：不开 --api（关掉 250ms 影子脑）、不开诊断、日志减半
    [double]$SenseGain = 0.18,        # 感官调制强度；0 = 一键退回纯原链路
    [string]$NodeExe = 'node'
)

$ErrorActionPreference = 'Stop'
$DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$LOCAL = 'D:\ESP\local'
if (-not (Test-Path $LOCAL)) { New-Item -ItemType Directory -Path $LOCAL -Force | Out-Null }

# ---- 连接组数据：本机必须有，但绝不进公开仓库（CC BY-NC 4.0，非 vendored） ----
$BrainJs = 'D:\ESP\tmp\flylab\dodge\brain.js'
$DataCandidates = @(
    (Join-Path $LOCAL 'flylab\results\dodge\subcircuit_v4.json'),
    'D:\ESP\tmp\flylab\results\dodge\subcircuit_v4.json'
)
$DataPath = $null
foreach ($c in $DataCandidates) { if (Test-Path $c) { $DataPath = $c; break } }

if (-not (Test-Path $BrainJs)) {
    Write-Host "[缺文件] 找不到 dodge/brain.js：$BrainJs" -ForegroundColor Red
    exit 1
}
if (-not $DataPath) {
    Write-Host "[缺数据] 本机没有连接组 subcircuit_v4.json，大脑无法在本机启动。" -ForegroundColor Yellow
    Write-Host "  请从云端那台机器拷一份到（仓外、不会提交）：" -ForegroundColor Yellow
    Write-Host "    $($DataCandidates[0])" -ForegroundColor Yellow
    Write-Host "  云端路径通常是 /root/flywire-fly-lab/results/dodge/subcircuit_v4.json" -ForegroundColor Yellow
    Write-Host "  数据为 CC BY-NC 4.0，仅限本地运行，不要放进任何 git 仓库。" -ForegroundColor Yellow
    Write-Host "  拷好后重新运行本脚本即可。" -ForegroundColor Yellow
    exit 1
}

# ---- 端口：一个 Offset 平移整套，跟同机其它项目零冲突 ----
$IN_PORT    = 33333 + $Offset
$BRAIN_PORT = 33335 + $Offset
$WATCH_PORT = 33336 + $Offset
$API_PORT   = 33338 + $Offset
$WATCH_HTTP = 33340 + $Offset
$DASH_HTTP  = 8080  + $Offset

# ---- 环境变量（子进程继承） ----
$env:FLYLAB = 'D:\ESP\tmp\flylab'
$env:FLYDATA = $DataPath
$env:FLY_IN_PORT = "$IN_PORT"
$env:FLY_BRAIN_PORT = "$BRAIN_PORT"
$env:FLY_WATCH_PORT = "$WATCH_PORT"
$env:FLY_WATCH_HTTP = "$WATCH_HTTP"
$env:FLY_BRAIN_API = "http://127.0.0.1:$API_PORT/api"
$env:FLY_DIAG_API = "http://127.0.0.1:$WATCH_HTTP/api"
$env:FLY_DASH_HTTP = "$DASH_HTTP"
$env:FLY_SENSE_GAIN = "$SenseGain"
$env:FLY_SENSE_TUNE = if ($WithDashboard) { '1' } else { '0' }
$env:FLY_DASH_POLL_MS = if ($Lite) { '1000' } else { '300' }

if ($WithDashboard) { $ApiArg = "$API_PORT" } else { $ApiArg = '0' }
if ($Lite) { $ApiArg = '0' }

$pidFile = Join-Path $LOCAL 'cyber_fly_brain.pids'
if (Test-Path $pidFile) {
    Write-Host "[已运行] 检测到 $pidFile，请先跑 stop_local.ps1。" -ForegroundColor Yellow
    exit 1
}
$pids = @()

function Start-Node($name, $script, $argList) {
    $out = Join-Path $LOCAL ("brain-$name.out.log")
    $err = Join-Path $LOCAL ("brain-$name.err.log")
    $p = Start-Process -FilePath $NodeExe -WorkingDirectory $DIR `
        -ArgumentList (@($script) + $argList) -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $out -RedirectStandardError $err
    Write-Host ("  启动 {0,-12} PID={1}  {2}" -f $name, $p.Id, ($argList -join ' '))
    return $p.Id
}

Write-Host "=== Cyber-Fly 大脑 · 本机模式 ==="
Write-Host "  连接组  $DataPath"
Write-Host "  端口    IN=$IN_PORT  BRAIN=$BRAIN_PORT  WATCH=$WATCH_PORT  API=$ApiArg  DASH=$DASH_HTTP"
Write-Host "  感官    gain=$SenseGain  stale=2500ms  tune=$($env:FLY_SENSE_TUNE)"

$pids += Start-Node 'relay' 'relay.js' @()
$stageArgs = @('--serve', '--port', "$BRAIN_PORT", '--api', "$ApiArg")
if ($Lite) { $stageArgs += '--quiet' }
$pids += Start-Node 'stage1' 'stage1_loop.js' $stageArgs

if ($WithDashboard) {
    $pids += Start-Node 'watch2' 'fly_watch2.js' @()
    $pids += Start-Node 'dashboard' 'fly_dashboard.js' @()
    Write-Host "  看板    http://127.0.0.1:$DASH_HTTP/ （感官面板 + gain 滑块）"
}

$pids | Out-File -Encoding ascii $pidFile
Write-Host ""
Write-Host "=== 板端要填的网络值 ==="
Write-Host "  HOST = 本机在【热点网段】的 IPv4（ipconfig 查 '无线局域网适配器 本地连接* N'，常为 192.168.137.1）"
Write-Host "  PORT = $IN_PORT"
Write-Host "  填到 D:\ESP\local\cyber_fly_net.conf，再跑："
Write-Host "    python D:\ESP\esp-mosaico-vibe\tools\set_local_net.py"
Write-Host ""
Write-Host "  日志  $LOCAL\brain-*.log   ｜ 停止  stop_local.ps1"
Write-Host "  轻量档只跑 2 个进程；云服务器一个进程都不用开。"
