# Auto-deploy to a Steam Deck while debugging. Run from PowerShell:
#   powershell -ExecutionPolicy Bypass -File C:\Claudia\decky-voice-input\scripts\dev-sync.ps1 [-DeckHost 192.168.x.y]
# On every change: copies sources to the Deck, builds the frontend there (podman + node:22),
# deploys into the installed plugin folder and restarts Decky. Logs are pulled into ..\deck-logs.
# Needs one-time scripts/setup-deck.sh on the Deck.
param([string]$DeckHost = "192.168.110.35", [string]$User = "deck")
$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
$Target = "$User@$DeckHost"
$LogDir = Join-Path (Split-Path -Parent $Root) "deck-logs"
New-Item -ItemType Directory -Force $LogDir | Out-Null
$Ssh = @("-o", "BatchMode=yes", "-o", "ConnectTimeout=5")
$Watched = @("src", "main.py", "py_modules", "plugin.json", "package.json", "rollup.config.js", "tsconfig.json")
$BuildFiles = @("src", "package.json", "plugin.json", "rollup.config.js", "tsconfig.json", "scripts\deck-build.sh")
$BinStampFile = Join-Path $LogDir ".bin-stamp"

function Get-Stamp([string[]]$items) {
  $paths = $items | ForEach-Object { Join-Path $Root $_ } | Where-Object { Test-Path $_ }
  if (-not $paths) { return "" }
  (Get-ChildItem -Recurse -File $paths -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch "__pycache__|node_modules" } |
    Sort-Object FullName |
    ForEach-Object { "$($_.FullName)|$($_.Length)|$($_.LastWriteTimeUtc.Ticks)" }) -join "`n"
}

function Say($msg, $color = "Gray") { Write-Host "[$(Get-Date -Format HH:mm:ss)] $msg" -ForegroundColor $color }

function Invoke-Deploy {
  Say "build + deploy..." Cyan
  ssh @Ssh $Target "mkdir -p ~/vi-src ~/.cache/vi-pnpm && rm -rf ~/vi-src/src /tmp/vi-stage && mkdir -p /tmp/vi-stage"
  if ($LASTEXITCODE -ne 0) { Say "ssh failed (Deck asleep or IP changed?)" Red; return }

  $src = $BuildFiles | ForEach-Object { Join-Path $Root $_ }
  $lock = Join-Path $Root "pnpm-lock.yaml"
  if (Test-Path $lock) { $src += $lock }
  scp @Ssh -r -q @src "${Target}:vi-src/"
  $code = ssh @Ssh $Target "bash vi-src/deck-build.sh"
  scp @Ssh -q "${Target}:vi-src/build.log" (Join-Path $LogDir "build.log")
  scp @Ssh -q "${Target}:vi-src/pnpm-lock.yaml" $lock 2>$null
  if ("$code".Trim() -ne "0") { Say "frontend build FAILED, see deck-logs\build.log" Red; return }

  $stage = @("main.py", "plugin.json", "package.json", "py_modules") | ForEach-Object { Join-Path $Root $_ }
  $binDir = Join-Path $Root "bin"
  $binStamp = Get-Stamp @("bin")
  $oldBinStamp = if (Test-Path $BinStampFile) { Get-Content $BinStampFile -Raw } else { "" }
  $sendBin = $binStamp -and ($binStamp -ne $oldBinStamp)
  if ($sendBin) { $stage += $binDir }
  scp @Ssh -r -q @stage "${Target}:/tmp/vi-stage/"
  ssh @Ssh $Target "cp -r ~/vi-src/dist /tmp/vi-stage/"
  $out = ssh @Ssh $Target "sudo -n /etc/decky-dev/deck-dev.sh deploy" 2>&1 | ForEach-Object { "$_" }
  if ($LASTEXITCODE -eq 0) {
    if ($sendBin) { Set-Content -LiteralPath $BinStampFile -Value $binStamp -NoNewline }
    Say "$out" Green
  } else {
    Say "deploy failed: $out" Red
  }
  "$(Get-Date -Format o) $out" | Out-File -Append -Encoding utf8 (Join-Path $LogDir "deploy-history.txt")
}

function Get-Logs {
  $out = ssh @Ssh $Target "sudo -n /etc/decky-dev/deck-dev.sh logs" 2>&1 | ForEach-Object { "$_" }
  $code = $LASTEXITCODE
  @("# pulled $(Get-Date -Format o) exit=$code") + $out | Out-File -Encoding utf8 (Join-Path $LogDir "plugin.log")
}

Say "dev-sync: $Root -> $Target  (Ctrl+C to stop)"
$last = Get-Stamp ($Watched + "bin")
Invoke-Deploy
$lastLog = Get-Date
while ($true) {
  Start-Sleep -Milliseconds 800
  $now = Get-Stamp ($Watched + "bin")
  if ($now -ne $last) {
    Start-Sleep -Milliseconds 700   # let multi-file edits settle
    $last = Get-Stamp ($Watched + "bin")
    Invoke-Deploy
    Start-Sleep -Seconds 4
    Get-Logs
    $lastLog = Get-Date
  }
  if (((Get-Date) - $lastLog).TotalSeconds -ge 4) { Get-Logs; $lastLog = Get-Date }
}
