// GSMTC 音乐桥接：spawn 一个持久 PowerShell 进程，用行协议收发命令
// 行协议：写入一行命令(get/play/pause/next/prev/toggle)，读回一行 JSON 响应
const { spawn } = require('child_process')
const path = require('path')
const { app } = require('electron')

class GsmtcBridge {
  constructor() {
    this.child = null
    this.buffer = ''
    this.pending = [] // 待响应的 promise 队列（FIFO，与 PowerShell 顺序一致）
    this.started = false
  }

  start() {
    if (this.started) return
    this.started = true

    const scriptPath = app.isPackaged
      ? path.join(process.resourcesPath, 'gsmtc.ps1')
      : path.join(__dirname, 'gsmtc.ps1')
    this.child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    )

    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (d) => this._onData(d))
    this.child.stderr.on('data', (d) => {
      console.error('[gsmtc:stderr]', String(d).trim())
    })
    this.child.on('exit', (code) => {
      console.warn('[gsmtc] 进程退出 code=', code)
      this.started = false
      this.child = null
    })
  }

  _onData(chunk) {
    this.buffer += chunk
    let idx
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (line && this.pending.length) {
        const { resolve } = this.pending.shift()
        let obj = null
        try { obj = JSON.parse(line) } catch (e) { obj = null }
        resolve(obj)
      }
    }
  }

  // 发送命令，返回 Promise<state|null>
  request(cmd) {
    if (!this.child || !this.started) {
      return Promise.resolve(null)
    }
    return new Promise((resolve) => {
      this.pending.push({ resolve })
      this.child.stdin.write(cmd + '\n')
    })
  }

  stop() {
    if (this.child) {
      try { this.child.stdin.write('quit\n') } catch (e) {}
      this.child = null
      this.started = false
    }
  }
}

module.exports = { GsmtcBridge }
