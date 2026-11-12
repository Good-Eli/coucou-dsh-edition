# Runs the test build against the stand-in DSH bridge, so the approval card can
# be exercised without a real approval prompt.
#
#   .\dsh-card-test.ps1 -Start     # bridge + test build, fresh request
#   .\dsh-card-test.ps1 -Stop
#   .\dsh-card-test.ps1 -Log       # what the bridge received
#
# The stand-in speaks the same protocol as dsh-plugin/bridge.mjs and answers
# nothing on its own: every frame it receives is written to its log.

param(
  [switch]$Start,
  [switch]$Stop,
  [switch]$Log,
  [string]$StateDir = 'C:\LocalAI\t\fake-dsh',
  [string]$Pipe = '\\.\pipe\coucou-dsh-fake-9999',
  [string]$Exe = 'C:\LocalAI\build\coucou-dsh\windows\target\release\coucou.exe'
)

$bridge = Join-Path $PSScriptRoot '..\tools\fake-bridge.mjs'
$logFile = Join-Path $StateDir 'fake-bridge.log'

function Stop-All {
  Get-Process coucou -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $Exe } |
    ForEach-Object { Stop-Process -Id $_.Id -Force }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*fake-bridge*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

if ($Stop -or $Start) {
  Stop-All
  if ($Start) {
    Remove-Item $logFile -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    Start-Process -FilePath 'node' -ArgumentList $bridge, $StateDir, $Pipe -WindowStyle Hidden
    Start-Sleep -Seconds 2
    $env:COUCOU_DATA_SUFFIX = '-dsh-test'
    $env:COUCOU_DSH_STATE_DIR = $StateDir
    Start-Process -FilePath $Exe -WorkingDirectory (Split-Path -Parent $Exe)
    Start-Sleep -Seconds 13
    Write-Output "started: bridge on $Pipe, build $Exe"
  }
  exit 0
}

if ($Log) {
  if (-not (Test-Path $logFile)) { Write-Output 'no log yet'; exit 0 }
  Get-Content $logFile | Select-String -Pattern 'ACK|ANSWER|DECLINE|sent approval|client' |
    ForEach-Object { $_.Line }
  exit 0
}
