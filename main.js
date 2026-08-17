// 桌面灵动岛 - 主进程
// P2：接入 GSMTC 音乐控制（汽水音乐等）
const { app, BrowserWindow, desktopCapturer, ipcMain, Menu, session, Tray, nativeImage, screen } = require('electron')
const path = require('path')
const { GsmtcBridge } = require('./music')
const { getCover } = require('./cover')

const ISLAND = {
  expanded: { width: 420, height: 92 }, // 岛屿放大态尺寸（悬停）
  collapsed: { width: 280, height: 56 }, // 岛屿收起态尺寸
}
const GLOW_PAD = 24 // 岛四周透明余量（固定 DIP，不随缩放）：窗口比岛大一圈，让发光/阴影有空间渲染不被窗口硬切

let mainWindow = null
const music = new GsmtcBridge()
let tray = null
let lastState = null
let lastCover = null // 当前歌的封面 data URI（null = 拉取中/失败）
let lastCoverQuery = '' // 上次拉封面的查询词，避免每轮重复请求
let pinned = false // 是否固定位置（固定后不可拖动）
let islandScale = 1 // 岛屿缩放（0.67~1），由渲染进程设置
let menuOpen = false // 自定义右键菜单是否展开（展开时窗口切成菜单尺寸）

// --- 锚定模式：悬停放大纯由渲染进程 CSS 承担，窗口全程不移动 → 无跨进程动画，丝滑不卡顿 ---
// 岛在窗口内三种锚法（四周各留 GLOW_PAD 余量），决定悬停放大方向：
//   left   left:pad             → 向右长（窗口 x = 岛左缘 - pad）
//   center left:50% 左移半宽    → 两边对称长（窗口 x = 岛中心 - 窗口宽/2）
//   right  right:pad            → 向左长（窗口 x = 屏幕右缘 - 窗口宽）
// 窗口始终「放大态岛 + 四周余量」尺寸（菜单态例外）；收起态 / 贴顶收拢态都是岛在窗口内的纯 CSS 形态
let anchorMode = 'center'
let dockedTop = false // 岛已收拢到上边缘（细条波浪态；纯 CSS，窗口不缩尺寸）

// 窗口几何：窗口 = 岛屿放大态 * 缩放 + 四周 GLOW_PAD 余量。岛嵌在窗口内、四周留透明余量，
// 让 CSS 发光/阴影（封面、按钮）与画布律动发光能超出岛本体渲染，不被窗口硬切。
function winSize() {
  const pad = GLOW_PAD
  return {
    pad,
    w: Math.round(ISLAND.expanded.width * islandScale) + pad * 2,
    h: Math.round(ISLAND.expanded.height * islandScale) + pad * 2,
    islandW: Math.round(ISLAND.expanded.width * islandScale),
    islandH: Math.round(ISLAND.expanded.height * islandScale),
    collapsedW: Math.round(ISLAND.collapsed.width * islandScale),
    collapsedH: Math.round(ISLAND.collapsed.height * islandScale),
  }
}

// 岛在窗口内的左缘偏移（岛左缘到窗口左缘的距离，含四周余量）：
// 左锚 pad；中锚 pad+(放大宽-收起宽)/2（岛居中）；右锚 pad+放大宽-收起宽（岛贴右）
function islandOffset() {
  const s = winSize()
  const half = Math.round((s.islandW - s.collapsedW) / 2)
  return s.pad + (anchorMode === 'right' ? half * 2 : anchorMode === 'center' ? half : 0)
}

function setPinned(v) {
  pinned = v
  if (mainWindow) {
    mainWindow.webContents.send('island:pinned', v)
  }
}

// 窗口尺寸：始终 expanded（岛在窗口内做形态切换，窗口不参与动画）。
// 用 setBounds 同时设置尺寸和位置，并钳制在工作区内。
// 右键菜单是独立的透明置顶小窗口（见 createMenuWindow）——岛窗口尺寸全程不变，
// 开/关菜单不再有任何窗口 resize → 消除菜单关闭时的 OS 合成层闪烁
function resizeWindow() {
  if (!mainWindow) return
  const s = winSize()
  const b = mainWindow.getBounds()
  const wa = screen.getDisplayMatching(b).workArea
  // 缩放按锚点保持岛的位置：左锚保左缘、中锚保窗口中心（岛居中不动）、右锚保右缘。
  // 之前直接 clamp(b.x) 保留的是左缘——中锚时窗口宽度一变，岛就带着跳
  let x
  if (anchorMode === 'right') x = b.x + b.width - s.w
  else if (anchorMode === 'center') x = b.x + (b.width - s.w) / 2
  else x = b.x
  x = Math.min(Math.max(x, wa.x), wa.x + wa.width - s.w)
  const y = dockedTop ? wa.y - s.pad : Math.min(Math.max(b.y, wa.y), wa.y + wa.height - s.h)
  mainWindow.setBounds({ x: Math.round(x), y: Math.round(y), width: s.w, height: s.h })
}

// --- 独立菜单窗口（透明、无边框、置顶、不进任务栏） ---
// 菜单常驻一个小 BrowserWindow，随右键在光标处弹出、失焦即收起。
// 控制项（大小/背景不透明/固定/波浪/退出）经 IPC 与岛窗口共享状态，
// 与主岛窗口同 file:// origin → localStorage 互通，菜单窗口直接读写持久化值。
// 菜单窗口尺寸不参与岛窗口动画，是独立的合成层，开合对岛窗口零影响
const MENU_WINDOW_SIZE = { width: 218, height: 240 } // 初始高度，加载后按内容自适应
let menuWindow = null
let pendingMenuPos = null // 首次加载未完成时暂存弹出位置，menu:ready 后弹出

function createMenuWindow() {
  if (menuWindow && !menuWindow.isDestroyed()) return menuWindow
  menuWindow = new BrowserWindow({
    width: MENU_WINDOW_SIZE.width,
    height: MENU_WINDOW_SIZE.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  menuWindow.setAlwaysOnTop(true, 'screen-saver')
  menuWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  menuWindow.loadFile(path.join(__dirname, 'renderer', 'menu.html'))
  menuWindow.on('blur', () => hideMenuWindow()) // 点岛/点桌面/切应用 → 收起菜单
  menuWindow.on('closed', () => { menuWindow = null })
  return menuWindow
}

function positionAndShowMenu(w, x, y) {
  pendingMenuPos = null
  const wa = screen.getDisplayNearestPoint({ x, y }).workArea
  // 菜单右上角对齐光标，钳制在工作区内（含菜单自身尺寸）
  const mx = Math.min(Math.max(x + 4, wa.x + 4), wa.x + wa.width - MENU_WINDOW_SIZE.width - 4)
  const my = Math.min(Math.max(y + 4, wa.y + 4), wa.y + wa.height - MENU_WINDOW_SIZE.height - 4)
  w.setPosition(Math.round(mx), Math.round(my))
  w.show()
  w.focus()
  menuOpen = true
  if (mainWindow) mainWindow.webContents.send('island:menuOpen', true)
  w.webContents.send('island:pinned', pinned) // 菜单窗口初始化固定勾选
}

function showMenuWindow(x, y) {
  const w = createMenuWindow()
  if (w.webContents.isLoading()) {
    pendingMenuPos = { x, y } // 首次加载：等 menu:size / menu:ready 定好尺寸再弹出
    return
  }
  positionAndShowMenu(w, x, y)
}

function hideMenuWindow() {
  pendingMenuPos = null
  if (menuWindow && !menuWindow.isDestroyed()) menuWindow.hide()
  if (menuOpen) {
    menuOpen = false
    if (mainWindow) mainWindow.webContents.send('island:menuOpen', false)
  }
}

// 系统托盘：最小化后从托盘点回来；右键退出
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'))
  tray = new Tray(icon)
  tray.setToolTip('灵动岛')

  const show = () => {
    if (!mainWindow) return
    mainWindow.show()
    mainWindow.focus()
  }

  tray.on('click', show)
  tray.on('right-click', () => {
    tray.popUpContextMenu(Menu.buildFromTemplate([
      { label: '显示', click: show },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]))
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: ISLAND.expanded.width + GLOW_PAD * 2,
    height: ISLAND.expanded.height + GLOW_PAD * 2,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  // 最小化时收进托盘，而不是凭空消失（点托盘图标恢复）
  mainWindow.on('minimize', (e) => {
    e.preventDefault()
    mainWindow.hide()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// 音乐状态变化时推给渲染进程（可附带封面 data URI）
function pushState(state) {
  if (!mainWindow || !state) return
  const key = JSON.stringify(state)
  if (key === lastState) return
  lastState = key
  mainWindow.webContents.send('music:update', state)
}

// 状态里带标题时，异步拉封面并补发一帧（仅标题/歌手变化时拉取）
function attachCover(state) {
  const title = state && state.title
  if (!title) {
    lastCover = null
    lastCoverQuery = ''
    return state
  }
  const query = [title, state.artist].filter(Boolean).join(' ').trim()
  // GSMTC 自带封面（播放器同款，汽水音乐等会经系统媒体会话暴露缩略图）优先直接用——
  // 平台独有歌/Remix 在线搜不到，用它保证封面与播放器完全一致。
  // 例外：切歌后（query 已变）封面字节仍与上一首完全一致 → 疑为 Windows 过期缩略图，
  // 不信任，走在线搜索兜底（gsmtc.ps1 已做同款判定置空，这里是第二道防线）
  const staleSame = query !== lastCoverQuery && typeof state.cover === 'string' && state.cover === lastCover
  if (!staleSame && typeof state.cover === 'string' && state.cover.length > 20) {
    lastCover = state.cover
    lastCoverQuery = query
    return state
  }
  // 无系统封面 → 在线搜索（仅标题/歌手变化时拉取）
  if (query !== lastCoverQuery) {
    lastCoverQuery = query
    lastCover = null // 新歌，封面待拉取
    getCover(title, state.artist).then((cover) => {
      // 拉取结果只在「仍是这首歌」时生效
      const q = [title, state.artist].filter(Boolean).join(' ').trim()
      if (q !== lastCoverQuery) return
      lastCover = cover // cover 可能为 null（失败），同样记录避免反复请求
      if (cover && mainWindow) {
        const next = { ...state, cover }
        lastState = JSON.stringify(next)
        mainWindow.webContents.send('music:update', next)
      }
    })
  }
  // 已拿到封面就同步附着，保证去重键稳定，避免下一轮把封面冲掉
  if (lastCover) state.cover = lastCover
  return state
}

// 统一入口：拿到状态 -> 附着封面 -> 推送
function onState(state) {
  if (!state) return
  attachCover(state)
  pushState(state)
}

// 轮询音乐状态（1s 一次，够用且不占资源）
function startPolling() {
  const tick = () => music.request('get').then(onState)
  tick()
  setInterval(tick, 1000)
}

// 光标离开窗口看门狗：点击穿透（setIgnoreMouseEvents）下浏览器收不到 mouseleave，
// 岛的 :hover 会卡在展开态收不回来。主进程轮询光标位置，光标在窗口外时通知渲染进程兜底收拢。
// 同时把光标在窗口内的坐标回传给渲染进程（DIP，等同 client 坐标），供点击穿透自纠偏——
// 穿透期间 mousemove 会丢/滞后，导致命中判断卡旧态、悬停放大后左右残留透明墙。
function startCursorWatchdog() {
  setInterval(() => {
    if (!mainWindow || menuOpen) return
    const b = mainWindow.getBounds()
    const c = screen.getCursorScreenPoint()
    mainWindow.webContents.send('island:cursor', { x: c.x - b.x, y: c.y - b.y })
    if (c.x < b.x || c.y < b.y || c.x > b.x + b.width || c.y > b.y + b.height) {
      mainWindow.webContents.send('island:forceCollapse')
    }
  }, 60)
}

// 渲染进程发来的控制命令
ipcMain.on('music:command', (event, cmd) => {
  if (['play', 'pause', 'next', 'prev', 'toggle'].includes(cmd)) {
    music.request(cmd).then(onState)
  }
})

// 手动拖动窗口（渲染进程算好目标坐标后发来；按岛屿实际尺寸钳制岛在屏幕内，
// 窗口比岛大，允许透明部分悬出屏幕）
ipcMain.on('window:move', (event, pos) => {
  if (!mainWindow || pinned || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return
  if (dockedTop) { // 拖起收拢的岛 = 解除收拢（渲染进程收到 docked false 后切回普通岛形态）
    dockedTop = false
    mainWindow.webContents.send('island:docked', false)
  }
  const display = screen.getDisplayNearestPoint({ x: pos.x, y: pos.y })
  const wa = display.workArea
  const s = winSize()
  const w = Number.isFinite(pos.w) && pos.w > 0 ? pos.w : s.collapsedW
  const h = Number.isFinite(pos.h) && pos.h > 0 ? pos.h : s.collapsedH
  // pos.x/y 是窗口左上角屏幕坐标（渲染进程拖拽上报）；岛左缘 = 窗口x + islandOffset（含余量），岛顶 = 窗口y + pad
  const islandLeft = Math.min(Math.max(pos.x + islandOffset(), wa.x), wa.x + wa.width - w)
  const y = Math.min(Math.max(pos.y + s.pad, wa.y), wa.y + wa.height - h)
  mainWindow.setPosition(Math.round(islandLeft - islandOffset()), Math.round(y - s.pad))
})

// 拖拽结束：定锚点（岛中心落在屏幕哪一段 → 哪种放大方向），并判断是否收拢到上边缘。
// 窗口始终 expanded，岛上 CSS 形态随 body.docked / 锚定类切换，不再搬窗口尺寸
ipcMain.on('window:dragEnd', (event, pos) => {
  if (!mainWindow || pinned || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return
  const b = mainWindow.getBounds()
  const wa = screen.getDisplayMatching(b).workArea
  const right = wa.x + wa.width
  const s = winSize()

  // 岛顶贴近屏幕上缘 → 收拢成边缘波浪（岛顶 = 窗口y + pad，故以窗口坐标换算）
  const docked = pos.y + s.pad <= wa.y + 2
  dockedTop = docked

  // 松手时岛左缘 = 窗口 x + islandOffset（含余量 + 锚点），据此算岛中心 → 定新锚点
  const islandLeft = pos.x + islandOffset()
  const islandCenter = islandLeft + s.collapsedW / 2
  let wx, next
  if (islandCenter + s.islandW / 2 > right - s.pad) {
    next = 'right'
    wx = right - s.w // 窗口贴右，岛右缘距屏幕右缘留 pad，放大向左
  } else if (islandCenter - s.islandW / 2 < wa.x + s.pad) {
    next = 'left'
    wx = islandLeft - s.pad // 窗口贴左（岛左缘 = 窗口x + pad），放大向右
  } else {
    next = 'center'
    wx = islandCenter - s.w / 2 // 岛居中，悬停两边对称长
  }
  anchorMode = next
  wx = Math.min(Math.max(wx, wa.x), wa.x + wa.width - s.w)
  const wy = docked ? wa.y - s.pad : Math.min(Math.max(pos.y, wa.y), wa.y + wa.height - s.h)
  mainWindow.setBounds({ x: Math.round(wx), y: Math.round(wy), width: s.w, height: s.h })
  mainWindow.webContents.send('island:docked', docked)
  mainWindow.webContents.send('island:anchorRight', next === 'right')
  mainWindow.webContents.send('island:anchorCenter', next === 'center')
})

// 悬停放大：纯渲染进程 CSS（锚点类由 dragEnd / scale 下发），主进程无需处理

// 右键菜单：弹出/收起独立菜单窗口（岛窗口尺寸全程不变）
ipcMain.on('window:menu', (event, msg) => {
  if (!msg) return
  if (msg.open) {
    // msg.x/y 是岛窗口内坐标（右键位置），换算成屏幕坐标后弹出菜单窗口
    const b = mainWindow ? mainWindow.getBounds() : { x: 0, y: 0 }
    showMenuWindow(b.x + (Number.isFinite(msg.x) ? msg.x : 0), b.y + (Number.isFinite(msg.y) ? msg.y : 0))
  } else {
    hideMenuWindow()
  }
})

// 菜单窗口内容尺寸自适应（menu.js 加载后上报面板实际高度）
ipcMain.on('menu:size', (event, h) => {
  if (!menuWindow || menuWindow.isDestroyed()) return
  const hh = Math.min(Math.max(120, Math.round(Number(h) || 240)), 600)
  const b = menuWindow.getBounds()
  menuWindow.setBounds({ x: b.x, y: b.y, width: MENU_WINDOW_SIZE.width, height: hh })
})

// 菜单窗口加载完成（menu.js 最后上报）：首次打开时定好尺寸后弹出
ipcMain.on('menu:ready', () => {
  if (menuWindow && !menuWindow.isDestroyed() && pendingMenuPos) {
    positionAndShowMenu(menuWindow, pendingMenuPos.x, pendingMenuPos.y)
  }
})

// 背景不透明度（菜单窗口滑杆 → 回传岛窗口应用 CSS 变量）
ipcMain.on('window:bgOpacity', (event, v) => {
  if (mainWindow) mainWindow.webContents.send('island:bgOpacity', Number(v))
})

// 波浪开关（菜单窗口勾选 → 回传岛窗口启停捕获流）
// 动效形态切换（菜单窗口 → 回传岛窗口，岛窗口按形态启停捕获流 + 切换绘制器）
ipcMain.on('window:style', (event, v) => {
  if (mainWindow) mainWindow.webContents.send('island:style', String(v))
})

// 点击穿透：透明窗口区域不拦截鼠标（渲染进程按光标是否落在岛上动态切换；
// forward 让穿透期间仍能收到 mousemove，据此判断光标何时回到岛上）
ipcMain.on('window:interactive', (event, v) => {
  if (!mainWindow) return
  mainWindow.setIgnoreMouseEvents(!v, { forward: true })
})

// 岛屿缩放（菜单窗口滑杆触发；岛窗口随缩放实时 setBounds，预览即时生效）。
// 中锚时保持岛中心不动；贴右锚贴屏幕右缘；左锚保持窗口 x
ipcMain.on('window:scale', (event, s) => {
  islandScale = Math.min(1, Math.max(0.67, Number(s) || 1))
  if (!mainWindow) return
  resizeWindow()
  // 回传岛窗口应用 CSS zoom（菜单窗口是值源头，这里只做单向同步，避免回环）
  mainWindow.webContents.send('island:scale', islandScale)
})

// 固定位置（渲染进程菜单触发）
ipcMain.on('island:setPinned', (event, v) => setPinned(!!v))

// 退出（渲染进程菜单触发）
ipcMain.on('app:quit', () => app.quit())

// 单实例锁：重复 npm start 时只唤醒已有窗口，不再开第二个
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show() // 可能被最小化收进托盘（hide），直接 show 恢复
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    // 系统音频回环捕获：渲染进程 getDisplayMedia 请求时，回「屏幕源 + loopback 音频」。
    // WASAPI 回环截取全部系统音频（汽水音乐走共享模式，可捕获）；视频轨随即被渲染进程停掉
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] })
        .then((sources) => callback({ video: sources[0] || { id: '', name: '' }, audio: 'loopback' }))
        .catch(() => callback({ audio: 'loopback' }))
    })
    music.start()
    createTray()
    createWindow()
    startPolling()
    startCursorWatchdog()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  music.stop()
  if (menuWindow) { menuWindow.destroy(); menuWindow = null }
  if (tray) tray.destroy()
  tray = null
})
