# Starts the isolated test build of Coucou beside the installed copy.
#
# Everything it touches lives under the suffix: %APPDATA%\Coucou-dsh-test,
# %LOCALAPPDATA%\Coucou-dsh-test, the relay pipe \\.\pipe\coucou-dsh-test-<sid>
# and the credential service fr.louisraille.coucou-dsh-test. The installed
# Coucou, its autostart entry and the CoucouDshBridge login item are not read,
# written or stopped by this script.
#
# Usage:
#   .\dsh-test-run.ps1                 # start the test build
#   .\dsh-test-run.ps1 -Stop           # stop every running test build
#   .\dsh-test-run.ps1 -ShowPaths      # print the folders and pipes in use

[CmdletBinding()]
param(
  [switch]$Stop,
  [switch]$ShowPaths,
  [string]$Exe = "C:\LocalAI\build\coucou-dsh\windows\src-tauri\target\release\coucou.exe",
  [string]$Suffix = "-dsh-test"
)

$ErrorActionPreference = 'Stop'

function Get-TestPaths {
  param([string]$Suffix)
  $sid = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
  [pscustomobject]@{
    AppData    = Join-Path $env:APPDATA     "Coucou$Suffix"
    LocalData  = Join-Path $env:LOCALAPPDATA "Coucou$Suffix"
    RelayPipe  = "\\.\pipe\coucou$($Suffix)-$sid"
    BridgePipe = "\\.\pipe\coucou-dsh-$sid"
    Credential = "fr.louisraille.coucou$Suffix"
  }
}

if ($ShowPaths) {
  $paths = Get-TestPaths -Suffix $Suffix
  "APPDATA      $($paths.AppData)"
  "LOCALAPPDATA $($paths.LocalData)"
  "relay pipe   $($paths.RelayPipe)"
  "DSH bridge   $($paths.BridgePipe)  (shared, owned by DSH)"
  "credential   $($paths.Credential)"
  "executable   $Exe"
  return
}

# Only processes whose command line carries our executable count: the installed
# Coucou runs from %LOCALAPPDATA%\Coucou and is never touched.
function Get-TestProcesses {
  param([string]$Exe)
  $full = [System.IO.Path]::GetFullPath($Exe)
  Get-CimInstance Win32_Process -Filter "Name='coucou.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $full) }
}

if ($Stop) {
  $running = Get-TestProcesses -Exe $Exe
  if (-not $running) { "No test build is running."; return }
  foreach ($process in $running) {
    "Stopping test build pid $($process.ProcessId)"
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  return
}

if (-not (Test-Path -LiteralPath $Exe)) {
  throw "Test build not found at $Exe. Build it first (see docs/STAGE3-P2-ISOLATION.md)."
}

$env:COUCOU_DATA_SUFFIX = $Suffix
$paths = Get-TestPaths -Suffix $Suffix
"Starting the test build with $Suffix"
"  settings  $($paths.AppData)"
"  data      $($paths.LocalData)"
"  relay     $($paths.RelayPipe)"
Start-Process -FilePath $Exe -WorkingDirectory (Split-Path -Parent $Exe) | Out-Null