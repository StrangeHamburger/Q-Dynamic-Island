// 渲染进程逻辑 - P2：显示 GSMTC 音乐状态 + 控制按钮 + 封面取色渐变
(function () {
  const titleEl = document.getElementById('title')
  const artistEl = document.getElementById('artist')
  const coverEl = document.getElementById('cover')
  const coverImg = document.getElementById('coverImg')
  const islandEl = document.getElementById('island')
  const toggleEl = document.getElementById('toggle')

  const btnPrev = document.getElementById('prev')
  const btnNext = document.getElementById('next')

  // 右键菜单元素
  const menuEl = document.getElementById('menu')
  const scaleSlider = document.getElementById('scaleSlider')
  const scaleValue = document.getElementById('scaleValue')
  const pinCheck = document.getElementById('pinCheck')
  const menuClose = document.getElementById('menuClose')
  const menuQuit = document.getElementById('menuQuit')

  // 播放/暂停状态用 class 切换（两个 SVG 图标在按钮里交叉淡入淡出）
  function render(state) {
    const playing = state && state.hasSession && state.status === 'Playing'
    isPlaying = playing // 供波浪状态机驱动（播放→真 FFT，暂停→呼吸线）
    toggleEl.classList.toggle('playing', playing)

    if (!state || !state.hasSession) {
      titleEl.textContent = '未播放'
      artistEl.textContent = '等待音乐…'
      setCover(null, null)
      return
    }

    titleEl.textContent = state.title || '未知曲目'
    artistEl.textContent = state.artist || '未知歌手'
    setCover(state.cover, state.title)
  }

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
      setAccent(colors ? colors[0] : null)
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

  // 提取封面主色，返回 [[r,g,b], [r,g,b]]；取不到则 null
  function extractColors(img) {
    const size = 24
    const c = document.createElement('canvas')
    c.width = size
    c.height = size
    const ctx = c.getContext('2d', { willReadFrequently: true })
    try {
      ctx.drawImage(img, 0, 0, size, size)
      const data = ctx.getImageData(0, 0, size, size).data

      // 量化到 4bit/通道后统计
      const buckets = new Map()
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 125) continue // 跳过透明
        const r = data[i] >> 4
        const g = data[i + 1] >> 4
        const b = data[i + 2] >> 4
        const key = (r << 8) | (g << 4) | b
        buckets.set(key, (buckets.get(key) || 0) + 1)
      }
      if (buckets.size < 2) return null

      const sorted = [...buckets.entries()].sort((a, b) => b[1] - a[1])
      const toRgb = (k) => [
        ((k >> 8) & 0xf) * 16 + 8,
        ((k >> 4) & 0xf) * 16 + 8,
        (k & 0xf) * 16 + 8,
      ]

      const c0 = toRgb(sorted[0][0])
      // 第二色选「与主色距离最远」的，避免两个相近色合成平灰
      let bestKey = sorted[1][0]
      let bestDist = -1
      for (let i = 1; i < Math.min(sorted.length, 8); i++) {
        const rgb = toRgb(sorted[i][0])
        const dist = (rgb[0] - c0[0]) ** 2 + (rgb[1] - c0[1]) ** 2 + (rgb[2] - c0[2]) ** 2
        if (dist > bestDist) {
          bestDist = dist
          bestKey = sorted[i][0]
        }
      }
      return [c0, toRgb(bestKey)]
    } catch (e) {
      return null
    }
  }

  // 把主色写进 CSS 变量，供主键渐变/光晕复用。
  // 无封面（切歌中/失败）时用中性灰，不显示任何残留/过渡颜色
  function setAccent(rgb) {
    let c = rgb ? rgb.slice() : [76, 80, 86]
    // 封面色太暗会让主键看不清：向浅灰提亮到可辨识亮度
    const lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255
    if (lum < 0.3) {
      const t = Math.min(1, (0.3 - lum) / 0.3)
      for (let i = 0; i < 3; i++) c[i] = Math.round(c[i] + (176 - c[i]) * t)
    }
    islandEl.style.setProperty('--accent', c.join(','))
    islandEl.style.setProperty('--accent-deep', c.map((v) => Math.round(v * 0.5)).join(','))
  }

  // 暂停键延迟优化：点击瞬间乐观切换图标，等 GSMTC 真实状态回来再对账
  function optimisticToggle() {
    isPlaying = !isPlaying
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
    if (pinCheck) pinCheck.checked = pinned
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
  let docked = false
  window.island.onDocked((d) => {
    docked = !!d
    document.body.classList.toggle('docked', docked)
    if (docked) {
      const el = document.elementFromPoint(lastMouseX, lastMouseY)
      setDockedIdle(!!el && islandEl.contains(el))
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
    // 音频捕获首次因缺用户手势失败：这次点击就是手势，重试
    if (captureFailed && waveEnabled) {
      captureFailed = false
      ensureAudioCapture()
    }
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
  // forward:true 让穿透期间仍能收到 mousemove，据此判断光标何时回到岛上
  let interactive = true
  let lastMouseX = 0
  let lastMouseY = 0
  function setInteractive(v) {
    if (interactive === v) return
    interactive = v
    window.island.setInteractive(v)
  }
  // 贴顶收拢态维护 .docked-idle：真实光标在岛外 → 细条收起。
  // 不依赖 :hover（点击穿透会冻结它），只依据每次 mousemove 的真实光标命中
  function setDockedIdle(onIsland) {
    if (!docked) { islandEl.classList.remove('docked-idle'); return }
    islandEl.classList.toggle('docked-idle', !onIsland)
  }
  window.addEventListener('mousemove', (e) => {
    lastMouseX = e.clientX
    lastMouseY = e.clientY
    if (dragging || menuOpen) return // 拖动/菜单展开时必须始终可交互
    const el = document.elementFromPoint(e.clientX, e.clientY)
    const onIsland = !!el && islandEl.contains(el)
    if (onIsland) islandEl.classList.remove('forced-collapse') // 光标回岛：解除兜底收拢，:hover 重新接管
    setDockedIdle(onIsland)
    setInteractive(onIsland)
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
    scaleSlider.value = scale
    scaleValue.textContent = Math.round(scale * 100) + '%'
    localStorage.setItem('islandScale', String(scale))
    window.island.setScale(scale)
  }
  applyScale(scale)

  // --- 自定义右键菜单（黑色，替代原生菜单） ---
  // 菜单区高度预算（与 main.js 的 MENU_SIZE 一致）：菜单打开时窗口在放大态基础上向下扩展出这块区域
  const MENU_H = 250
  const EXPANDED_H = 92 // 放大态高度（与 main.js SIZE.expanded 一致）

  let menuOpen = false // 菜单展开中：期间强制窗口可交互，mousemove 不再根据光标位置切穿透
  let lastMenuX = 0
  let lastMenuY = 0
  let pendingMenuShow = false

  function showMenu() {
    pendingMenuShow = false
    menuEl.hidden = false
    // 目标窗口高 = 放大态高 + 菜单区高（与 main.js MENU_SIZE 一致）。
    // resize 完成前 window.innerHeight 还是小窗口的高，按它钳制会算出负上界、把菜单顶出屏幕上方；
    // 用确定性目标值，等 resize 完成后 maybeShowMenu 会再跑一次 showMenu 用真实高度重新钳制
    const targetH = Math.round(EXPANDED_H * scale) + MENU_H
    menuEl.style.left = Math.min(Math.max(8, lastMenuX), Math.max(8, window.innerWidth - menuEl.offsetWidth - 8)) + 'px'
    menuEl.style.top = Math.min(Math.max(72, lastMenuY), Math.max(72, targetH - menuEl.offsetHeight - 8)) + 'px'
  }

  // 窗口切到菜单高度（放大高 + 菜单区）后再摆放/显示菜单：否则窗口还是岛屿尺寸时，
  // 菜单会先被旧窗口裁掉（只露出一半），等 resize 完成才补全。
  // resize 完成后即使已由 500ms 兜底显示过，也再跑一次 showMenu 用真实高度重新钳制
  function maybeShowMenu() {
    if (!menuOpen) return
    if (window.innerHeight !== Math.round(EXPANDED_H * scale) + MENU_H) return
    showMenu()
  }
  window.addEventListener('resize', maybeShowMenu)

  function openMenu() {
    menuOpen = true
    pinCheck.checked = isPinned
    document.body.classList.add('menu-open')
    pendingMenuShow = true
    setInteractive(true) // 菜单需要点击：确保窗口可交互（menuOpen 期间 mousemove 不会把它切回穿透）
    window.island.setMenuOpen(true)
    maybeShowMenu()
    // 兜底：万一 resize 事件没触发，也强制显示
    setTimeout(() => {
      if (pendingMenuShow) showMenu()
    }, 500)
  }

  function closeMenu() {
    menuOpen = false
    pendingMenuShow = false
    menuEl.hidden = true
    document.body.classList.remove('menu-open')
    window.island.setMenuOpen(false)
  }

  window.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    if (menuOpen) closeMenu()
    else {
      lastMenuX = e.clientX
      lastMenuY = e.clientY
      openMenu()
    }
  })

  // 点击菜单外部关闭（滑杆/勾选都在菜单内，不受影响）
  document.addEventListener('click', (e) => {
    if (menuOpen && !e.target.closest('.menu')) closeMenu()
  })

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menuOpen) closeMenu()
  })

  scaleSlider.addEventListener('input', () => applyScale(parseFloat(scaleSlider.value)))

  // --- 背景不透明度滑块：覆盖 --island-alpha，越小岛越透（0.2~1，默认 0.92） ---
  const bgOpacitySlider = document.getElementById('bgOpacitySlider')
  const bgOpacityValue = document.getElementById('bgOpacityValue')
  let bgOpacity = parseFloat(localStorage.getItem('islandBgOpacity'))
  if (!(bgOpacity >= 0.2 && bgOpacity <= 1)) bgOpacity = 0.92
  function applyBgOpacity(v) {
    bgOpacity = Math.min(1, Math.max(0.2, v))
    islandEl.style.setProperty('--island-alpha', String(bgOpacity))
    bgOpacitySlider.value = String(bgOpacity)
    bgOpacityValue.textContent = Math.round(bgOpacity * 100) + '%'
    localStorage.setItem('islandBgOpacity', String(bgOpacity))
  }
  applyBgOpacity(bgOpacity)
  bgOpacitySlider.addEventListener('input', () => applyBgOpacity(parseFloat(bgOpacitySlider.value)))

  pinCheck.addEventListener('change', () => window.island.setPinned(pinCheck.checked))

  menuClose.addEventListener('click', () => closeMenu())
  menuQuit.addEventListener('click', () => window.island.quit())

  // --- 线稿波浪（岛内实时音频）：系统音频回环 → Analyser → rAF 画发光线稿 ---
  const waveCanvas = document.getElementById('wave')
  const waveCtx = waveCanvas.getContext('2d')
  const FREQ_BINS = 56 // 对数抽 56 个频点，平滑贝塞尔连线

  let isPlaying = false // render() 更新，驱动波浪状态机
  let waveEnabled = localStorage.getItem('islandWave') !== '0'
  let audioCtx = null
  let analyser = null
  let captureStream = null
  let captureOk = false
  let captureFailed = false
  let freqData = null
  const smooth = new Array(FREQ_BINS).fill(0.05)
  let breatheTime = 0
  let bassEnv = 0 // 贝斯鼓点包络（快攻慢放），驱动光晕脉动 + 波形上抬 + 低频顶高
  let gainEnv = 1 // 自动增益包络：安静的歌把幅度拉上来、吵闹的歌压下去

  // 捕获系统音频：getDisplayMedia 借道屏幕源（主进程回 loopback），视频轨随即停掉
  async function ensureAudioCapture() {
    if (captureOk || captureFailed || !waveEnabled) return
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1 },
        audio: true,
      })
      captureStream = stream
      stream.getVideoTracks().forEach((t) => t.stop())
      audioCtx = new AudioContext()
      const src = audioCtx.createMediaStreamSource(stream)
      analyser = audioCtx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.72
      src.connect(analyser)
      freqData = new Uint8Array(analyser.frequencyBinCount)
      captureOk = true
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
    } catch (e) {
      captureFailed = true // 无用户手势等失败：首次点击时重试
    }
  }

  function stopAudioCapture() {
    captureOk = false
    if (captureStream) {
      captureStream.getTracks().forEach((t) => t.stop())
      captureStream = null
    }
    if (audioCtx) {
      audioCtx.close().catch(() => {})
      audioCtx = null
    }
    analyser = null
    freqData = null
  }

  // canvas 尺寸跟随岛屿实际渲染尺寸（含 zoom、悬停放大）与 dpr；每帧只在实际变化时重设
  let waveW = 0
  let waveH = 0
  function syncWaveSize() {
    const r = islandEl.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const w = Math.round(r.width * dpr)
    const h = Math.round(r.height * dpr)
    if (w === waveW && h === waveH) return
    waveW = w
    waveH = h
    // 只设 canvas 像素分辨率，不改 CSS 尺寸：.wave 已 width/height:100% 跟随岛。
    // 若按 getBoundingClientRect（已含 zoom）再设 style 尺寸，会与父级 zoom 叠加二次缩放，
    // 缩放滑杆调小时波浪会比岛小一圈、不铺满
    waveCanvas.width = w
    waveCanvas.height = h
  }

  // 读当前 --accent（封面主色）作为波浪颜色
  function accentRgb() {
    const p = getComputedStyle(islandEl).getPropertyValue('--accent').trim()
    const m = p.match(/\d+/g)
    return m ? m.map((s) => parseInt(s, 10) || 0) : [80, 84, 90]
  }

  // 波浪主色：--accent 太暗时往白提亮，保证在深色岛背景上看得清跳动。
  // setAccent 只对更暗的封面色兜底，中等偏暗色（酒红/墨绿/深蓝）直接描边会融进背景
  function waveColor() {
    const rgb = accentRgb()
    const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
    if (lum < 0.45) {
      const t = Math.min(1, (0.45 - lum) / 0.45)
      for (let i = 0; i < 3; i++) rgb[i] = Math.round(rgb[i] + (235 - rgb[i]) * t)
    }
    return rgb
  }

  // 二次贝塞尔过中点平滑连线
  function tracePath(pts) {
    const ctx = waveCtx
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2
      const my = (pts[i].y + pts[i + 1].y) / 2
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my)
    }
    const last = pts[pts.length - 1]
    ctx.lineTo(last.x, last.y)
  }

  function drawWave() {
    requestAnimationFrame(drawWave)
    if (!waveEnabled) return
    const ctx = waveCtx
    if (!ctx) return
    syncWaveSize()
    const w = waveW
    const h = waveH
    if (w < 2 || h < 2) return
    const dpr = window.devicePixelRatio || 1
    breatheTime += 1

    // 每帧清空重画，不做尾迹残留：旧像素淡出会糊成一片"蒙雾"，很廉价。
    // 波浪的流畅感靠 smooth[] 指数平滑，不靠残影
    ctx.clearRect(0, 0, w, h)

    // 状态机：播放+已捕获 → 真 FFT；播放但未捕获 → 极淡呼吸；暂停/无会话 → 低平缓呼吸线
    let k = 0.35
    let minV = 0.08
    let maxV = 1
    let breatheMix = 0
    if (isPlaying && analyser) {
      analyser.getByteFrequencyData(freqData)
    } else if (isPlaying) {
      k = 0.12
      minV = 0.05
      maxV = 0.16
      breatheMix = 1
    } else {
      k = 0.08
      minV = 0.05
      maxV = 0.26
      breatheMix = 1
    }
    // 双频呼吸：两个正弦叠加，静止状态也带点不规则"活气"
    const breathe = 0.5 + 0.5 * Math.sin(breatheTime * 0.045 + Math.sin(breatheTime * 0.013) * 2.2)

    // 贴顶收拢态（docked-idle，真实光标在岛外）波浪垂直居中；
    // 悬停弹起成普通岛后与平常一样贴底。
    // 用 .docked-idle 类而非 :hover——点击穿透会冻结 :hover，导致细条里画满幅波浪被裁成一条缝
    const strip = docked && islandEl.classList.contains('docked-idle')
    const baseY = strip ? h * 0.5 : h - 12 * dpr
    // 细条只有 16px 高：振幅占条高 ~50% 才看得出跳动（之前压到 1/4，动起来几乎没感觉）；
    // 靠下面每点 y 钳制在条内，loud 时顶到条上缘也不会溢出去被裁
    const rise = strip ? Math.max(3 * dpr, h * 0.5) : Math.max(16 * dpr, h * 0.3)
    const x0 = 0
    const xStep = w / (FREQ_BINS - 1)

    // 低频能量（前 3 个频点）→ 贝斯包络：快攻慢放
    let bass = 0
    if (analyser) {
      for (let i = 0; i < 3; i++) bass = Math.max(bass, freqData[i] / 255)
    }
    bassEnv += (bass - bassEnv) * (bass > bassEnv ? 0.55 : 0.12)

    const pts = []
    let energy = 0
    for (let i = 0; i < FREQ_BINS; i++) {
      let v
      if (analyser) {
        const bin = 1 + Math.round(Math.pow(200, i / (FREQ_BINS - 1))) // 对数分布 1..200
        v = freqData[Math.min(bin, freqData.length - 1)] / 255
      } else {
        v = 0.5 + 0.5 * Math.sin(breatheTime * 0.03 + i * 0.42)
      }
      // 贝斯段（左侧低频点）额外顶高：鼓点有"冲击感"
      if (analyser && i < FREQ_BINS * 0.18) {
        v = Math.min(1, v + bassEnv * 0.35 * (1 - i / (FREQ_BINS * 0.18)))
      }
      // 暂停/无捕获时用呼吸波驱动；播放时轻微叠加防呆板
      v = v * (1 - breatheMix * 0.65) + breathe * breatheMix * 0.65
      v = minV + v * (maxV - minV)
      smooth[i] += (v - smooth[i]) * k // 指数平滑：弹簧跟随感
      energy += smooth[i]
      pts.push({ x: x0 + i * xStep })
    }
    energy /= FREQ_BINS

    // 自动增益：把平均能量归一化到 0.35 附近，让波浪始终有动感（慢速跟随，防抽风）
    gainEnv += (Math.min(2.2, Math.max(0.6, 0.35 / Math.max(energy, 0.08))) - gainEnv) * 0.05

    // 贝斯上抬量（整条线随鼓点轻跳）+ 幅度微增；细条态去掉上抬
    const lift = strip ? 0 : bassEnv * 5 * dpr
    const ampBoost = 1 + bassEnv * 0.25
    for (let i = 0; i < FREQ_BINS; i++) {
      pts[i].y = baseY - smooth[i] * rise * gainEnv * ampBoost - lift
      // 钳制在画布内：细条态 loud 时波浪顶到条上缘，不会溢出被裁成缝
      pts[i].y = Math.max(dpr * 0.5, Math.min(h - dpr * 0.5, pts[i].y))
    }

    const rgb = waveColor()
    const glow = Math.round(3 + energy * 12) // 紧凑光晕：不再大 blur + 尾迹叠出"蒙雾"

    // 主线：accent 描边 + 紧凑光晕。去掉回波线与尾迹后，不再有"双影/蒙雾"的廉价感
    ctx.save()
    ctx.strokeStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
    ctx.lineWidth = 2 * dpr
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.shadowColor = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.9)`
    ctx.shadowBlur = glow * dpr
    tracePath(pts)
    ctx.stroke()
    ctx.restore()
  }

  // 菜单开关：关闭时停掉捕获流（省资源，也避免系统“正在录制”指示一直挂着）
  const waveCheck = document.getElementById('waveCheck')
  waveCheck.checked = waveEnabled
  islandEl.classList.toggle('wave-off', !waveEnabled)
  waveCheck.addEventListener('change', () => {
    waveEnabled = waveCheck.checked
    localStorage.setItem('islandWave', waveEnabled ? '1' : '0')
    islandEl.classList.toggle('wave-off', !waveEnabled)
    if (waveEnabled) {
      captureFailed = false
      ensureAudioCapture()
    } else {
      stopAudioCapture()
    }
  })

  // 启动：先尝试捕获（可能需要用户手势，失败则首次点击时重试）
  if (waveEnabled) ensureAudioCapture()
  requestAnimationFrame(drawWave)
})()
