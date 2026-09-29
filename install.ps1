<#
  install.ps1 — install this plugin into a DSH profile (Windows).

  Usage:
    pwsh -File .\install.ps1                        # link THIS checkout (default)
    pwsh -File .\install.ps1 -From npm              # install the published package instead
    pwsh -File .\install.ps1 -From npm -Ref next    # …a dist-tag, or an exact version
    pwsh -File .\install.ps1 -Profile desktop       # explicit profile name
    pwsh -File .\install.ps1 -Home <dsh-home>       # explicit DSH home (default %USERPROFILE%\.dsh)

  Either source does the two steps the profile itself needs:
    1. add the plugin to the profile (pnpm add)
    2. list it in dsh.profile.bundles — that array IS the enable switch; a name missing
       from it is a disabled plugin
  then it reminds you of the third step, which no script can do for you: fully restart the app.
#>
[CmdletBinding()]
param(
    [ValidateSet('local', 'npm')][string]$From = 'local',
    [string]$Ref = '',
    [string]$Profile = '',
    [string]$Home = (Join-Path $env:USERPROFILE '.dsh')
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Run this with PowerShell 7: pwsh -File .\install.ps1' }

$packageName = 'dsh-prefill-speed-stats'
$packageDir = $PSScriptRoot
$profilesDir = Join-Path $Home 'profiles'

if (-not $Profile) {
    $found = @(Get-ChildItem -LiteralPath $profilesDir -Directory -ErrorAction SilentlyContinue)
    if ($found.Count -ne 1) {
        throw "Cannot pick a profile: $profilesDir holds $($found.Count). Pass -Profile <name>."
    }
    $Profile = $found[0].Name
}

$profileDir = Join-Path $profilesDir $Profile
$manifest = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifest)) { throw "No such profile: $profileDir" }

# What to add: this checkout, or the published package (optionally pinned to a tag or version).
if ($From -eq 'npm') {
    $spec = if ($Ref) { "$packageName@$Ref" } else { $packageName }
} else {
    $spec = 'link:' + ($packageDir -replace '\\', '/')
}

# 1) Add it to the profile, preferring the node + pnpm DSH ships with.
$runtime = Join-Path $Home 'dsh-runtimes\dsh-primary-runtime\dependencies'
$node = Join-Path $runtime 'node\bin\node.exe'
$pnpm = Join-Path $runtime 'pnpm\bin\pnpm.cjs'

Push-Location $profileDir
try {
    if ((Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $pnpm)) {
        & $node $pnpm add $spec
    } else {
        pnpm add $spec
    }
    if ($LASTEXITCODE -ne 0) {
        if ($From -eq 'npm' -and -not $Ref) {
            throw "pnpm add $spec failed (exit code $LASTEXITCODE). If only a prerelease is published, pin it: -Ref <version|tag>."
        }
        throw "pnpm add $spec failed (exit code $LASTEXITCODE)"
    }
} finally {
    Pop-Location
}

# 2) Enable the bundle by listing it in dsh.profile.bundles.
Copy-Item -LiteralPath $manifest -Destination "$manifest.bak-$(Get-Date -Format yyyyMMddHHmmss)" -Force
$json = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
if ($null -eq $json.dsh) { $json | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
if ($null -eq $json.dsh.profile) { $json.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) }
if ($null -eq $json.dsh.profile.bundles) { $json.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() }

if (@($json.dsh.profile.bundles) -contains $packageName) {
    Write-Host "already enabled: $packageName"
} else {
    $json.dsh.profile.bundles = @(@($json.dsh.profile.bundles) + $packageName)
    # utf8NoBOM: a BOM would break the JSON parse on the next launch.
    $json | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifest -Encoding utf8NoBOM
    Write-Host "enabled: $packageName"
}

Write-Host ''
Write-Host "Installed $spec into profile `"$Profile`". Last step: fully restart the app." -ForegroundColor Green
Write-Host 'A page refresh is not enough: the browser bundle is snapshotted at boot.'
