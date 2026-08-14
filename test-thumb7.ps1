$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]

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
if (-not $thumb) { Write-Output 'NO THUMB'; exit }

$op = $thumb.OpenReadAsync()
$task = $asTaskGeneric.MakeGenericMethod([Windows.Storage.Streams.IRandomAccessStreamWithContentType]).Invoke($null, @($op))
$task.Wait(-1) | Out-Null
$raw = $task.Result
Write-Output ("raw type: " + $raw.GetType().FullName)

# AsStreamForRead
$netStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($raw)
Write-Output ("netStream null: " + ($null -eq $netStream))
if ($netStream) {
  Write-Output ("netStream type: " + $netStream.GetType().FullName)
  Write-Output ("netStream len: " + $netStream.Length)
  $ms = New-Object System.IO.MemoryStream
  $netStream.CopyTo($ms)
  $bytes = $ms.ToArray()
  $b64 = [Convert]::ToBase64String($bytes)
  Write-Output ("base64 len: " + $b64.Length)
}
