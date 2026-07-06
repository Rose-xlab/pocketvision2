# PocketVision — register the two additional money-engine streams as
# scheduled tasks (crypto paper scan + funding harvester). Run ON THE VPS,
# as administrator, from C:\pocketvision, AFTER the main setup script:
#   powershell -ExecutionPolicy Bypass -File deploy\vps-add-streams.ps1
#
# Both are paper-mode, browserless (public Binance/Bybit data, no keys) and
# light — they share the box with the PO scanner comfortably. Same service
# pattern as PocketVision: start at logon, restart on crash, 15-min reviver.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$npmCmd = Join-Path $env:ProgramFiles 'nodejs\npm.cmd'
if (-not (Test-Path $npmCmd)) { $npmCmd = (Get-Command npm.cmd).Source }

$streams = @(
  @{ Name = 'PocketVisionCrypto';  Script = 'scan:crypto'; Log = 'logs\service-crypto.log' },
  @{ Name = 'PocketVisionFunding'; Script = 'funding';     Log = 'logs\service-funding.log' }
)

foreach ($s in $streams) {
  Write-Host "Registering scheduled task '$($s.Name)' ($($s.Script))…"
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' `
    -Argument "/c set `"PV_SERVICE=1`" && cd /d `"$root`" && `"$npmCmd`" run $($s.Script) >> $($s.Log) 2>&1"
  $logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $every15 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
  $settings = New-ScheduledTaskSettingsSet `
    -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Unregister-ScheduledTask -TaskName $s.Name -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $s.Name -Action $action -Trigger $logon, $every15 `
    -Settings $settings -RunLevel Highest | Out-Null
}

Write-Host ''
Write-Host 'Done. Start them now with:' -ForegroundColor Green
Write-Host '  Start-ScheduledTask -TaskName PocketVisionCrypto'
Write-Host '  Start-ScheduledTask -TaskName PocketVisionFunding'
Write-Host 'Logs: logs\service-crypto.log and logs\service-funding.log'
