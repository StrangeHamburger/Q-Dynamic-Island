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

  // 发送音乐控制命令
  musicCommand(cmd) {
    ipcRenderer.send('music:command', cmd)
  },

  // 请求移动窗口到屏幕坐标 (x, y)；w/h 为岛屿实际渲染尺寸，主进程按它钳制
  moveWindow(x, y, w, h) {
    ipcRenderer.send('window:move', { x, y, w, h })
  },

  // 自定义右键菜单开关（主进程据此切窗口尺寸）
  setMenuOpen(open) {
    ipcRenderer.send('window:menu', !!open)
  },

  // 岛屿缩放比例（主进程据此调整窗口大小）
  setScale(s) {
    ipcRenderer.send('window:scale', s)
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
