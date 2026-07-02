# PocketVision — one-shot Windows VPS setup.
# Run ON THE VPS, as administrator, from the extracted project folder:
#   powershell -ExecutionPolicy Bypass -File deploy\vps-setup-windows.ps1
#
# It: installs Node LTS, installs dependencies + Chromium, registers a
# scheduled task that starts the scanner at logon (and restarts it if it
# crashes), and optionally enables auto-logon so a VPS reboot brings the
# bot back without anyone touching it.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
Write-Host "PocketVision setup in $root" -ForegroundColor Cyan

# 1. Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '[1/5] Installing Node.js LTS…'
  $msi = Join-Path $env:TEMP 'node-lts.msi'
  Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.12.0/node-v22.12.0-x64.msi' -OutFile $msi
  Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn" -Wait
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
} else { Write-Host "[1/5] Node present: $(node -v)" }

# 2. Dependencies + browser
Write-Host '[2/5] npm install…'
npm install
Write-Host '[3/5] Installing Playwright Chromium…'
npx playwright install chromium
New-Item -ItemType Directory -Force (Join-Path $root 'logs') | Out-Null

# 3. Scheduled task: start at logon, restart on crash, no time limit.
Write-Host '[4/5] Registering scheduled task "PocketVision"…'
$action = New-ScheduledTaskAction -Execute 'cmd.exe' `
  -Argument "/c cd /d `"$root`" && npm run scan >> logs\service.log 2>&1"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Unregister-ScheduledTask -TaskName 'PocketVision' -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName 'PocketVision' -Action $action -Trigger $trigger `
  -Settings $settings -RunLevel Highest | Out-Null

# 4. Auto-logon (so a reboot restarts the bot unattended). The password is
# stored in the registry in cleartext — standard for single-purpose VPSes,
# but skip it if that bothers you (you'll just RDP in once after reboots).
Write-Host '[5/5] Auto-logon (recommended for 24/7).'
$answer = Read-Host 'Enable auto-logon? (y/n)'
if ($answer -eq 'y') {
  $pw = Read-Host 'Windows password for this account' -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw))
  $reg = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  Set-ItemProperty $reg -Name AutoAdminLogon -Value '1'
  Set-ItemProperty $reg -Name DefaultUserName -Value $env:USERNAME
  Set-ItemProperty $reg -Name DefaultPassword -Value $plain
  Write-Host 'Auto-logon enabled.'
}

Write-Host ''
Write-Host 'Setup complete.' -ForegroundColor Green
Write-Host 'Start now with:   Start-ScheduledTask -TaskName PocketVision'
Write-Host 'Watch logs with:  Get-Content logs\service.log -Wait -Tail 20'
Write-Host 'After a reboot it starts by itself (with auto-logon enabled).'
