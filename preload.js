// 预加载脚本：暴露音乐相关 API 给渲染进程
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('island', {
  version: '0.2.0',

  // 订阅音乐状态更新
  onMusicUpdate(callback) {
    ipcRenderer.on('music:update', (event, state) => callback(state))
  },

  // 订阅固定状态变化
  onPinned(callback) {
    ipcRenderer.on('island:pinned', (event, v) => callback(v))
  },

  // 订阅右缘锚定状态（贴右时悬停向左放大）
  onAnchorRight(callback) {
    ipcRenderer.on('island:anchorRight', (event, v) => callback(v))
  },

  // 订阅中间对称放大状态（岛中心不动、两边对称长）
  onAnchorCenter(callback) {
    ipcRenderer.on('island:anchorCenter', (event, v) => callback(v))
  },

  // 订阅收拢态（拖到上边缘收成细条波浪；悬停弹起/移开收回）
  onDocked(callback) {
    ipcRenderer.on('island:docked', (event, v) => callback(!!v))
  },

  // 订阅「光标已离开窗口」（主进程看门狗）：点击穿透下 :hover 可能卡住，据此兜底收拢
  onForceCollapse(callback) {
    ipcRenderer.on('island:forceCollapse', () => callback())
  },

  // 发送音乐控制命令
  musicCommand(cmd) {
    ipcRenderer.send('music:command', cmd)
  },

  // 请求移动窗口到屏幕坐标 (x, y)；w/h 为岛屿实际渲染尺寸，主进程按它钳制
  moveWindow(x, y, w, h) {
    ipcRenderer.send('window:move', { x, y, w, h })
  },

  // 拖拽结束（松手）：主进程据此判断是否拖到上边缘 → 收拢成边缘波浪
  dragEnd(x, y) {
    ipcRenderer.send('window:dragEnd', { x, y })
  },

  // 右键菜单：open + 岛窗口内坐标 (x, y)（主进程换算屏幕坐标弹菜单窗口；open=false 时收起）
  setMenuOpen(open, x, y) {
    ipcRenderer.send('window:menu', {
      open: !!open,
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
    })
  },

  // 背景不透明度（菜单窗口 → 主进程 → 岛窗口）
  setBgOpacity(v) {
    ipcRenderer.send('window:bgOpacity', v)
  },

  // 波浪开关（菜单窗口 → 主进程 → 岛窗口）
  // 动效形态（菜单窗口 → 主进程 → 岛窗口）：none/wave/bars/ripple/breathe/sweep
  setStyle(v) {
    ipcRenderer.send('window:style', String(v))
  },

  // 外观主题（菜单窗口 → 主进程 → 岛窗口）：default/ribbon
  setTheme(t) {
    ipcRenderer.send('window:theme', String(t))
  },

  // 菜单窗口内容尺寸自适应上报
  setMenuSize(h) {
    ipcRenderer.send('menu:size', h)
  },

  // 菜单窗口加载完成（主进程据此首次弹出）
  menuReady() {
    ipcRenderer.send('menu:ready')
  },

  // 订阅缩放回传（菜单窗口改 scale → 岛窗口应用 CSS zoom）
  onScale(callback) {
    ipcRenderer.on('island:scale', (event, v) => callback(v))
  },

  // 订阅背景不透明度回传
  onBgOpacity(callback) {
    ipcRenderer.on('island:bgOpacity', (event, v) => callback(v))
  },

  // 订阅波浪开关回传
  // 订阅动效形态回传
  onStyle(callback) {
    ipcRenderer.on('island:style', (event, v) => callback(String(v)))
  },

  // 订阅外观主题回传
  onTheme(callback) {
    ipcRenderer.on('island:theme', (event, v) => callback(String(v)))
  },

  // 订阅菜单开合状态（岛窗口据此在菜单期间保持可交互）
  onMenuOpen(callback) {
    ipcRenderer.on('island:menuOpen', (event, v) => callback(!!v))
  },

  // 岛屿缩放比例（主进程据此调整窗口大小）
  setScale(s) {
    ipcRenderer.send('window:scale', s)
  },

  // 点击穿透开关：false 时透明窗口区域不拦截鼠标（消除「虚拟墙」）
  setInteractive(v) {
    ipcRenderer.send('window:interactive', !!v)
  },

  // 固定 / 取消固定
  setPinned(v) {
    ipcRenderer.send('island:setPinned', !!v)
  },

  // 退出应用
  quit() {
    ipcRenderer.send('app:quit')
  },
})
