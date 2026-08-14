$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($t, $rt) {
  $m = $asTaskGeneric.MakeGenericMethod($rt)
  $nt = $m.Invoke($null, @($t))
  $nt.Wait(-1) | Out-Null
  $nt.Result
}

$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$s = $mgr.GetCurrentSession()
$props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
$thumb = $props.Thumbnail
$op = $thumb.OpenReadAsync()
$task = $asTaskGeneric.MakeGenericMethod([Windows.Storage.Streams.IRandomAccessStreamWithContentType]).Invoke($null, @($op))
$task.Wait(-1) | Out-Null
$raw = $task.Result

# 尝试1: 重新投影到接口
$p = [System.Management.Automation.PSObject]::AsPSObject($raw)
$p.TypeNames.Insert(0, 'Windows.Storage.Streams.IRandomAccessStreamWithContentType')
$sz = $p.Size
Write-Output ("iface re-type: Size = " + $sz)

# 尝试2: 重新投影到具体类
$p2 = [System.Management.Automation.PSObject]::AsPSObject($raw)
$p2.TypeNames.Insert(0, 'Windows.Storage.Streams.InMemoryRandomAccessStream')
$sz2 = $p2.Size
Write-Output ("InMemory re-type: Size = " + $sz2)

# 尝试3: DataReader 直接从 raw
$rd = [Windows.Storage.Streams.DataReader]::new($raw)
Write-Output ("DataReader(raw) null: " + ($null -eq $rd))
