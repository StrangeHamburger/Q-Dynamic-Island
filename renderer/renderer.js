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

  // SVG 图标（比 emoji 干净、不依赖系统字体）
  const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
  const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>'

  function render(state) {
    if (!state || !state.hasSession) {
      titleEl.textContent = '未播放'
      artistEl.textContent = '等待音乐…'
      toggleEl.innerHTML = PLAY_ICON
      setCover(null, null)
      return
    }

    titleEl.textContent = state.title || '未知曲目'
    artistEl.textContent = state.artist || '未知歌手'
    toggleEl.innerHTML = state.status === 'Playing' ? PAUSE_ICON : PLAY_ICON

    setCover(state.cover, state.title)
  }

  let lastCoverSrc = ''

  // 封面直接铺满圆圈；同时取主色给播放键/高光用（--accent）
  function setCover(src, title) {
    if (!src) {
      lastCoverSrc = ''
      coverImg.style.display = 'none'
      coverImg.removeAttribute('src')
      coverEl.style.background = coverColor(title)
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
      coverEl.style.background = coverColor(title)
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

  // 把主色写进 CSS 变量，供播放键等复用（"r,g,b" 字符串）
  function setAccent(rgb) {
    islandEl.style.setProperty('--accent', rgb ? rgb.join(',') : '99,102,241')
  }

  // 简单封面占位配色：同一首歌颜色稳定（无封面时的兜底）
  function coverColor(title) {
    const s = title || 'x'
    let h = 0
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
    const hue = h % 360
    return `linear-gradient(135deg, hsl(${hue},70%,55%), hsl(${(hue + 60) % 360},70%,45%))`
  }

  // 按钮 -> 主进程
  btnPrev.addEventListener('click', () => window.island.musicCommand('prev'))
  toggleEl.addEventListener('click', () => window.island.musicCommand('toggle'))
  btnNext.addEventListener('click', () => window.island.musicCommand('next'))

  // 订阅状态更新
  window.island.onMusicUpdate(render)

  // --- 拖动与固定 ---
  let isPinned = false

  // 固定状态：固定后禁止拖动
  window.island.onPinned((pinned) => {
    isPinned = pinned
    islandEl.classList.toggle('pinned', pinned)
  })

  // 手动拖动：pointer capture 保证快速拖动时鼠标移出窗口也不丢
  let dragging = false
  let dragWinX = 0
  let dragWinY = 0
  let dragStartX = 0
  let dragStartY = 0

  islandEl.addEventListener('pointerdown', (e) => {
    if (isPinned) return
    if (e.target.closest('.btn')) return // 按钮不参与拖动
    dragging = true
    // 无边框窗口：client(0,0) 就是窗口左上角，据此反推窗口当前屏幕坐标
    dragWinX = e.screenX - e.clientX
    dragWinY = e.screenY - e.clientY
    dragStartX = e.screenX
    dragStartY = e.screenY
    islandEl.setPointerCapture(e.pointerId)
  })

  islandEl.addEventListener('pointermove', (e) => {
    if (!dragging) return
    window.island.moveWindow(
      dragWinX + (e.screenX - dragStartX),
      dragWinY + (e.screenY - dragStartY)
    )
  })

  const endDrag = (e) => {
    if (!dragging) return
    dragging = false
    try { islandEl.releasePointerCapture(e.pointerId) } catch (err) {}
  }
  islandEl.addEventListener('pointerup', endDrag)
  islandEl.addEventListener('pointercancel', endDrag)
})()
