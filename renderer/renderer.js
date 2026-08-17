// 渲染进程逻辑 - P2：显示 GSMTC 音乐状态 + 控制按钮 + 封面取色渐变
(function () {
  const titleEl = document.getElementById('title')
  const artistEl = document.getElementById('artist')
  const coverEl = document.getElementById('cover')
  const coverImg = document.getElementById('coverImg')
  const islandEl = document.getElementById('island')
  const toggleEl = document.getElementById('toggle')
  const infoEl = document.getElementById('info')
  const progressFill = document.getElementById('progressFill')
  const ringFg = document.getElementById('ringFg')

  let isPlaying = false // 播放状态，驱动律动形态状态机（播放→真 FFT，暂停→呼吸线）
  let lastTitle = '' // 上一首标题，切歌时触发过渡动画
  // 进度基准：position(秒) + 收到时间戳 + 时长 + 是否播放；前端本地插值让进度条平滑推进
  let progressBase = { position: 0, at: Date.now(), duration: 0, playing: false }

  const btnPrev = document.getElementById('prev')
  const btnNext = document.getElementById('next')

  // 播放/暂停状态用 class 切换（两个 SVG 图标在按钮里交叉淡入淡出）
  function render(state) {
    const playing = state && state.hasSession && state.status === 'Playing'
    isPlaying = playing // 供乐观切换对账 + 驱动律动状态机
    Visualizer.setPlaying(playing)
    toggleEl.classList.toggle('playing', playing)
    islandEl.classList.toggle('playing', playing) // 播放态样式：封面旋转等

    if (!state || !state.hasSession) {
      titleEl.textContent = '未播放'
      artistEl.textContent = '等待音乐…'
      setCover(null, null)
      progressBase = { position: 0, at: Date.now(), duration: 0, playing: false }
      return
    }

    const newTitle = state.title || ''
    // 切歌检测：标题变化 → 触发封面/文字过渡动画
    if (newTitle && newTitle !== lastTitle) {
      lastTitle = newTitle
      coverEl.classList.remove('cover-switch')
      infoEl.classList.remove('info-switch')
      void coverEl.offsetWidth // 强制重排，让动画重新触发
      coverEl.classList.add('cover-switch')
      infoEl.classList.add('info-switch')
    }

    // 保存进度基准，前端本地插值平滑推进（1s 轮询靠插值补足中间帧）
    if (typeof state.duration === 'number' && state.duration > 0) {
      progressBase = { position: state.position || 0, at: Date.now(), duration: state.duration, playing }
    }

    titleEl.textContent = newTitle || '未知曲目'
    artistEl.textContent = state.artist || '未知歌手'
    setCover(state.cover, state.title)
  }

  // 进度本地插值：播放中按流逝时间推进，暂停时停在基准位置（250ms 一次，平滑）
  const RING_C = 119.38 // 进度环圆周长 2π×19
  function updateProgress() {
    const { position, at, duration, playing } = progressBase
    if (!duration || duration <= 0) {
      progressFill.style.width = '0%'
      ringFg.style.strokeDashoffset = String(RING_C)
      return
    }
    const p = playing ? position + (Date.now() - at) / 1000 : position
    const ratio = Math.min(1, Math.max(0, p / duration))
    progressFill.style.width = (ratio * 100).toFixed(2) + '%'
    ringFg.style.strokeDashoffset = (RING_C * (1 - ratio)).toFixed(2)
  }
  setInterval(updateProgress, 250)
  updateProgress()

  let lastCoverSrc = ''

  // 封面直接铺满圆圈；同时取主色给播放键/高光用（--accent）
  function setCover(src, title) {
    coverEl.classList.toggle('no-cover', !src) // 无封面显示渐变音符占位
    if (!src) {
      lastCoverSrc = ''
      coverImg.style.display = 'none'
      coverImg.removeAttribute('src')
      coverEl.style.background = '' // 切换过程中不要兜底底色
      setAccent(null)
      return
    }
    if (src === lastCoverSrc) return
    lastCoverSrc = src

    const img = new Image()
    img.onload = () => {
      const colors = extractColors(img)
      setAccent(colors)
      coverImg.src = src
      coverImg.style.display = 'block'
    }
    img.onerror = () => {
      coverEl.style.background = ''
      coverImg.style.display = 'none'
      setAccent(null)
    }
    img.src = src
  }

  // 提取封面主色（最多 3 个），返回 [[r,g,b], ...]；取不到则 null。
  // 灰色过滤：量化后三通道差 ≤1 视为灰，灰占比 < 3/5 时排除灰桶（优先鲜艳色），
  // 灰占比 ≥ 3/5 说明封面本身灰色调，才允许用灰。
  function extractColors(img) {
    const size = 24
    const c = document.createElement('canvas')
    c.width = size
    c.height = size
    const ctx = c.getContext('2d', { willReadFrequently: true })
    try {
      ctx.drawImage(img, 0, 0, size, size)
      const data = ctx.getImageData(0, 0, size, size).data

      // 量化到 4bit/通道后统计（每通道 16 级）
      const buckets = new Map()
      let totalPx = 0
      let grayPx = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 125) continue // 跳过透明
        totalPx++
        const r = data[i] >> 4
        const g = data[i + 1] >> 4
        const b = data[i + 2] >> 4
        const key = (r << 8) | (g << 4) | b
        buckets.set(key, (buckets.get(key) || 0) + 1)
        if (Math.abs(r - g) <= 1 && Math.abs(g - b) <= 1 && Math.abs(r - b) <= 1) grayPx++
      }
      if (buckets.size < 2) return null

      const toRgb = (k) => [
        ((k >> 8) & 0xf) * 16 + 8,
        ((k >> 4) & 0xf) * 16 + 8,
        (k & 0xf) * 16 + 8,
      ]
      const isGray = (k) => {
        const r = (k >> 8) & 0xf
        const g = (k >> 4) & 0xf
        const b = k & 0xf
        return Math.abs(r - g) <= 1 && Math.abs(g - b) <= 1 && Math.abs(r - b) <= 1
      }

      const sorted = [...buckets.entries()].sort((a, b) => b[1] - a[1])
      // 灰占比 < 3/5 → 排除灰桶（优先鲜艳色）；否则保留（封面本身灰色调）
      let candidates = sorted
      if (grayPx / totalPx < 0.6) {
        const vivid = sorted.filter(([k]) => !isGray(k))
        if (vivid.length >= 2) candidates = vivid
      }

      // 主色 = 出现最多；次色在前 10 高频色里选与已选「距离最远」的，保证三色差异大
      const pool = candidates.slice(0, Math.min(candidates.length, 10))
      const picked = [pool[0][0]]
      const result = [toRgb(pool[0][0])]
      for (let n = 1; n < 3 && n < pool.length; n++) {
        let bestKey = null
        let bestDist = -1
        for (const [key] of pool) {
          if (picked.includes(key)) continue
          let minDist = Infinity
          for (const pk of picked) {
            const a = toRgb(key)
            const b = toRgb(pk)
            const dist = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
            minDist = Math.min(minDist, dist)
          }
          if (minDist > bestDist) { bestDist = minDist; bestKey = key }
        }
        if (bestKey == null) break
        picked.push(bestKey)
        result.push(toRgb(bestKey))
      }
      return result
    } catch (e) {
      return null
    }
  }

  // HSL 提亮：暗色只提亮度、锁住色相和饱和度，避免向灰/白线性插值洗成灰色
  function liftLuma(rgb, minLuma) {
    let r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    let h, s, l = (max + min) / 2
    if (max === min) { h = 0; s = 0 } // 无饱和（本身是灰）
    else {
      const d = max - min
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
      else if (max === g) h = (b - r) / d + 2
      else h = (r - g) / d + 4
      h /= 6
    }
    l = Math.max(l, minLuma)
    if (s === 0) { r = g = b = l }
    else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s
      const p = 2 * l - q
      const f = (t) => { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p }
      r = f(h + 1 / 3); g = f(h); b = f(h - 1 / 3)
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]
  }

  // 把主色写进 CSS 变量，供主键渐变/光晕复用。
  // 无封面（切歌中/失败）时用中性灰，不显示任何残留/过渡颜色
  function setAccent(colors) {
    const list = colors && colors.length ? colors : [[76, 80, 86]]
    const c0 = liftLuma(list[0], 0.3) // 暗色提亮但保色相/饱和度
    islandEl.style.setProperty('--accent', c0.join(','))
    islandEl.style.setProperty('--accent-deep', c0.map((v) => Math.round(v * 0.5)).join(','))
    // 次色备用：--accent2 / --accent3（同样提亮），供多形态配色扩展
    if (list[1]) islandEl.style.setProperty('--accent2', liftLuma(list[1], 0.3).join(','))
    if (list[2]) islandEl.style.setProperty('--accent3', liftLuma(list[2], 0.3).join(','))
  }

  // 暂停键延迟优化：点击瞬间乐观切换图标，等 GSMTC 真实状态回来再对账
  function optimisticToggle() {
    isPlaying = !isPlaying
    Visualizer.setPlaying(isPlaying)
    toggleEl.classList.toggle('playing', isPlaying)
  }

  // 按钮 -> 主进程
  btnPrev.addEventListener('click', () => window.island.musicCommand('prev'))
  toggleEl.addEventListener('click', () => {
    optimisticToggle()
    window.island.musicCommand('toggle')
  })
  btnNext.addEventListener('click', () => window.island.musicCommand('next'))
  // 点击封面 = 播放/暂停
  coverEl.addEventListener('click', () => {
    optimisticToggle()
    window.island.musicCommand('toggle')
  })

  // 订阅状态更新
  window.island.onMusicUpdate(render)

  // --- 拖动与固定 ---
  let isPinned = false

  // 固定状态：固定后禁止拖动
  window.island.onPinned((pinned) => {
    isPinned = pinned
    islandEl.classList.toggle('pinned', pinned)
  })

  // --- 悬停锚定：贴右时悬停向左放大 ---
  // 主进程判定「贴右」后把透明窗口左移让出放大空间，并把岛的 CSS 锚点切到右缘，
  // 岛 :hover 放大就从"向右长"变成"向左长"
  let anchorRight = false
  let anchorCenter = false
  let hoverLock = false // 拖拽结束瞬间锁住收起态，等主进程确认锚定方向后再展开
  function setAnchor(right, center) {
    anchorRight = !!right
    anchorCenter = !!center
    islandEl.classList.toggle('anchor-right', anchorRight)
    islandEl.classList.toggle('anchor-center', anchorCenter)
  }
  window.island.onAnchorRight((right) => {
    setAnchor(right, anchorCenter)
    if (hoverLock) {
      hoverLock = false
      islandEl.classList.remove('hover-lock')
    }
  })
  window.island.onAnchorCenter((center) => {
    setAnchor(anchorRight, center)
    if (hoverLock) {
      hoverLock = false
      islandEl.classList.remove('hover-lock')
    }
  })

  // 收拢态（拖到上边缘的细条波浪）：切换 .docked 外观，波浪改为垂直居中。
  // 收拢后立即用最近一次光标位置校准 .docked-idle（拖拽结束光标可能停在岛外；
  // 停在岛内则悬停展开成普通岛，由 mousemove 实时校准）
  // 收拢后立即用最近一次光标位置校准 .docked-idle（拖拽结束光标可能停在岛外；
  // 停在岛内则悬停展开成普通岛，由 refreshInteractive 实时校准）
  let docked = false
  window.island.onDocked((d) => {
    docked = !!d
    document.body.classList.toggle('docked', docked)
    if (docked) {
      setDockedIdle(cursorIsOnIsland())
    } else {
      islandEl.classList.remove('docked-idle')
    }
  })

  // 兜底收拢：点击穿透（setIgnoreMouseEvents）下浏览器收不到 mouseleave，
  // 岛的 :hover 会卡在展开态。主进程看门狗发现光标已离开窗口 → 强制收拢，
  // 等光标回到岛上（mousemove/pointerenter 命中岛）再解除，让 :hover 重新接管。
  // 拖动/菜单展开时跳过（拖拽由 .dragging 锁收起态，菜单有窗口尺寸接管）
  window.island.onForceCollapse(() => {
    if (dragging || menuOpen) return
    islandEl.classList.add('forced-collapse')
    // 光标已确认在窗口外：贴顶细条里的波浪也该压成细条，否则 :hover 卡住时
    // 满幅波浪被 16px 条裁成一条缝，看起来又高又乱
    setDockedIdle(false)
  })

  // 启动默认中锚（与主进程 anchorMode='center' 一致），岛在窗口内居中
  setAnchor(false, true)

  // 手动拖动：pointer capture 保证快速拖动时鼠标移出窗口也不丢。
  // 窗口全程 expanded，岛按锚点嵌在窗口内；拖动窗口即拖动岛，锚点不变
  let dragging = false
  let dragWinX = 0
  let dragWinY = 0
  let dragStartScreenX = 0
  let dragStartScreenY = 0
  let dragStartClientX = 0
  let dragStartClientY = 0
  let dragW = 0
  let dragH = 0

  function initDragBaseline() {
    // 无边框窗口：client(0,0) 就是窗口左上角，据此反推窗口当前屏幕坐标
    dragWinX = dragStartScreenX - dragStartClientX
    dragWinY = dragStartScreenY - dragStartClientY
    // 记录岛屿实际渲染尺寸（含 zoom），主进程按它钳制岛的位置
    const r = islandEl.getBoundingClientRect()
    dragW = r.width
    dragH = r.height
  }

  islandEl.addEventListener('pointerdown', (e) => {
    if (isPinned) return
    // 音频捕获首次因缺用户手势失败：这次点击就是手势，重试（逻辑见 visualizer.js）
    Visualizer.retryCapture()
    if (e.target.closest('.btn') || e.target.closest('.cover')) return // 按钮/封面不参与拖动
    dragging = true
    islandEl.classList.add('dragging') // 拖动时不悬停放大
    dragStartScreenX = e.screenX
    dragStartScreenY = e.screenY
    dragStartClientX = e.clientX
    dragStartClientY = e.clientY
    initDragBaseline()
    islandEl.setPointerCapture(e.pointerId)
  })

  islandEl.addEventListener('pointermove', (e) => {
    if (!dragging) return
    window.island.moveWindow(
      dragWinX + (e.screenX - dragStartScreenX),
      dragWinY + (e.screenY - dragStartScreenY),
      dragW,
      dragH
    )
  })

  const endDrag = (e) => {
    if (!dragging) return
    dragging = false
    islandEl.classList.remove('dragging')
    // 先锁住收起态：等主进程确认锚定方向（anchorRight/anchorCenter 回调）后再展开
    hoverLock = true
    islandEl.classList.add('hover-lock')
    // 拖拽结束：上报松手时窗口左上角屏幕坐标，主进程据此定锚点 + 判断是否收拢到上边缘
    window.island.dragEnd(
      dragWinX + (e.screenX - dragStartScreenX),
      dragWinY + (e.screenY - dragStartScreenY)
    )
    try { islandEl.releasePointerCapture(e.pointerId) } catch (err) {}
  }
  islandEl.addEventListener('pointerup', endDrag)
  islandEl.addEventListener('pointercancel', endDrag)

  // --- 点击穿透：透明窗口区域不拦截鼠标（消除「虚拟墙」） ---
  // 光标在岛上 → 窗口接收鼠标；光标在透明区 → setIgnoreMouseEvents 穿透到桌面。
  // mousemove 快路径 + 主进程光标轮询兜底：穿透时 mousemove 会丢/滞后，命中判断会
  // 卡在旧状态 → 悬停放大后左右残留透明墙。用主进程回传的真实光标坐标定时自纠。
  let interactive = true
  let cursorX = -1
  let cursorY = -1
  function setInteractive(v) {
    if (interactive === v) return
    interactive = v
    window.island.setInteractive(v)
  }
  // 贴顶收拢态维护 .docked-idle：真实光标在岛外 → 细条收起。
  // 不依赖 :hover（点击穿透会冻结它），只依据真实光标命中
  function setDockedIdle(onIsland) {
    if (!docked) { islandEl.classList.remove('docked-idle'); return }
    islandEl.classList.toggle('docked-idle', !onIsland)
  }
  // 纯几何命中（getBoundingClientRect），穿透态下也准确
  function cursorIsOnIsland() {
    if (cursorX < 0 || cursorY < 0) return false
    const r = islandEl.getBoundingClientRect()
    const inset = 2
    return cursorX >= r.left + inset && cursorX <= r.right - inset &&
           cursorY >= r.top + inset && cursorY <= r.bottom - inset
  }
  // 命中判断 + 交互态纠偏；拖动/菜单展开中锁定可交互，不做穿透。
  // 用 getBoundingClientRect 做纯几何命中（elementFromPoint 在穿透态下会命中错误元素，
  // 导致边界附近残留透明墙），并留 2px 内缩容差，避免边界抖动
  function refreshInteractive() {
    if (dragging || menuOpen) return
    if (cursorX < 0 || cursorY < 0) return
    const onIsland = cursorIsOnIsland()
    if (onIsland) islandEl.classList.remove('forced-collapse') // 光标回岛：解除兜底收拢，:hover 重新接管
    setDockedIdle(onIsland)
    setInteractive(onIsland)
  }
  window.addEventListener('mousemove', (e) => {
    cursorX = e.clientX
    cursorY = e.clientY
    refreshInteractive()
  })
  // 主进程每 120ms 轮询光标回传真实坐标（穿透时浏览器收不到 mousemove，靠它纠偏）
  window.island.onCursor((pt) => {
    if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
      cursorX = pt.x
      cursorY = pt.y
      refreshInteractive()
    }
  })
  // 光标回到岛上（比如从别的应用切回）时确保可交互，并解除兜底收拢
  islandEl.addEventListener('pointerenter', () => {
    islandEl.classList.remove('forced-collapse')
    setDockedIdle(true)
    setInteractive(true)
  })

  // --- 大小缩放（CSS zoom + 窗口同步 + localStorage 持久化） ---
  const MIN_SCALE = 0.67
  let scale = parseFloat(localStorage.getItem('islandScale'))
  if (!(scale >= MIN_SCALE && scale <= 1)) scale = 1

  function applyScale(s) {
    scale = Math.min(1, Math.max(MIN_SCALE, s))
    islandEl.style.zoom = String(scale)
    // 三档：>0.9 歌名+歌手；0.74~0.9 只留歌名；≤0.74 紧凑（信息全隐藏）
    islandEl.classList.toggle('mid', scale > 0.74 && scale <= 0.9)
    islandEl.classList.toggle('compact', scale <= 0.74)
    localStorage.setItem('islandScale', String(scale))
  }
  applyScale(scale)
  // 启动时把持久化尺寸同步给主进程（此后缩放由菜单窗口触发，经 onScale 回传应用）
  window.island.setScale(scale)
  window.island.onScale((s) => applyScale(s))

  // --- 右键菜单（独立窗口，替代原生菜单） ---
  // 菜单是主进程创建的一个透明置顶小窗口，随右键在光标处弹出。
  // 岛窗口尺寸全程不变 → 开/关菜单都不会再有窗口收缩/闪烁
  let menuOpen = false // 菜单窗口展开中：期间 mousemove 不切穿透、看门狗不强制收拢
  window.island.onMenuOpen((open) => {
    menuOpen = open
  })

  window.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    // 上报岛窗口内坐标（右键位置），主进程换算成屏幕坐标后弹出菜单窗口
    window.island.setMenuOpen(true, e.clientX, e.clientY)
  })

  // --- 背景不透明度（--island-alpha）：菜单窗口滑杆经主进程回传应用 ---
  let bgOpacity = parseFloat(localStorage.getItem('islandBgOpacity'))
  if (!(bgOpacity >= 0.2 && bgOpacity <= 1)) bgOpacity = 0.92
  function applyBgOpacity(v) {
    bgOpacity = Math.min(1, Math.max(0.2, v))
    islandEl.style.setProperty('--island-alpha', String(bgOpacity))
    localStorage.setItem('islandBgOpacity', String(bgOpacity))
  }
  applyBgOpacity(bgOpacity)
  window.island.onBgOpacity((v) => applyBgOpacity(v))
  // 动效形态：订阅菜单切换 + 启动律动系统（绘制逻辑见 visualizer.js）
  window.island.onStyle((s) => Visualizer.setStyle(s))
  Visualizer.init({ islandEl, coverEl })
})()
