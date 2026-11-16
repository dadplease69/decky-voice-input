# Opens the "Add Voice Input" PR in SteamDeckHomebrew/decky-plugin-database.
#   powershell -ExecutionPolicy Bypass -File C:\Claudia\decky-voice-input\scripts\submit-to-store.ps1 -Tag v0.2.0
# Requires: gh (logged in), git. Uses the commit of the given release tag as the submodule pointer.
param([Parameter(Mandatory = $true)][string]$Tag)
$ErrorActionPreference = "Stop"
$Me = (gh api user --jq .login)
$Repo = "https://github.com/$Me/decky-voice-input"
$Body = Join-Path $PSScriptRoot "store-pr.md"
$Work = Join-Path $env:TEMP "decky-plugin-database"
$Branch = "add-voice-input"

$Commit = (git ls-remote $Repo "refs/tags/$Tag^{}" | ForEach-Object { ($_ -split "\s+")[0] })
if (-not $Commit) { $Commit = (git ls-remote $Repo "refs/tags/$Tag" | ForEach-Object { ($_ -split "\s+")[0] }) }
if (-not $Commit) { throw "tag $Tag not found in $Repo" }
Write-Host "Submitting $Repo @ $Tag ($Commit)"

gh repo fork SteamDeckHomebrew/decky-plugin-database --clone=false 2>$null
if (Test-Path $Work) { Remove-Item -Recurse -Force $Work }
git clone --depth 1 "https://github.com/SteamDeckHomebrew/decky-plugin-database.git" $Work
Set-Location $Work
git remote add fork "https://github.com/$Me/decky-plugin-database.git"
git checkout -b $Branch
git submodule add $Repo plugins/decky-voice-input
git -C plugins/decky-voice-input checkout $Commit
git add .gitmodules plugins/decky-voice-input
git commit -m "Add Voice Input to Plugin Store"
git push -f fork $Branch
gh pr create --repo SteamDeckHomebrew/decky-plugin-database --base main --head "${Me}:$Branch" `
  --title "Add Voice Input to Plugin Store" --body-file $Body
