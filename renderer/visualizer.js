// 岛内律动可视化：系统音频回环 → Analyser → 多形态绘制（wave/bars/ripple/sweep）。
// 原 renderer.js 的波浪绘制迁移至此并扩展为四形态；renderer.js 通过 window.Visualizer 驱动。
(function () {
  const STYLES = ['none', 'wave', 'bars', 'ripple', 'sweep']
  let style = localStorage.getItem('islandStyle')
  if (!STYLES.includes(style)) style = 'wave'
  document.body.classList.toggle('style-bars', style === 'bars') // 文字遮罩仅柱状形态生效

  // 外观主题（与律动独立）：default 默认 / ribbon 黑色背景 + 封面三色流动丝带
  const THEMES = ['default', 'ribbon']
  let theme = localStorage.getItem('islandTheme')
  if (!THEMES.includes(theme)) theme = 'default'
  document.body.classList.toggle('theme-ribbon', theme === 'ribbon')

  let islandEl = null
  let coverEl = null
  const canvas = document.getElementById('wave')
  const ctx = canvas.getContext('2d')

  const FREQ_BINS = 56 // 对数抽 56 个频点，平滑贝塞尔连线

  let playing = false // 由 renderer 的 setPlaying 更新，驱动状态机
  let audioCtx = null
  let analyser = null
  let captureStream = null
  let captureOk = false
  let captureFailed = false
  let freqData = null
  const smooth = new Array(FREQ_BINS).fill(0.05)
  let barPhase = null // 柱状：每根柱子的随机相位（让跳动不整齐）
  let breatheTime = 0
  let bassEnv = 0 // 贝斯鼓点包络（快攻慢放）
  let gainEnv = 1 // 自动增益包络

  // 节拍检测（去趋势脉冲）：驱动各形态的节拍感 + 小球律动
  let slowBass = 0
  let beatPeak = 0
  let normBeat = 0

  let waveW = 0
  let waveH = 0

  // 捕获系统音频：getDisplayMedia 借道屏幕源（主进程回 loopback），视频轨随即停掉
  async function ensureAudioCapture() {
    if (captureOk || captureFailed || style === 'none') return
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
  function syncWaveSize() {
    if (!islandEl) return
    const r = islandEl.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const w = Math.round(r.width * dpr)
    const h = Math.round(r.height * dpr)
    if (w === waveW && h === waveH) return
    waveW = w
    waveH = h
    canvas.width = w
    canvas.height = h
  }

  // 读当前 --accent（封面主色）作为律动颜色
  function accentRgb() {
    const p = getComputedStyle(islandEl).getPropertyValue('--accent').trim()
    const m = p.match(/\d+/g)
    return m ? m.map((s) => parseInt(s, 10) || 0) : [80, 84, 90]
  }

  // 律动主色：--accent 太暗时往白提亮，保证在深色岛背景上看得清
  function waveColor() {
    const rgb = accentRgb()
    const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
    if (lum < 0.45) {
      const t = Math.min(1, (0.45 - lum) / 0.45)
      for (let i = 0; i < 3; i++) rgb[i] = Math.round(rgb[i] + (235 - rgb[i]) * t)
    }
    return rgb
  }

  // 读封面提取的 3 色（--accent/--accent2/--accent3），供流动色带配色
  function accentColors() {
    const cs = getComputedStyle(islandEl)
    const read = (name, fb) => {
      const p = cs.getPropertyValue(name).trim()
      const m = p.match(/\d+/g)
      return m && m.length >= 3 ? m.slice(0, 3).map((s) => parseInt(s, 10) || 0) : fb
    }
    const c1 = read('--accent', [80, 84, 90])
    const c2 = read('--accent2', c1)
    const c3 = read('--accent3', c2)
    return [c1, c2, c3]
  }

  // 二次贝塞尔过中点平滑连线
  function tracePath(pts) {
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

  // 每帧共享更新：读频谱 → 更新 smooth/贝斯/增益/节拍
  function updateShared() {
    breatheTime += 1
    let bass = 0
    if (analyser) {
      analyser.getByteFrequencyData(freqData)
      for (let i = 0; i < 3; i++) bass = Math.max(bass, freqData[i] / 255)
    }
    bassEnv += (bass - bassEnv) * (bass > bassEnv ? 0.55 : 0.12)
    slowBass += (bassEnv - slowBass) * 0.08
    // 去趋势节拍脉冲：低频能量超过慢速基线的那部分
    const beat = Math.max(0, bassEnv - slowBass)
    beatPeak = Math.max(beatPeak * 0.95, beat)
    normBeat = beatPeak > 0.01 ? Math.min(1, beat / (beatPeak + 0.05)) : 0
  }

  // 状态机：返回 { k, minV, maxV, breatheMix, breathe, strip }
  function waveState(w, h, dpr) {
    let k = 0.35
    let minV = 0.08
    let maxV = 1
    let breatheMix = 0
    if (playing && analyser) {
      // 真 FFT
    } else if (playing) {
      k = 0.12; minV = 0.05; maxV = 0.16; breatheMix = 1
    } else {
      k = 0.08; minV = 0.05; maxV = 0.26; breatheMix = 1
    }
    // 双频呼吸：两个正弦叠加，静止状态也带点不规则「活气」
    const breathe = 0.5 + 0.5 * Math.sin(breatheTime * 0.045 + Math.sin(breatheTime * 0.013) * 2.2)
    const docked = document.body.classList.contains('docked')
    const strip = docked && islandEl.classList.contains('docked-idle')
    const baseY = strip ? h * 0.5 : h - Math.max(6 * dpr, h * 0.16)
    const rise = strip ? Math.max(3 * dpr, h * 0.5) : Math.max(16 * dpr, h * 0.3)
    return { k, minV, maxV, breatheMix, breathe, strip, baseY, rise }
  }

  // 计算各频点平滑后的幅度（供 wave 与 bars 共用）
  function spectrumValues(k, minV, maxV, breatheMix, breathe) {
    const vals = new Array(FREQ_BINS)
    let energy = 0
    for (let i = 0; i < FREQ_BINS; i++) {
      let v
      if (analyser) {
        const bin = 1 + Math.round(Math.pow(200, i / (FREQ_BINS - 1))) // 对数分布 1..200
        v = freqData[Math.min(bin, freqData.length - 1)] / 255
      } else {
        v = 0.5 + 0.5 * Math.sin(breatheTime * 0.03 + i * 0.42)
      }
      if (analyser && i < FREQ_BINS * 0.18) {
        v = Math.min(1, v + bassEnv * 0.35 * (1 - i / (FREQ_BINS * 0.18)))
      }
      v = v * (1 - breatheMix * 0.65) + breathe * breatheMix * 0.65
      v = minV + v * (maxV - minV)
      smooth[i] += (v - smooth[i]) * k
      energy += smooth[i]
      vals[i] = smooth[i]
    }
    energy /= FREQ_BINS
    gainEnv += (Math.min(2.2, Math.max(0.6, 0.35 / Math.max(energy, 0.08))) - gainEnv) * 0.05
    return { vals, energy }
  }

  // 线稿波浪：发丝级发光线稿，随音乐起伏
  function drawWave(w, h, dpr) {
    const st = waveState(w, h, dpr)
    const { vals, energy } = spectrumValues(st.k, st.minV, st.maxV, st.breatheMix, st.breathe)
    const xStep = w / (FREQ_BINS - 1)
    const lift = st.strip ? 0 : bassEnv * 5 * dpr
    const ampBoost = 1 + bassEnv * 0.25
    const pts = []
    for (let i = 0; i < FREQ_BINS; i++) {
      const y = st.baseY - vals[i] * st.rise * gainEnv * ampBoost - lift
      pts.push({ x: i * xStep, y: Math.max(dpr * 0.5, Math.min(h - dpr * 0.5, y)) })
    }
    const rgb = waveColor()
    const glow = Math.round(3 + energy * 12)
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

  // 流动色带：封面 3 色合起来，缓慢流动（原创替代「极光」——用封面色，非蓝紫）
  function drawAurora(x, y, w, h) {
    const colors = accentColors()
    const flow = (breatheTime * 0.004) % 1 // 缓慢流动相位
    ctx.save()
    ctx.beginPath()
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, w / 2)
    else ctx.rect(x, y, w, h)
    ctx.clip() // 裁剪到圆角竖条
    const gw = w * 3 // 渐变宽度 3 倍，平移实现流动
    const off = flow * gw
    const grad = ctx.createLinearGradient(x - off, 0, x - off + gw, 0)
    const cols = [colors[0], colors[1], colors[2], colors[0]]
    for (let i = 0; i < 4; i++) {
      grad.addColorStop(i / 3, `rgba(${cols[i][0]},${cols[i][1]},${cols[i][2]},0.85)`)
    }
    ctx.fillStyle = grad
    ctx.fillRect(x, y, w, h)
    ctx.restore()
  }

  // 柱状：9 根细柱，随频谱律动
  function drawBars(w, h, dpr) {
    const st = waveState(w, h, dpr)
    const { vals } = spectrumValues(st.k, st.minV, st.maxV, st.breatheMix, st.breathe)
    const rgb = waveColor()
    const n = 9 // 9 根细柱
    const barW = 6 * dpr // 细柱（放大 1.2 倍）
    const gap = 4 * dpr // 紧凑间隔
    const totalW = n * barW + (n - 1) * gap
    const startX = st.strip ? (w - totalW) / 2 : (w - totalW - 12 * dpr) // 细条态居中，正常态右对齐（岛右边，文字之后）
    const midY = h * 0.5 // 垂直居中：上下对称律动
    const maxHalf = st.strip ? barW * 1.2 : h * 0.38 // 细条态小球（放大空间），正常态放大 1.2 倍

    // 每根柱子随机相位（一次性初始化，让跳动不整齐）
    if (!barPhase || barPhase.length !== n) barPhase = new Array(n).fill(0).map(() => Math.random() * Math.PI * 2)

    ctx.save()
    for (let i = 0; i < n; i++) {
      // 均匀采样中频段（能量变化大→跳动明显），所有柱子都明显跳动，避免低频/高频的"几乎不动"
      const idx = Math.min(FREQ_BINS - 1, 10 + Math.round(i * 35 / (n - 1)))
      const v = Math.pow(Math.min(1, vals[idx] * gainEnv), 0.6)
      // 呼吸：每根柱子独立随机相位 + 随机频率，跳动不整齐
      const breatheLift = 0.10 + 0.08 * Math.sin(breatheTime * (0.018 + 0.02 * Math.abs(Math.sin(barPhase[i]))) + barPhase[i])
      const half = st.strip
        ? Math.max(barW * 0.3, (v + breatheLift) * maxHalf) // 细条态小球：随音乐明显放大缩小
        : Math.max(barW, (v + breatheLift * 0.5) * maxHalf)
      const x = startX + i * (barW + gap)
      const yTop = midY - half
      const yBot = midY + half
      // 渐变：顶部亮 → 底部暗（亮度渐变，上亮下暗，对齐参考图）
      const grad = ctx.createLinearGradient(0, yTop, 0, yBot)
      grad.addColorStop(0, `rgb(${Math.min(255, Math.round(rgb[0] * 1.35))},${Math.min(255, Math.round(rgb[1] * 1.35))},${Math.min(255, Math.round(rgb[2] * 1.35))})`)
      grad.addColorStop(1, `rgb(${Math.round(rgb[0] * 0.55)},${Math.round(rgb[1] * 0.55)},${Math.round(rgb[2] * 0.55)})`)
      ctx.fillStyle = grad
      if (ctx.roundRect) {
        ctx.beginPath()
        ctx.roundRect(x, yTop, barW, half * 2, barW / 2)
        ctx.fill()
      } else {
        ctx.fillRect(x, yTop, barW, half * 2)
      }
    }
    ctx.restore()
  }

  // 涟漪：同心圆从封面中心向外扩散，更粗更慢更稀疏，随节拍加速
  function drawRipple(w, h, dpr) {
    const rgb = waveColor()
    const strip = document.body.classList.contains('docked') && islandEl.classList.contains('docked-idle')
    let cx = w / 2
    let cy = h / 2
    // 正常态（非细条）：涟漪中心 = 封面中心
    if (!strip && coverEl && islandEl) {
      const ir = islandEl.getBoundingClientRect()
      const cr = coverEl.getBoundingClientRect()
      cx = (cr.left + cr.width / 2 - ir.left) * dpr
      cy = (cr.top + cr.height / 2 - ir.top) * dpr
    }
    // 最大半径 = 中心到最远角的距离，涟漪最外圈正好扩散到岛边缘
    const maxR = Math.max(
      Math.hypot(cx, cy),
      Math.hypot(cx - w, cy),
      Math.hypot(cx, cy - h),
      Math.hypot(cx - w, cy - h)
    )
    const rings = 3
    const speed = 0.012 + normBeat * 0.02 // 节拍激烈时扩散稍快，但上限防晃眼
    for (let i = 0; i < rings; i++) {
      const phase = (breatheTime * speed + i / rings) % 1
      const r = phase * maxR // 从封面中心扩散到岛边缘
      const a = (1 - phase * 0.55) * (0.4 + normBeat * 0.3) // 到边缘时仍可见
      ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a.toFixed(3)})`
      ctx.lineWidth = (2 + normBeat * 2) * dpr
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.stroke()
    }
    // 中心光点：随节拍亮，带渐变光晕；细条态自动缩小不溢出
    const cr = Math.min(h * 0.32, (4 + normBeat * 8) * dpr)
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr)
    g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(0.65 + normBeat * 0.35).toFixed(3)})`)
    g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`)
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(cx, cy, cr, 0, Math.PI * 2)
    ctx.fill()
  }

  // 流光：许多根大小不一的流星，散布整个岛（左右都有），数量随节拍
  function drawSweep(w, h, dpr) {
    const rgb = waveColor()
    const count = 3 + Math.round(normBeat * 9) // 疏密随节拍：3~12 根
    for (let i = 0; i < count; i++) {
      // 确定性伪随机（基于 i），每帧稳定不跳变
      const r = (n) => {
        const v = Math.sin(i * 127.1 + n * 311.7) * 43758.5453
        return v - Math.floor(v)
      }
      // 随机方向（向右下，各根不同路线）
      const ang = 0.3 + r(1) * 0.7
      // 固定速度 + 随机相位（时间偏移，不整齐）
      const t = (breatheTime * 0.006 + r(2)) % 1
      // 起点 x 散布整个宽度（左边到右边都有），y 在岛上方
      const startX = r(3) * w * 1.1 - w * 0.05
      const startY = -r(4) * h * 0.6
      const travel = t * (w * 0.6 + h)
      const x = startX + Math.cos(ang) * travel
      const y = startY + Math.sin(ang) * travel
      // 大小不一：头半径/尾长/线宽随机
      const headR = (2 + r(5) * 3.5) * dpr
      const tailLen = (16 + r(6) * 24) * dpr
      const tx = x - Math.cos(ang) * tailLen
      const ty = y - Math.sin(ang) * tailLen
      // 流星尾：渐隐光尾（更浅）
      const tail = ctx.createLinearGradient(x, y, tx, ty)
      tail.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(0.3 + r(7) * 0.25).toFixed(3)})`)
      tail.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`)
      ctx.strokeStyle = tail
      ctx.lineWidth = (1.5 + r(8) * 2) * dpr
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(tx, ty)
      ctx.stroke()
      // 流星头：亮光点（白芯 + accent 光晕，更浅）
      const head = ctx.createRadialGradient(x, y, 0, x, y, headR * 2.2)
      head.addColorStop(0, 'rgba(255, 255, 255, 0.75)')
      head.addColorStop(0.5, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.45)`)
      head.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`)
      ctx.fillStyle = head
      ctx.beginPath()
      ctx.arc(x, y, headR * 2.2, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // 主循环：清屏 → 按形态 dispatch。流畅感靠 smooth[] 指数平滑，不靠残影
  function draw() {
    requestAnimationFrame(draw)
    if (!ctx) return
    syncWaveSize()
    const w = waveW
    const h = waveH
    if (style === 'none' || theme === 'ribbon') {
      // 无律动 或 ribbon 主题：只画纯黑背景，不画丝带、不画任何律动形态
      if (w >= 2 && h >= 2) {
        ctx.clearRect(0, 0, w, h)
        if (theme === 'ribbon') {
          ctx.fillStyle = '#000'
          ctx.fillRect(0, 0, w, h)
        }
      }
      return
    }
    updateShared()
    if (w < 2 || h < 2) return
    const dpr = window.devicePixelRatio || 1
    ctx.clearRect(0, 0, w, h)
    switch (style) {
      case 'bars': drawBars(w, h, dpr); break
      case 'ripple': drawRipple(w, h, dpr); break
      case 'sweep': drawSweep(w, h, dpr); break
      default: drawWave(w, h, dpr)
    }
  }

  // 对外接口（renderer.js 驱动）
  window.Visualizer = {
    init(opts) {
      islandEl = opts.islandEl
      coverEl = opts.coverEl || null
      if (style !== 'none') ensureAudioCapture()
      requestAnimationFrame(draw)
    },
    setStyle(s) {
      const next = STYLES.includes(s) ? s : 'wave'
      if (next === style) return
      style = next
      localStorage.setItem('islandStyle', style)
      document.body.classList.toggle('style-bars', style === 'bars') // 遮罩仅柱状形态生效
      if (style === 'none') stopAudioCapture()
      else { captureFailed = false; ensureAudioCapture() }
    },
    setTheme(t) {
      const next = THEMES.includes(t) ? t : 'default'
      if (next === theme) return
      theme = next
      localStorage.setItem('islandTheme', theme)
      document.body.classList.toggle('theme-ribbon', theme === 'ribbon')
    },
    setPlaying(p) {
      playing = !!p
    },
    retryCapture() {
      if (captureFailed && style !== 'none') {
        captureFailed = false
        ensureAudioCapture()
      }
    },
  }
})()
