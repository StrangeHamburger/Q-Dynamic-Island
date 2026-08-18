$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @'
using System;
using System.Runtime.InteropServices;

public class PeakProbe {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumerator { }

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

public class InputProbe {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public KEYBDINPUT ki;
  }

  public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
  public const uint KEYEVENTF_KEYUP       = 0x0002;
  public const uint KEYEVENTF_SCANCODE    = 0x0008;

  public static void MediaKeyScan() {
    // VK_MEDIA_PLAY_PAUSE (0xB3), scan code 0x22, extended key, using SCANCODE+EXTENDEDKEY
    INPUT[] ins = new INPUT[2];
    ins[0].type = 1;
    ins[0].ki.wVk = 0xB3;
    ins[0].ki.wScan = 0x22;
    ins[0].ki.dwFlags = KEYEVENTF_EXTENDEDKEY | KEYEVENTF_SCANCODE;
    ins[1].type = 1;
    ins[1].ki.wVk = 0xB3;
    ins[1].ki.wScan = 0x22;
    ins[1].ki.dwFlags = KEYEVENTF_EXTENDEDKEY | KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP;
    SendInput(2, ins, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void MediaKeyVk() {
    INPUT[] ins = new INPUT[2];
    ins[0].type = 1;
    ins[0].ki.wVk = 0xB3;
    ins[0].ki.wScan = 0;
    ins[0].ki.dwFlags = KEYEVENTF_EXTENDEDKEY;
    ins[1].type = 1;
    ins[1].ki.wVk = 0xB3;
    ins[1].ki.wScan = 0;
    ins[1].ki.dwFlags = KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP;
    SendInput(2, ins, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@

function Read-Peak { try { return [PeakProbe]::Peak() } catch { return -9 } }

Write-Output ("peak0=" + (Read-Peak))
Start-Sleep -Milliseconds 300

# Try scan-code media key first
[InputProbe]::MediaKeyScan()
Start-Sleep -Milliseconds 1000
Write-Output ("after_scan=" + (Read-Peak))

# Try vk media key
[InputProbe]::MediaKeyVk()
Start-Sleep -Milliseconds 1000
Write-Output ("after_vk=" + (Read-Peak))
