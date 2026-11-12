# Presses a button in the Coucou island by its accessible name.
#
# The island is a Tauri window whose DOM buttons are exposed through UI
# Automation, so this is a real click on a real element — not a mouse event at
# guessed coordinates, which breaks as soon as the display scaling changes.
#
#   .\island-click.ps1 -Name 'Разрешить Y'
#   .\island-click.ps1 -List

param(
  [string]$Name,
  [switch]$List,
  [string]$Exe = 'C:\LocalAI\build\coucou-dsh\windows\target\release\coucou.exe'
)

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class CoucouWindows {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static List<IntPtr> Handles(uint target) {
    var found = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == target) {
        var sb = new StringBuilder(256);
        GetWindowTextW(h, sb, 256);
        // The island window is titled "Coucou"; the settings window is not.
        if (sb.ToString() == "Coucou" && IsWindowVisible(h)) found.Add(h);
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

$proc = Get-Process coucou -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $Exe } |
  Select-Object -First 1
if (-not $proc) { Write-Error "the test build is not running ($Exe)"; exit 1 }

$handles = [CoucouWindows]::Handles([uint32]$proc.Id)
if ($handles.Count -eq 0) { Write-Error "no island window for pid $($proc.Id)"; exit 1 }

foreach ($handle in $handles) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  if (-not $root) { continue }
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button)
  $buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)

  if ($List) {
    foreach ($button in $buttons) {
      if ($button.Current.Name) { Write-Output $button.Current.Name }
    }
    continue
  }

  $match = $null
  foreach ($button in $buttons) {
    if ($button.Current.Name -eq $Name) { $match = $button; break }
  }
  if (-not $match) { continue }
  $match.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  Write-Output "pressed: $Name"
  exit 0
}

if (-not $List) { Write-Error "no button named '$Name'"; exit 1 }
