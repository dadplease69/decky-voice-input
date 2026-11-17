# Opens the "Add Voice Input" PR in SteamDeckHomebrew/decky-plugin-database.
#   powershell -ExecutionPolicy Bypass -File C:\Claudia\decky-voice-input\scripts\submit-to-store.ps1 -Tag v0.2.0
# Requires: gh (logged in), git. Uses the commit of the given release tag as the submodule pointer.
# Safe to re-run: reuses the fork, recreates the branch, updates an already open PR.
param([Parameter(Mandatory = $true)][string]$Tag)
$ErrorActionPreference = "Continue"   # native tools write progress to stderr; check exit codes instead
function Check($what) { if ($LASTEXITCODE -ne 0) { Write-Host "FAILED: $what" -ForegroundColor Red; exit 1 } }

$Me = (gh api user --jq .login); Check "gh api user"
$Repo = "https://github.com/$Me/decky-voice-input"
$Body = Join-Path $PSScriptRoot "store-pr.md"
# next to the plugin repo (C:\Claudia\decky-plugin-database): %TEMP% can be an 8.3 short path
# that PowerShell can't enter when the Windows user name is non-ASCII
$Work = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "decky-plugin-database"
$Branch = "add-voice-input"
$Upstream = "SteamDeckHomebrew/decky-plugin-database"

$Commit = (git ls-remote $Repo "refs/tags/$Tag^{}" | ForEach-Object { ($_ -split "\s+")[0] })
if (-not $Commit) { $Commit = (git ls-remote $Repo "refs/tags/$Tag" | ForEach-Object { ($_ -split "\s+")[0] }) }
if (-not $Commit) { Write-Host "tag $Tag not found in $Repo" -ForegroundColor Red; exit 1 }
Write-Host "Submitting $Repo @ $Tag ($Commit)" -ForegroundColor Cyan

gh repo view "$Me/decky-plugin-database" --json name *> $null
if ($LASTEXITCODE -ne 0) { gh repo fork $Upstream --clone=false; Check "fork" }

if (Test-Path $Work) { Remove-Item -Recurse -Force $Work }
git clone --depth 1 "https://github.com/$Upstream.git" $Work; Check "clone"
Set-Location $Work
git remote add fork "https://github.com/$Me/decky-plugin-database.git"
git checkout -b $Branch; Check "branch"
git submodule add $Repo plugins/decky-voice-input; Check "submodule add"
git -C plugins/decky-voice-input checkout -q $Commit; Check "submodule checkout"
git add .gitmodules plugins/decky-voice-input
git commit -m "Add Voice Input to Plugin Store"; Check "commit"
git push -f fork $Branch; Check "push"

$existing = gh pr list --repo $Upstream --head $Branch --author $Me --json url --jq ".[0].url"
if ($existing) {
  gh pr edit $existing --body-file $Body; Check "pr edit"
  Write-Host "Updated existing PR: $existing" -ForegroundColor Green
} else {
  gh pr create --repo $Upstream --base main --head "${Me}:$Branch" --title "Add Voice Input to Plugin Store" --body-file $Body
  Check "pr create"
}
