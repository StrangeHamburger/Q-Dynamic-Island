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
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$s = $mgr.GetCurrentSession()
$props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
$thumb = $props.Thumbnail

# 尝试1：OpenReadAsync 结果类型探测
$op = $thumb.OpenReadAsync()
Write-Output ("op type: " + $op.GetType().FullName)
Write-Output ("op generic args: " + ($op.GetType().GetInterfaces() | ForEach-Object { $_.FullName }))

# 尝试2：AsTask 用非泛型方式，看 Result 类型
$task = [System.WindowsRuntimeSystemExtensions]::AsTask($op)
$task.Wait(-1) | Out-Null
$res = $task.Result
Write-Output ("result type: " + $res.GetType().FullName)
Write-Output ("result is comobject: " + ($res -is [System.__ComObject]))

# 尝试3：AsStreamForRead 扩展
try {
  $netStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($res)
  Write-Output ("AsStreamForRead OK, len: " + $netStream.Length)
  $ms = New-Object System.IO.MemoryStream
  $netStream.CopyTo($ms)
  $bytes = $ms.ToArray()
  Write-Output ("bytes: " + $bytes.Length)
} catch {
  Write-Output ("AsStreamForRead FAILED: " + $_.Exception.Message)
}
