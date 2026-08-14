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

  // 请求移动窗口到屏幕坐标 (x, y)
  moveWindow(x, y) {
    ipcRenderer.send('window:move', { x, y })
  },
})
