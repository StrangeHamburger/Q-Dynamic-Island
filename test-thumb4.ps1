$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($t, $rt) {
  $m = $asTaskGeneric.MakeGenericMethod($rt)
  $nt = $m.Invoke($null, @($t))
  $nt.Wait(-1) | Out-Null
  $nt.Result
}

$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$s = $mgr.GetCurrentSession()
Write-Output ("session null? " + ($null -eq $s))
$props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
$thumb = $props.Thumbnail
Write-Output ("thumb null? " + ($null -eq $thumb))

if (-not $thumb) { Write-Output 'NO THUMBNAIL - exiting'; exit }

# 关键：直接调用 GetResults() 而非 AsTask 反射
$op = $thumb.OpenReadAsync()
Write-Output ("op type: " + $op.GetType().FullName)
$stream = $op.GetResults()
Write-Output ("stream null? " + ($null -eq $stream))
Write-Output ("stream type: " + $stream.GetType().FullName)
$size = $stream.Size
Write-Output ("size: " + $size)

$inStream = $stream.GetInputStreamAt(0)
$reader = [Windows.Storage.Streams.DataReader]::new($inStream)
$loadOp = $reader.LoadAsync([uint32]$size)
$loaded = $loadOp.GetResults()
Write-Output ("loaded: " + $loaded)
$bytes = New-Object byte[] ([int]$size)
$reader.ReadBytes($bytes)
$b64 = [Convert]::ToBase64String($bytes)
Write-Output ("base64 len: " + $b64.Length)
