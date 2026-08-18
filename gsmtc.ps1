# GSMTC 音乐控制桥接 (持久进程, 行协议) —— 多源融合版
# 输入: 每行一个命令  get | play | pause | next | prev | toggle | quit
# 输出: 每行一个 JSON 响应
#
# 源1 (GSMTC 系统媒体会话): 汽水音乐/QQ音乐/酷狗音乐等接 SMTC 的播放器，信息最全
#   (标题/歌手/专辑/封面/进度/播放状态)，控制走 TryPlayAsync 等。
# 源2 (窗口标题抓取): QQ音乐/酷狗音乐不接 SMTC 时，从窗口标题解析「歌名 - 歌手」；
#   控制走全局媒体键，播放状态靠乐观切换维护。
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

# --- Win32: 窗口枚举 + 媒体键模拟 ---
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32Music {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lp);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder t, int max);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
'@



# 媒体键 VK 码
$VK_NEXT      = 0xB0  # VK_MEDIA_NEXT_TRACK
$VK_PREV      = 0xB1  # VK_MEDIA_PREV_TRACK
$VK_PLAYPAUSE = 0xB3  # VK_MEDIA_PLAY_PAUSE

# 播放器进程名 -> 显示名
$script:players = @{ 'QQMusic' = 'QQ音乐'; 'KuGou' = '酷狗音乐' }

# 窗口标题黑名单（前缀匹配）：以这些词开头/相等即排除，避免把歌词窗/系统窗当歌名
$script:blacklist = @(
  '桌面歌词', 'QQMusic_COM_WND', 'QQMusic_MolePluginWnd', 'GDI+ Window',
  'MediaPlayer SMTC window', 'Default IME', 'MSCTFIME UI',
  'AsyncDNSWindow', 'TXMenuWindow', 'QQ音乐', '酷狗音乐',
  '迷你播放器', '播放队列', '消息中心', '手机传歌', '传歌到设备',
  'DynamicLyricWindow', 'QQMusic Dummy Window'
)

function Test-Blacklisted($t) {
  $t = $t.Trim()
  if ($t -eq '') { return $true }
  foreach ($b in $script:blacklist) {
    if ($t -eq $b -or $t.StartsWith($b)) { return $true }
  }
  return $false
}

# 加载 GSMTC 类型并请求会话管理器 (只请求一次, 缓存)
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$script:manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

# --- 模式状态机 ---
$script:mode = 'gsmtc'            # 当前路由: 'gsmtc' | 'title'
$script:activeSession = $null     # 上次 get 选中的 GSMTC 会话（控制命令作用于此）
$script:thumbData = $null         # 当前歌的封面 data URI（GSMTC 源）
$script:mediaKey = ''             # 当前歌的媒体键（source|标题|歌手|专辑），用于切歌检测
$script:titleKey = ''             # 当前歌的窗口标题键（进程|标题|歌手），用于切歌检测
$script:titlePlaying = $true      # 窗口标题源的乐观播放状态（真实状态读不到）

# --- GSMTC 封面：播放器常经系统媒体会话暴露缩略图，读出来当岛封面 ---
function Get-ThumbnailDataUri($thumbRef) {
  if (-not $thumbRef) { return $null }
  try {
    $stream = Await ($thumbRef.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
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
    $mime = 'image/jpeg'
    if ($bytes.Length -ge 8 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47) { $mime = 'image/png' }
    return "data:$mime;base64," + [Convert]::ToBase64String($bytes)
  } catch {
    return $null
  }
}

# --- 源1: GSMTC 多会话枚举，取 Playing 优先 ---
function Get-GsmtcState {
  if (-not $script:manager) { return $null }
  try {
    $sessions = @($script:manager.GetSessions())
  } catch { return $null }
  if ($sessions.Count -eq 0) { return $null }

  $s = $null
  foreach ($cand in $sessions) {
    try {
      $pb0 = $cand.GetPlaybackInfo()
      if ([string]$pb0.PlaybackStatus -eq 'Playing') { $s = $cand; break }
    } catch {}
  }
  if (-not $s) { $s = $sessions[0] }
  $script:activeSession = $s

  try {
    $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $pb = $s.GetPlaybackInfo()
    $tl = $s.GetTimelineProperties()
    $source = [string]$s.SourceAppUserModelId

    # 切歌时缩略图可能滞后/不更新 → 与上一首字节一致则判过期，交给在线搜索兜底
    $thumb = Get-ThumbnailDataUri $props.Thumbnail
    $key = "$source|$($props.Title)|$($props.Artist)|$($props.AlbumTitle)"
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
      position = if ($tl) { [double]$tl.Position.TotalSeconds } else { 0 }
      duration = if ($tl) { [double]($tl.EndTime - $tl.StartTime).TotalSeconds } else { 0 }
      source = $source
    }
    if ($script:thumbData) { $out.cover = $script:thumbData }
    return $out
  } catch {
    return $null
  }
}

# --- 源2: 窗口标题抓取（QQ音乐/酷狗），解析「歌名 - 歌手」 ---
function Get-TitleState {
  try {
    $procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $script:players.ContainsKey($_.ProcessName) }
  } catch { return $null }
  if (-not $procs) { return $null }

  $pidMap = @{}
  foreach ($p in $procs) { $pidMap[[int]$p.Id] = $p.ProcessName }

  $found = New-Object System.Collections.Generic.List[object]
  $cb = [Win32Music+EnumWindowsProc]{
    param($h, $l)
    $pid2 = 0
    [void][Win32Music]::GetWindowThreadProcessId($h, [ref]$pid2)
    if ($pidMap.ContainsKey([int]$pid2)) {
      $len = [Win32Music]::GetWindowTextLength($h)
      if ($len -gt 0) {
        $sb = New-Object System.Text.StringBuilder ($len + 1)
        [void][Win32Music]::GetWindowText($h, $sb, $len + 1)
        $found.Add([pscustomobject]@{ Proc = $pidMap[[int]$pid2]; Title = $sb.ToString(); Hwnd = $h })
      }
    }
    return $true
  }
  [void][Win32Music]::EnumWindows($cb, [IntPtr]::Zero)

  foreach ($f in $found) {
    $t = $f.Title.Trim()
    if (Test-Blacklisted $t) { continue }
    if ($t -notmatch ' - ') { continue }  # 不含分隔符，不是「歌名 - 歌手」

    $parts = @($t -split ' - ' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    if ($parts.Count -lt 2) { continue }

    # 剥掉尾部播放器名后缀（如「歌名 - 酷狗音乐」「歌名 - 歌手 - QQ音乐」）
    while ($parts.Count -ge 2 -and $parts[-1] -in @('酷狗音乐', 'QQ音乐')) {
      $parts = $parts[0..($parts.Count - 2)]
    }
    if ($parts.Count -ge 2) {
      $title = ($parts[0..($parts.Count - 2)] -join ' - ')
      $artist = $parts[-1]
    } elseif ($parts.Count -eq 1) {
      $title = $parts[0]
      $artist = ''
    } else {
      continue
    }

    $proc = [string]$f.Proc
    $key = "$proc|$title|$artist"
    if ($key -ne $script:titleKey) {
      $script:titleKey = $key
      $script:titlePlaying = $true  # 切歌 → 默认播放中
    }
    return @{
      hasSession = $true
      title  = $title
      artist = $artist
      status = if ($script:titlePlaying) { 'Playing' } else { 'Paused' }
      source = $script:players[$proc]
    }
  }
  return $null
}

# --- 融合：GSMTC Playing 优先；QQ/酷狗 Paused 以 GSMTC 真实状态为准 ---
function Get-State {
  $gs = Get-GsmtcState
  if ($gs -and $gs.status -eq 'Playing') {
    $script:mode = 'gsmtc'
    return $gs
  }
  $ts = Get-TitleState
  if ($ts) {
    # QQ/酷狗接 SMTC：若存在其 Paused 会话（真暂停），以 GSMTC 为准，避免乐观态错显示成 Playing
    if ($gs) {
      $script:mode = 'gsmtc'
      return $gs
    }
    $script:mode = 'title'
    return $ts
  }
  if ($gs) {
    $script:mode = 'gsmtc'
    return $gs
  }
  $script:mode = 'gsmtc'
  return @{ hasSession = $false }
}

# --- 媒体键模拟（窗口标题源的控制） ---
function Send-MediaKey($vk) {
  try {
    [Win32Music]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 30
    [Win32Music]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)
  } catch {}
}


# --- 窗口标题源控制路由：QQ/酷狗走全局媒体键 ---
function Send-TitleControl($action) {
  switch ($action) {
    'next'  { Send-MediaKey $VK_NEXT }
    'prev'  { Send-MediaKey $VK_PREV }
    default { Send-MediaKey $VK_PLAYPAUSE }
  }
}

# --- GSMTC 控制（gsmtc 源） ---
function Invoke-GsmtcControl($action) {
  $s = $script:activeSession
  if (-not $s) { return }
  switch ($action) {
    'play'   { $null = Await ($s.TryPlayAsync()) ([bool]) }
    'pause'  { $null = Await ($s.TryPauseAsync()) ([bool]) }
    'next'   { $null = Await ($s.TrySkipNextAsync()) ([bool]) }
    'prev'   { $null = Await ($s.TrySkipPreviousAsync()) ([bool]) }
    'toggle' { $null = Await ($s.TryTogglePlayPauseAsync()) ([bool]) }
  }
}

function Send-Json($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 4
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

# 主循环: 读命令 -> 执行 -> 响应
while (($cmd = [Console]::In.ReadLine()) -ne $null) {
  $cmd = $cmd.Trim().ToLower()
  switch ($cmd) {
    'get' { Send-Json (Get-State) }
    'play' {
      if ($script:mode -eq 'title') { Send-TitleControl 'play'; $script:titlePlaying = $true }
      else { Invoke-GsmtcControl 'play' }
      Send-Json (Get-State)
    }
    'pause' {
      if ($script:mode -eq 'title') { Send-TitleControl 'pause'; $script:titlePlaying = $false }
      else { Invoke-GsmtcControl 'pause' }
      Send-Json (Get-State)
    }
    'next' {
      if ($script:mode -eq 'title') { Send-TitleControl 'next' }
      else { Invoke-GsmtcControl 'next' }
      Send-Json (Get-State)
    }
    'prev' {
      if ($script:mode -eq 'title') { Send-TitleControl 'prev' }
      else { Invoke-GsmtcControl 'prev' }
      Send-Json (Get-State)
    }
    'toggle' {
      if ($script:mode -eq 'title') {
        Send-TitleControl 'toggle'
        $script:titlePlaying = -not $script:titlePlaying
      } else { Invoke-GsmtcControl 'toggle' }
      Send-Json (Get-State)
    }
    'quit' { break }
    default { Send-Json (Get-State) }
  }
}
