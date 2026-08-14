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
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime]
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$s = $mgr.GetCurrentSession()
$props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
$thumb = $props.Thumbnail
Write-Output ("thumb null? " + ($null -eq $thumb))
if ($thumb) {
  $stream = Await ($thumb.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
  Write-Output ("stream size: " + $stream.Size)
  $size = [uint32]$stream.Size
  $reader = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
  $loaded = Await ($reader.LoadAsync($size)) ([uint32])
  Write-Output ("loaded: " + $loaded)
  $bytes = New-Object byte[] $size
  $reader.ReadBytes($bytes)
  $b64 = [Convert]::ToBase64String($bytes)
  Write-Output ("base64 len: " + $b64.Length)
}
