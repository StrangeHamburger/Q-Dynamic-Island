$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 网易云鼠标点击测试：点击播放/暂停按钮，前后各读一次主输出峰值判断是否真的暂停/播放。
# 前提：请先只让网易云在播放（关掉其它出声的程序），否则峰值混音会干扰判断。

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class ClickProbe {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lp);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder t, int max);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP   = 0x0004;

  public static IntPtr FindCloudmusic() {
    var procs = System.Diagnostics.Process.GetProcessesByName("cloudmusic");
    if (procs.Length == 0) return IntPtr.Zero;
    var pids = new System.Collections.Generic.HashSet<int>();
    foreach (var p in procs) pids.Add(p.Id);
    IntPtr result = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint wpid = 0;
      GetWindowThreadProcessId(h, out wpid);
      if (pids.Contains((int)wpid)) {
        int len = GetWindowTextLength(h);
        if (len > 0) {
          var sb = new StringBuilder(len + 1);
          GetWindowText(h, sb, len + 1);
          if (sb.ToString().Contains(" - ")) { result = h; return false; }
        }
      }
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
'@

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class MasterPeak {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, [MarshalAs(UnmanagedType.Interface)] out IMMDevice endpoint);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object i);
  }
  [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioMeterInformation {
    [PreserveSig] int GetPeakValue(out float peak);
  }
  public static float Peak() {
    try {
      var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDevice dev;
      if (en.GetDefaultAudioEndpoint(0, 1, out dev) != 0) return -1f;
      object meterObj;
      Guid iid = new Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064");
      if (dev.Activate(ref iid, 0x17, IntPtr.Zero, out meterObj) != 0) return -2f;
      var meter = (IAudioMeterInformation)meterObj;
      float p;
      meter.GetPeakValue(out p);
      return p;
    } catch { return -3f; }
  }
}
'@

$hwnd = [ClickProbe]::FindCloudmusic()
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "NO_WINDOW"; exit }

$r = New-Object ClickProbe+RECT
[ClickProbe]::GetWindowRect($hwnd, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
Write-Output ("hwnd={0} rect={1},{2} {3}x{4}" -f $hwnd, $r.Left, $r.Top, $w, $h)

$x = $r.Left + 260
$y = $r.Bottom - 32
Write-Output ("click screen=({0},{1})" -f $x, $y)

$peak0 = [MasterPeak]::Peak()
Write-Output ("peak0=" + $peak0)

if ([ClickProbe]::IsIconic($hwnd)) { [ClickProbe]::ShowWindow($hwnd, 9) | Out-Null; Start-Sleep -Milliseconds 300 }
[ClickProbe]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 100
[ClickProbe]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 50
[ClickProbe]::mouse_event([ClickProbe]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 50
[ClickProbe]::mouse_event([ClickProbe]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 800
$peak1 = [MasterPeak]::Peak()
Write-Output ("peak1=" + $peak1)
Write-Output "DONE"
