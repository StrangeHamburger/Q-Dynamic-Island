$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @'
using System;
using System.Runtime.InteropServices;

public class SessionProbe {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr collection);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, [MarshalAs(UnmanagedType.Interface)] out IMMDevice endpoint);
    [PreserveSig] int GetDevice(string id, out IntPtr device);
    [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object i);
    [PreserveSig] int OpenPropertyStore(int stgm, out IntPtr props);
    [PreserveSig] int GetId(out IntPtr id);
    [PreserveSig] int GetState(out int state);
  }

  // IAudioSessionManager2 GUID is 77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F (NOT BFA971F1, which is base IAudioSessionManager).
  // vtable: slots 0,1 are base IAudioSessionManager methods; GetSessionEnumerator is slot 2.
  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(ref Guid g, uint flags, out IntPtr c);
    [PreserveSig] int GetSimpleAudioVolume(ref Guid g, uint flags, out IntPtr v);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e);
  }

  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
  }

  // IAudioSessionControl2 vtable: 9 base methods (slots 0-8) then 4 (slots 9-12).
  [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName(out IntPtr name);
    [PreserveSig] int SetDisplayName(string name, ref Guid eventContext);
    [PreserveSig] int GetIconPath(out IntPtr path);
    [PreserveSig] int SetIconPath(string path, ref Guid eventContext);
    [PreserveSig] int GetGroupingParam(out Guid g);
    [PreserveSig] int SetGroupingParam(ref Guid g, ref Guid eventContext);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int GetSessionIdentifier(out IntPtr id);
    [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
    [PreserveSig] int GetProcessId(out uint pid);
    [PreserveSig] int IsSystemSoundsSession();
  }

  [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioMeterInformation {
    [PreserveSig] int GetPeakValue(out float peak);
  }

  public static string Dump() {
    var sb = new System.Text.StringBuilder();
    try {
      var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDevice dev;
      if (en.GetDefaultAudioEndpoint(0, 1, out dev) != 0) return "no endpoint";
      object mgrObj;
      Guid mgrIid = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
      if (dev.Activate(ref mgrIid, 0x17, IntPtr.Zero, out mgrObj) != 0) return "no mgr";
      var mgr = (IAudioSessionManager2)mgrObj;
      IAudioSessionEnumerator senum;
      if (mgr.GetSessionEnumerator(out senum) != 0) return "no senum";
      int count;
      senum.GetCount(out count);
      sb.AppendLine("sessions=" + count);
      for (int i = 0; i < count; i++) {
        object session;
        if (senum.GetSession(i, out session) != 0) continue;
        var c2 = session as IAudioSessionControl2;
        var meter = session as IAudioMeterInformation;
        uint pid = 0;
        if (c2 != null) c2.GetProcessId(out pid);
        float peak = -1;
        if (meter != null) meter.GetPeakValue(out peak);
        sb.AppendLine("  pid=" + pid + " peak=" + peak.ToString("0.0000"));
      }
    } catch (Exception e) {
      sb.AppendLine("err=" + e.Message);
    }
    return sb.ToString();
  }
}
'@

[SessionProbe]::Dump()
