# GSMTC 音乐控制桥接 (持久进程, 行协议)
# 输入: 每行一个命令  get | play | pause | next | prev | toggle | quit
# 输出: 每行一个 JSON 响应
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# --- WinRT 异步等待辅助 (把 IAsyncOperation<T> 转成同步 .NET Task 再取结果) ---
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

# 加载 GSMTC 类型并请求会话管理器 (只请求一次, 缓存)
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$script:manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

function Get-State {
  $out = @{ hasSession = $false }
  if ($script:manager) {
    $s = $script:manager.GetCurrentSession()
    if ($s) {
      $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $pb = $s.GetPlaybackInfo()
      $out = @{
        hasSession = $true
        title  = [string]$props.Title
        artist = [string]$props.Artist
        album  = [string]$props.AlbumTitle
        status = [string]$pb.PlaybackStatus
        source = [string]$s.SourceAppUserModelId
      }
    }
  }
  return $out
}

function Send-Json($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 4
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

# 主循环: 读命令 -> 执行 -> 响应
while (($cmd = [Console]::In.ReadLine()) -ne $null) {
  $cmd = $cmd.Trim().ToLower()
  $s = if ($script:manager) { $script:manager.GetCurrentSession() } else { $null }
  switch ($cmd) {
    'get'    { Send-Json (Get-State) }
    'play'   { if ($s) { $null = Await ($s.TryPlayAsync()) ([bool]) }; Send-Json (Get-State) }
    'pause'  { if ($s) { $null = Await ($s.TryPauseAsync()) ([bool]) }; Send-Json (Get-State) }
    'next'   { if ($s) { $null = Await ($s.TrySkipNextAsync()) ([bool]) }; Send-Json (Get-State) }
    'prev'   { if ($s) { $null = Await ($s.TrySkipPreviousAsync()) ([bool]) }; Send-Json (Get-State) }
    'toggle' { if ($s) { $null = Await ($s.TryTogglePlayPauseAsync()) ([bool]) }; Send-Json (Get-State) }
    'quit'   { break }
    default  { Send-Json (Get-State) }
  }
}
