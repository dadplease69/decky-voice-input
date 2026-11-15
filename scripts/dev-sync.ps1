# Auto-deploy to Steam Deck while debugging. Run from PowerShell:
#   powershell -ExecutionPolicy Bypass -File C:\Claudia\decky-voice-input\scripts\dev-sync.ps1
# Watches plugin files, on change copies them to the Deck and restarts Decky.
# Every few seconds pulls logs into C:\Claudia\deck-logs\plugin.log.
param([string]$DeckHost = "192.168.110.9", [string]$User = "deck")
$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
$Target = "$User@$DeckHost"
$LogDir = Join-Path (Split-Path -Parent $Root) "deck-logs"
New-Item -ItemType Directory -Force $LogDir | Out-Null
$Items = @("plugin.json", "package.json", "main.py", "dist", "py_modules")
$Ssh = @("-o", "BatchMode=yes", "-o", "ConnectTimeout=5")

function Get-Stamp {
  $paths = $Items | ForEach-Object { Join-Path $Root $_ }
  (Get-ChildItem -Recurse -File $paths -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch "__pycache__" } |
    Sort-Object FullName |
    ForEach-Object { "$($_.FullName)|$($_.Length)|$($_.LastWriteTimeUtc.Ticks)" }) -join "`n"
}

function Invoke-Deploy {
  Write-Host "[$(Get-Date -Format HH:mm:ss)] deploy..." -ForegroundColor Cyan
  ssh @Ssh $Target "rm -rf /tmp/vi-stage && mkdir -p /tmp/vi-stage"
  if ($LASTEXITCODE -ne 0) { Write-Host "ssh failed" -ForegroundColor Red; return }
  $src = $Items | ForEach-Object { Join-Path $Root $_ }
  $bin = Join-Path $Root "bin\whisper-server"
  if (Test-Path $bin) { $src += (Join-Path $Root "bin") }
  scp @Ssh -r -q @src "${Target}:/tmp/vi-stage/"
  if ($LASTEXITCODE -ne 0) { Write-Host "scp failed" -ForegroundColor Red; return }
  $out = ssh @Ssh $Target "sudo -n /etc/decky-dev/deck-dev.sh deploy" 2>&1
  Write-Host "[$(Get-Date -Format HH:mm:ss)] $out" -ForegroundColor Green
  "$(Get-Date -Format o) $out" | Out-File -Append -Encoding utf8 (Join-Path $LogDir "deploy-history.txt")
}

function Get-Logs {
  $out = ssh @Ssh $Target "sudo -n /etc/decky-dev/deck-dev.sh logs" 2>&1 | ForEach-Object { "$_" }
  $code = $LASTEXITCODE
  @("# pulled $(Get-Date -Format o) exit=$code") + $out | Out-File -Encoding utf8 (Join-Path $LogDir "plugin.log")
  if ($code -ne 0) { Write-Host "[$(Get-Date -Format HH:mm:ss)] logs exit=$code" -ForegroundColor Yellow }
}

Write-Host "dev-sync: $Root -> $Target  (Ctrl+C to stop)"
$last = Get-Stamp
Invoke-Deploy
$lastLog = Get-Date
while ($true) {
  Start-Sleep -Milliseconds 800
  $now = Get-Stamp
  if ($now -ne $last) {
    Start-Sleep -Milliseconds 700   # let multi-file edits settle
    $last = Get-Stamp
    Invoke-Deploy
    Start-Sleep -Seconds 6
    Get-Logs
    $lastLog = Get-Date
  }
  if (((Get-Date) - $lastLog).TotalSeconds -ge 4) { Get-Logs; $lastLog = Get-Date }
}
