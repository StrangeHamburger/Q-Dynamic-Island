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

  // 按钮 -> 主进程
  btnPrev.addEventListener('click', () => window.island.musicCommand('prev'))
  toggleEl.addEventListener('click', () => window.island.musicCommand('toggle'))
  btnNext.addEventListener('click', () => window.island.musicCommand('next'))
  // 点击封面 = 播放/暂停
  coverEl.addEventListener('click', () => window.island.musicCommand('toggle'))

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

  // 手动拖动：pointer capture 保证快速拖动时鼠标移出窗口也不丢
  let dragging = false
  let dragWinX = 0
  let dragWinY = 0
  let dragStartX = 0
  let dragStartY = 0
  let dragW = 0
  let dragH = 0

  islandEl.addEventListener('pointerdown', (e) => {
    if (isPinned) return
    if (e.target.closest('.btn') || e.target.closest('.cover')) return // 按钮/封面不参与拖动
    dragging = true
    islandEl.classList.add('dragging') // 拖动时不悬停放大
    // 无边框窗口：client(0,0) 就是窗口左上角，据此反推窗口当前屏幕坐标
    dragWinX = e.screenX - e.clientX
    dragWinY = e.screenY - e.clientY
    dragStartX = e.screenX
    dragStartY = e.screenY
    // 记录岛屿实际渲染尺寸（含 zoom），拖到屏幕边缘时按它钳制而不是按更大的窗口
    const r = islandEl.getBoundingClientRect()
    dragW = r.width
    dragH = r.height
    islandEl.setPointerCapture(e.pointerId)
  })

  islandEl.addEventListener('pointermove', (e) => {
    if (!dragging) return
    window.island.moveWindow(
      dragWinX + (e.screenX - dragStartX),
      dragWinY + (e.screenY - dragStartY),
      dragW,
      dragH
    )
  })

  const endDrag = (e) => {
    if (!dragging) return
    dragging = false
    islandEl.classList.remove('dragging')
    try { islandEl.releasePointerCapture(e.pointerId) } catch (err) {}
  }
  islandEl.addEventListener('pointerup', endDrag)
  islandEl.addEventListener('pointercancel', endDrag)

  // --- 大小缩放（CSS zoom + 窗口同步 + localStorage 持久化） ---
  const MIN_SCALE = 0.67
  let scale = parseFloat(localStorage.getItem('islandScale'))
  if (!(scale >= MIN_SCALE && scale <= 1)) scale = 1

  function applyScale(s) {
    scale = Math.min(1, Math.max(MIN_SCALE, s))
    islandEl.style.zoom = String(scale)
    // 缩得比较小时进入紧凑模式：隐藏歌名/歌手
    islandEl.classList.toggle('compact', scale <= 0.74)
    scaleSlider.value = scale
    scaleValue.textContent = Math.round(scale * 100) + '%'
    localStorage.setItem('islandScale', String(scale))
    window.island.setScale(scale)
  }
  applyScale(scale)

  // --- 自定义右键菜单（黑色，替代原生菜单） ---
  // 菜单窗口尺寸（与 main.js 的 MENU_SIZE 一致）
  const MENU_W = 300
  const MENU_H = 240

  let lastMenuX = 0
  let lastMenuY = 0
  let pendingMenuShow = false

  function showMenu() {
    pendingMenuShow = false
    menuEl.hidden = false
    // 菜单在岛屿下方（y≥72）展开，并钳制在窗口内
    menuEl.style.left = Math.min(Math.max(8, lastMenuX), MENU_W - menuEl.offsetWidth - 8) + 'px'
    menuEl.style.top = Math.min(Math.max(72, lastMenuY), MENU_H - menuEl.offsetHeight - 8) + 'px'
  }

  // 窗口切到菜单尺寸后再摆放/显示菜单：否则窗口还是岛屿尺寸时，
  // 菜单会先被旧窗口裁掉（只露出一半），等 resize 完成才补全
  function maybeShowMenu() {
    if (!pendingMenuShow) return
    if (window.innerWidth !== MENU_W || window.innerHeight !== MENU_H) return
    showMenu()
  }
  window.addEventListener('resize', maybeShowMenu)

  function openMenu() {
    pinCheck.checked = isPinned
    document.body.classList.add('menu-open')
    pendingMenuShow = true
    window.island.setMenuOpen(true)
    maybeShowMenu()
    // 兜底：万一 resize 事件没触发，也强制显示
    setTimeout(() => {
      if (pendingMenuShow) showMenu()
    }, 500)
  }

  function closeMenu() {
    pendingMenuShow = false
    menuEl.hidden = true
    document.body.classList.remove('menu-open')
    window.island.setMenuOpen(false)
  }

  window.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    if (!menuEl.hidden) closeMenu()
    else {
      lastMenuX = e.clientX
      lastMenuY = e.clientY
      openMenu()
    }
  })

  // 点击菜单外部关闭（滑杆/勾选都在菜单内，不受影响）
  document.addEventListener('click', (e) => {
    if (!menuEl.hidden && !e.target.closest('.menu')) closeMenu()
  })

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menuEl.hidden) closeMenu()
  })

  scaleSlider.addEventListener('input', () => applyScale(parseFloat(scaleSlider.value)))

  pinCheck.addEventListener('change', () => window.island.setPinned(pinCheck.checked))

  menuClose.addEventListener('click', () => closeMenu())
  menuQuit.addEventListener('click', () => window.island.quit())
})()
