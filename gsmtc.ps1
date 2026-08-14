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

# --- GSMTC 封面：播放器常经系统媒体会话暴露缩略图（汽水音乐等），读出来当岛封面 ---
$script:thumbData = $null   # 当前歌的封面 data URI（null = 无 / 已判为过期缩略图）
$script:mediaKey = ''       # 当前歌的媒体键（标题|歌手|专辑），用于切歌检测

function Get-ThumbnailDataUri($thumbRef) {
  if (-not $thumbRef) { return $null }
  try {
    $stream = Await ($thumbRef.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    # WinRT 流对象在 PowerShell 里表现为 __ComObject，静态类型绑定不到扩展方法；
    # 用反射找 AsStream(IRandomAccessStream) 重载，把流转成 .NET Stream 再读字节
    $m = [System.IO.WindowsRuntimeStreamExtensions].GetMethods() |
      Where-Object { $_.Name -eq 'AsStream' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IRandomAccessStream' } |
      Select-Object -First 1
    if (-not $m) { return $null }
    $net = $m.Invoke($null, @($stream))
    $ms = New-Object System.IO.MemoryStream
    $net.CopyTo($ms)
    $bytes = $ms.ToArray()
    try { $net.Dispose() } catch {}
    try { $stream.GetType().InvokeMember('Close', [System.Reflection.BindingFlags]::InvokeMethod, $null, $stream, $null) | Out-Null } catch {}
    if ($bytes.Length -eq 0) { return $null }
    # 按文件头判 mime：PNG 魔数，其余按 JPEG 兜底
    $mime = 'image/jpeg'
    if ($bytes.Length -ge 8 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47) { $mime = 'image/png' }
    return "data:$mime;base64," + [Convert]::ToBase64String($bytes)
  } catch {
    return $null
  }
}

function Get-State {
  $out = @{ hasSession = $false }
  if ($script:manager) {
    $s = $script:manager.GetCurrentSession()
    if ($s) {
      $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $pb = $s.GetPlaybackInfo()
      # 切歌时 Windows 的 GSMTC 缩略图「标题先更新、缩略图后更新」，个别播放器（汽水音乐等）
      # 甚至可能一直不更新缩略图 → 若按标题键无条件缓存旧图，新歌就永远顶着上一首的封面。
      # 策略：切歌的当轮读一次封面，若新歌缩略图字节与上一首完全一致 → 判为过期缩略图，
      # 置空并交给在线搜索兜底；否则直接用。此后同一首歌保持该判定（在线兜底已接管，不再每秒开流重读）
      $thumb = Get-ThumbnailDataUri $props.Thumbnail
      $key = "$($props.Title)|$($props.Artist)|$($props.AlbumTitle)"
      if ($key -ne $script:mediaKey) {
        $script:mediaKey = $key
        if ($thumb -and $thumb -eq $script:thumbData) { $script:thumbData = $null }
        else { $script:thumbData = $thumb }
      }
      $out = @{
        hasSession = $true
        title  = [string]$props.Title
        artist = [string]$props.Artist
        album  = [string]$props.AlbumTitle
        status = [string]$pb.PlaybackStatus
        source = [string]$s.SourceAppUserModelId
      }
      if ($script:thumbData) { $out.cover = $script:thumbData }
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
