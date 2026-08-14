$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($t, $rt) {
  $m = $asTaskGeneric.MakeGenericMethod($rt)
  $nt = $m.Invoke($null, @($t))
  $nt.Wait(-1) | Out-Null
  $nt.Result
}
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$s = $mgr.GetCurrentSession()
$props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
$thumb = $props.Thumbnail

$op = $thumb.OpenReadAsync()
$task = $asTaskGeneric.MakeGenericMethod([Windows.Storage.Streams.IRandomAccessStreamWithContentType]).Invoke($null, @($op))
$task.Wait(-1) | Out-Null
$raw = $task.Result

# 显式转换成接口
$stream = $raw -as [Windows.Storage.Streams.IRandomAccessStreamWithContentType]
Write-Output ("cast stream null? " + ($null -eq $stream))
Write-Output ("stream type: " + $stream.GetType().FullName)

if ($stream) {
  $size = $stream.Size
  Write-Output ("size: " + $size)
  $inStream = $stream.GetInputStreamAt(0)
  $reader = [Windows.Storage.Streams.DataReader]::new($inStream)
  $loadOp = $reader.LoadAsync([uint32]$size)
  $loadTask = $asTaskGeneric.MakeGenericMethod([uint32]).Invoke($null, @($loadOp))
  $loadTask.Wait(-1) | Out-Null
  $loaded = $loadTask.Result
  Write-Output ("loaded: " + $loaded)
  $bytes = New-Object byte[] ([int]$size)
  $reader.ReadBytes($bytes)
  Write-Output ("bytes: " + $bytes.Length)
}
