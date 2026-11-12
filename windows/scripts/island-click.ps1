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
  # Clicks the element with this accessible name where it actually is on
  # screen. For things that are not buttons (a pill), where a click has to
  # land on the element's own rectangle rather than be invoked.
  [string]$ClickText,
  [string]$Exe = 'C:\LocalAI\build\coucou-dsh\windows\target\release\coucou.exe'
)

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class IslandMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(120);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(60);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
  }
}
"@

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

  if ($ClickText) {
    $condition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NameProperty, $ClickText)
    $target = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if (-not $target) { continue }
    $rect = $target.Current.BoundingRectangle
    if ($rect.Width -le 0 -or $rect.Height -le 0) { continue }
    $x = [int]($rect.X + $rect.Width / 2)
    $y = [int]($rect.Y + $rect.Height / 2)
    [IslandMouse]::Click($x, $y)
    Write-Output "clicked: $ClickText at $x,$y"
    exit 0
  }
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

if ($ClickText) { Write-Error "no element named '$ClickText'"; exit 1 }
if (-not $List) { Write-Error "no button named '$Name'"; exit 1 }
