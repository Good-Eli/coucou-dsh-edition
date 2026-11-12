# Drives the model picker against the stand-in bridge and reports what happened.
#
# Each step presses one button in the island through UI Automation and then
# reads the bridge's own log, so what is reported is what the host received —
# not what the island believes it sent.
#
#   .\dsh-model-test.ps1

param(
  [string]$Exe = 'C:\LocalAI\build\coucou-dsh\windows\target\release\coucou.exe',
  [string]$StateDir = 'C:\LocalAI\t\fake-dsh',
  [string]$Pipe = '\\.\pipe\coucou-dsh-fake-9999'
)

$ErrorActionPreference = 'Stop'
$bridge = Join-Path $PSScriptRoot '..\tools\fake-bridge.mjs'
$logFile = Join-Path $StateDir 'fake-bridge.log'
$click = Join-Path $PSScriptRoot 'island-click.ps1'

function Stop-All {
  Get-Process coucou -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $Exe } |
    ForEach-Object { Stop-Process -Id $_.Id -Force }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*fake-bridge*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

function Start-All {
  Stop-All
  Remove-Item $logFile -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  $env:FAKE_ASK = '0'
  Start-Process -FilePath 'node' -ArgumentList $bridge, $StateDir, $Pipe -WindowStyle Hidden
  Start-Sleep -Seconds 2
  $env:COUCOU_DATA_SUFFIX = '-dsh-test'
  $env:COUCOU_DSH_STATE_DIR = $StateDir
  Start-Process -FilePath $Exe -WorkingDirectory (Split-Path -Parent $Exe)
  Start-Sleep -Seconds 14
}

function Log-Lines {
  Get-Content $logFile -ErrorAction SilentlyContinue
}

function Show-Change($label) {
  $applied = Log-Lines | Where-Object { $_ -like '*applied *' } | Select-Object -Last 1
  $refused = Log-Lines | Where-Object { $_ -like '*refused *' } | Select-Object -Last 1
  if ($refused) {
    $at = $refused.IndexOf('refused ')
    Write-Output ("{0} -> refused: {1}" -f $label, $refused.Substring($at + 8))
  } elseif ($applied) {
    $at = $applied.IndexOf('applied ')
    Write-Output ("{0} -> {1}" -f $label, $applied.Substring($at + 8))
  } else {
    Write-Output ("{0} -> (no change recorded)" -f $label)
  }
}

function Press($name) {
  & $click -Name $name -Exe $Exe | Out-Null
  Start-Sleep -Milliseconds 1400
}

Write-Output '=== starting ==='
Start-All
$attached = Log-Lines | Where-Object { $_ -like '*client attached*' }
if (-not $attached) { throw 'the island did not connect to the bridge' }

# Focus the DSH pill, then open the picker from its arrow.
& $click -ClickText 'DeepSeek Harness' -Exe $Exe | Out-Null
Start-Sleep -Milliseconds 900
Press 'Открыть'

Write-Output ''
Write-Output '=== 1. switch model: Flash -> Pro ==='
Press 'DeepSeek-V4.1-Pro DeepSeek'
Show-Change '   model'

Write-Output ''
Write-Output '=== 2. change effort on the new model ==='
Press 'High'
Show-Change '   effort'

Write-Output ''
Write-Output '=== 3. switch to a model with a different effort set: Pro -> Spark ==='
Press 'Spark PlusVibe'
Show-Change '   model'

Write-Output ''
Write-Output '=== 4. Spark effort (Medium; it has no Off/High/Max) ==='
Press 'Medium'
Show-Change '   effort'

Write-Output ''
Write-Output '=== 5. back to the first model: Spark -> Flash ==='
Press 'DeepSeek-V4.1-Flash DeepSeek'
Show-Change '   model'

Write-Output ''
Write-Output '=== 6. every change the bridge received ==='
$frames = Log-Lines | Where-Object { $_ -like '*session.setConfig*' }
foreach ($frame in $frames) {
  $json = $frame.Substring($frame.IndexOf('{'))
  try { $obj = $json | ConvertFrom-Json } catch { continue }
  Write-Output ("   {0}: {1} = {2}" -f $obj.sessionId, $obj.configId, $obj.value)
}

Write-Output ''
Write-Output '=== 7. sessions changed (one is expected) ==='
$ids = @()
foreach ($frame in $frames) {
  $json = $frame.Substring($frame.IndexOf('{'))
  try { $obj = $json | ConvertFrom-Json } catch { continue }
  $ids += $obj.sessionId
}
$ids | Group-Object | ForEach-Object { Write-Output ("   {0}: {1} change(s)" -f $_.Name, $_.Count) }
