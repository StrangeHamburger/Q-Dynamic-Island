// 桌面灵动岛 - 主进程
// P2：接入 GSMTC 音乐控制（汽水音乐等）
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen } = require('electron')
const path = require('path')
const { GsmtcBridge } = require('./music')
const { getCover } = require('./cover')

const SIZE = {
  expanded: { width: 420, height: 92 }, // 窗口实际尺寸（放大态）
}

let mainWindow = null
const music = new GsmtcBridge()
let tray = null
let lastState = null
let lastCover = null // 当前歌的封面 data URI（null = 拉取中/失败）
let lastCoverQuery = '' // 上次拉封面的查询词，避免每轮重复请求
let pinned = false // 是否固定位置（固定后不可拖动）
let islandScale = 1 // 岛屿缩放（0.67~1），由渲染进程设置
let menuOpen = false // 自定义右键菜单是否展开（展开时窗口切成菜单尺寸）

function setPinned(v) {
  pinned = v
  if (mainWindow) {
    mainWindow.webContents.send('island:pinned', v)
  }
}

// 按当前状态调整窗口尺寸：菜单展开用菜单尺寸，否则按岛屿缩放比例。
// 用 setBounds 同时设置尺寸和位置，并钳制在工作区内——避免菜单窗口
// 从屏幕边缘展开时被截断（右键菜单显示一半）
const MENU_SIZE = { width: 232, height: 224 }
function resizeWindow() {
  if (!mainWindow) return
  const w = menuOpen ? MENU_SIZE.width : Math.round(420 * islandScale)
  const h = menuOpen ? MENU_SIZE.height : Math.round(92 * islandScale)
  const b = mainWindow.getBounds()
  const wa = screen.getDisplayMatching(b).workArea
  const x = Math.min(Math.max(b.x, wa.x), wa.x + wa.width - w)
  const y = Math.min(Math.max(b.y, wa.y), wa.y + wa.height - h)
  mainWindow.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h })
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
    ...SIZE.expanded,
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

// 渲染进程发来的控制命令
ipcMain.on('music:command', (event, cmd) => {
  if (['play', 'pause', 'next', 'prev', 'toggle'].includes(cmd)) {
    music.request(cmd).then(onState)
  }
})

// 手动拖动窗口（渲染进程算好目标坐标后发来；钳制在屏幕内，避免拖到边缘出屏）
ipcMain.on('window:move', (event, pos) => {
  if (!mainWindow || pinned || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return
  const display = screen.getDisplayNearestPoint({ x: pos.x, y: pos.y })
  const wa = display.workArea
  const [w, h] = mainWindow.getSize()
  const x = Math.min(Math.max(pos.x, wa.x), wa.x + wa.width - w)
  const y = Math.min(Math.max(pos.y, wa.y), wa.y + wa.height - h)
  mainWindow.setPosition(Math.round(x), Math.round(y))
})

// 自定义右键菜单的窗口尺寸开关
ipcMain.on('window:menu', (event, open) => {
  menuOpen = !!open
  resizeWindow()
})

// 岛屿缩放（渲染进程拖动滑杆时同步窗口尺寸）
ipcMain.on('window:scale', (event, s) => {
  islandScale = Math.min(1, Math.max(0.67, Number(s) || 1))
  resizeWindow()
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
    music.start()
    createTray()
    createWindow()
    startPolling()

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
  if (tray) tray.destroy()
  tray = null
})
