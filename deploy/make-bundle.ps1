# Build pocketvision-vps.zip — everything the VPS needs in one file.
# Run ON YOUR PC from the project folder, with the scanner STOPPED
# (the browser must be closed or the .auth profile can't be read):
#   powershell -ExecutionPolicy Bypass -File deploy\make-bundle.ps1
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root 'pocketvision-vps.zip'

# Only the SCANNER's browser locks .auth — normal Chrome browsing is fine.
$scanner = Get-CimInstance Win32_Process -Filter "Name like 'chrom%'" |
  Where-Object { $_.CommandLine -match [regex]::Escape('.auth\chrome-profile') }
if ($scanner) {
  Write-Warning 'The scanner''s browser is running. Stop the scanner (press ENTER in its window) first, then re-run this.'
  exit 1
}

$items = @('src', 'supabase', 'deploy', 'docs', 'package.json', 'package-lock.json', 'tsconfig.json', '.env', '.auth') |
  ForEach-Object { Join-Path $root $_ } | Where-Object { Test-Path $_ }

if (Test-Path $out) { Remove-Item $out -Force }
Write-Host "Zipping $($items.Count) items → $out (a minute or two)…"
Compress-Archive -Path $items -DestinationPath $out
$mb = [math]::Round((Get-Item $out).Length / 1MB, 1)
Write-Host "Done: pocketvision-vps.zip ($mb MB)."
Write-Host 'Next: copy it to the VPS over RDP (see docs/VPS-WINDOWS.md).'
