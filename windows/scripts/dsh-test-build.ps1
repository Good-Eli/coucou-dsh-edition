# Builds the isolated test build of Coucou.
#
# Why a mirror: MSVC's linker cannot create its temporary file when the object
# paths contain non-ASCII characters, and this checkout lives under
# C:\LocalAI\сoucou. The same crate builds fine from an ASCII path and fails
# with LNK1104 from a Cyrillic one, so the sources are copied to a mirror and
# compiled there. `target` and `.git` are never copied.
#
# Usage:
#   .\dsh-test-build.ps1
#   .\dsh-test-build.ps1 -Mirror C:\LocalAI\build\coucou-dsh -NodeModules C:\path\to\node_modules
#
# Output: <Mirror>\windows\src-tauri\target\release\coucou.exe

[CmdletBinding()]
param(
  [string]$Mirror = 'C:\LocalAI\build\coucou-dsh',
  [string]$NodeModules = 'C:\LocalAI\build\coucou-0.5.9\windows\node_modules',
  [switch]$SkipFrontend
)

$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '..'
$dest = Join-Path $Mirror 'windows'

Write-Host "Syncing $source -> $dest"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
robocopy $source $dest /MIR /XD target node_modules .git /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with code $LASTEXITCODE" }

# Some tests read fixtures from the repository root (android/relay/test-vectors.json),
# so the mirror needs them too even though a build does not.
$androidSource = Join-Path (Split-Path -Parent $source) 'android'
if (Test-Path -LiteralPath $androidSource) {
  robocopy $androidSource (Join-Path $Mirror 'android') /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy of android/ failed with code $LASTEXITCODE" }
}

# node_modules is large and never changes here, so it is linked rather than copied.
$link = Join-Path $dest 'node_modules'
if (-not (Test-Path -LiteralPath $link)) {
  if (-not (Test-Path -LiteralPath $NodeModules)) {
    throw "node_modules not found at $NodeModules; run 'npm ci' in windows/ first."
  }
  New-Item -ItemType Junction -Path $link -Target $NodeModules | Out-Null
}

if (-not $SkipFrontend) {
  Push-Location $dest
  try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "the frontend build failed" }
  } finally {
    Pop-Location
  }
}

$env:COUCOU_TEST_BUILD = '1'
Push-Location $dest
try {
  # The app bundle needs coucou-hook.exe next to the target, so it goes first.
  cargo build --release -p coucou-hook
  if ($LASTEXITCODE -ne 0) { throw "coucou-hook did not build" }
  cargo build --release -p coucou
  if ($LASTEXITCODE -ne 0) { throw "coucou did not build" }
} finally {
  Pop-Location
}

$exe = Join-Path $dest 'src-tauri\target\release\coucou.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "build finished but $exe is missing" }
Write-Host ""
Write-Host "Test build ready: $exe"
Write-Host "Start it with: .\dsh-test-run.ps1 -Exe `"$exe`""