# 停止 start_local.ps1 启动的全部本机大脑进程
$pidFile = 'D:\ESP\local\cyber_fly_brain.pids'
if (-not (Test-Path $pidFile)) {
    Write-Host "没有找到 $pidFile —— 本来就没在跑。"
    exit 0
}
$lines = @(Get-Content $pidFile | Where-Object { $_ -match '^\d+$' })
foreach ($line in $lines) {
    $proc = Get-Process -Id ([int]$line) -ErrorAction SilentlyContinue
    if ($proc) {
        Stop-Process -Id ([int]$line) -Force -ErrorAction SilentlyContinue
        Write-Host ("  已停止 PID={0} ({1})" -f $line, $proc.ProcessName)
    } else {
        Write-Host ("  跳过 PID={0}（已退出）" -f $line)
    }
}
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "本机大脑已全部停止；云服务器不占任何资源。"
