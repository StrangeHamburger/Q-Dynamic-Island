// 岛内律动可视化：系统音频回环 → Analyser → 多形态绘制（wave/bars/ripple/sweep）。
// 原 renderer.js 的波浪绘制迁移至此并扩展为四形态；renderer.js 通过 window.Visualizer 驱动。
(function () {
  const STYLES = ['none', 'wave', 'bars', 'ripple', 'sweep']
  let style = localStorage.getItem('islandStyle')
  if (!STYLES.includes(style)) style = 'wave'
  document.body.classList.toggle('style-bars', style === 'bars') // 文字遮罩仅柱状形态生效

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
  let barSmooth = null // 柱状：每根柱的独立平滑值（线性频带 + 各自峰值归一化）
  let barPeak = null // 柱状：每根柱的近期峰值（慢衰减，用于归一化）
  let breatheTime = 0
  let bassEnv = 0 // 贝斯鼓点包络（快攻慢放）
  let gainEnv = 1 // 自动增益包络

  // 节拍检测（去趋势脉冲）：驱动各形态的节拍感 + 小球律动
  let slowBass = 0
  let beatPeak = 0
  let normBeat = 0

  // 涟漪脉冲：鼓点触发队列，每圈存 { t: 触发帧, s: 触发强度 }
  let ripplePulses = []
  let lastTriggerTime = 0

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

  // 圆角矩形填充（兼容旧 Electron 无 ctx.roundRect）
  function roundRect(x, y, w, h, r) {
    ctx.beginPath()
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r)
    else {
      ctx.moveTo(x + r, y)
      ctx.arcTo(x + w, y, x + w, y + h, r)
      ctx.arcTo(x + w, y + h, x, y + h, r)
      ctx.arcTo(x, y + h, x, y, r)
      ctx.arcTo(x, y, x + w, y, r)
      ctx.closePath()
    }
    ctx.fill()
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

    // 鼓点触发涟漪：低频脉冲超过阈值 + 冷却时间，推入一圈新脉冲（不逐帧触发）
    if (analyser && bassEnv > 0.05 && beat > Math.max(0.04, beatPeak * 0.45) && breatheTime - lastTriggerTime > 10) {
      ripplePulses.push({ t: breatheTime, s: normBeat })
      if (ripplePulses.length > 6) ripplePulses.shift()
      lastTriggerTime = breatheTime
    }
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

  // 柱状：9 根圆头胶囊等化器，居中左右对称（中间高、向两边递减），底部基线升起，
  // 玻璃发光质感。贴顶收拢（细条）时变成小球珠链：整条铺满、中间大向两边依次缩小。
  function drawBars(w, h, dpr) {
    const st = waveState(w, h, dpr)
    const rgb = waveColor()
    const n = 9

    // 每根柱子随机相位 + 独立平滑/峰值（一次性初始化，让跳动不整齐且各自归一化）
    if (!barPhase || barPhase.length !== n) barPhase = new Array(n).fill(0).map(() => Math.random() * Math.PI * 2)
    if (!barSmooth || barSmooth.length !== n) barSmooth = new Array(n).fill(0.08)
    if (!barPeak || barPeak.length !== n) barPeak = new Array(n).fill(0.08)

    const center = (n - 1) / 2
    const cBright = `rgb(${Math.min(255, Math.round(rgb[0] * 1.5))},${Math.min(255, Math.round(rgb[1] * 1.5))},${Math.min(255, Math.round(rgb[2] * 1.5))})`
    const cMid = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
    const cDark = `rgb(${Math.round(rgb[0] * 0.4)},${Math.round(rgb[1] * 0.4)},${Math.round(rgb[2] * 0.4)})`

    // 正常态几何：右对齐（贴岛右缘），圆头胶囊柱（radius = 柱宽/2 天然圆头）
    const barW = 6 * dpr
    const gap = 7 * dpr
    const totalW = n * barW + (n - 1) * gap
    const startX = w - totalW - 12 * dpr
    const bottomY = h - Math.max(8 * dpr, h * 0.14)
    const maxH = h * 0.52

    // 细条态几何：居中成簇（不铺满整条、也不挤成一小团），圆点珠链（圆心同一水平线）
    const stripStep = 16 * dpr
    const stripStart = (w - stripStep * (n - 1)) / 2
    const stripCy = h * 0.5
    const stripMaxR = h * 0.34

    ctx.save()
    for (let i = 0; i < n; i++) {
      // 频带采样：低频~中高频（bin 1..48 ≈ 93Hz~4.5kHz，覆盖贝斯/人声/乐器主能量），
      // 不取高频（>5kHz 只剩镲片/空气感，靠边几根会采不到能量、几乎不动）
      const BAND_LO = 1
      const BAND_HI = 48
      const segStart = BAND_LO + Math.floor(i * (BAND_HI - BAND_LO) / n)
      const segEnd = BAND_LO + Math.floor((i + 1) * (BAND_HI - BAND_LO) / n)

      let v, breatheLift
      if (analyser && freqData) {
        let v0 = 0
        for (let b = segStart; b < segEnd; b++) if (freqData[b] / 255 > v0) v0 = freqData[b] / 255
        // 慢衰减峰值 + 各自归一化，让每根柱都在自己的幅度范围内明显跳动
        barPeak[i] = Math.max(barPeak[i] * 0.99, v0)
        const norm = v0 > 0.02 ? Math.min(1, v0 / Math.max(barPeak[i], 0.08)) : 0
        barSmooth[i] += (norm - barSmooth[i]) * 0.35
        v = barSmooth[i]
        breatheLift = 0.06 + 0.05 * Math.sin(breatheTime * (0.02 + 0.02 * Math.abs(Math.sin(barPhase[i]))) + barPhase[i])
      } else {
        v = 0.18
        breatheLift = 0
      }

      // 左右对称山丘：中间 1 → 两边递减
      const env = 1 - 0.35 * Math.pow(Math.abs(i - center) / center, 1.3)
      const lift = (v + breatheLift * 0.4) * env

      if (st.strip) {
        // —— 小球珠链：居中成簇、圆心同一水平线，中间大向两边依次缩小 ——
        const cx = stripStart + i * stripStep
        const hill = 1 - 0.6 * Math.pow(Math.abs(i - center) / center, 1.2)
        const r = Math.max(1.5 * dpr,
          analyser && freqData
            ? stripMaxR * hill * (0.45 + 0.55 * v) // 跳动：静止山丘上放大，振幅更大更明显
            : stripMaxR * hill * 0.7)              // 静止：固定山丘，不跳
        const cy = stripCy
        // 质感：发光光珠——先铺一层柔光晕（halo）营造「亮」的氛围，核心是亮的
        // 主色珠（中心微提亮 → 边缘主色）。不做白斑、不做高光弧、不压暗底部，
        // 避开「塑料糖」的白芯和「灰暗扁片」两个极端
        const haloR = r * 2.2
        const halo = ctx.createRadialGradient(cx, cy, r * 0.3, cx, cy, haloR)
        halo.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.34)`)
        halo.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`)
        ctx.fillStyle = halo
        ctx.beginPath()
        ctx.arc(cx, cy, haloR, 0, Math.PI * 2)
        ctx.fill()
        // 核心：中心微亮 → 边缘主色（不再压暗到底，让珠保持发光感）
        const cHi = `rgb(${Math.round(rgb[0] + (255 - rgb[0]) * 0.42)},${Math.round(rgb[1] + (255 - rgb[1]) * 0.42)},${Math.round(rgb[2] + (255 - rgb[2]) * 0.42)})`
        const cEdge = `rgb(${Math.round(rgb[0] * 0.88)},${Math.round(rgb[1] * 0.88)},${Math.round(rgb[2] * 0.88)})`
        const cCore = ctx.createRadialGradient(cx, cy - r * 0.3, r * 0.1, cx, cy, r)
        cCore.addColorStop(0, cHi)
        cCore.addColorStop(0.6, cMid)
        cCore.addColorStop(1, cEdge)
        ctx.fillStyle = cCore
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.fill()
      } else {
        // —— 圆头胶囊柱：居中铺开，底部基线升起 ——
        const x = startX + i * (barW + gap)
        const bh = Math.max(barW, lift * maxH)
        const yTop = bottomY - bh
        // 发光晕底
        ctx.save()
        ctx.shadowColor = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.5)`
        ctx.shadowBlur = 8 * dpr
        ctx.fillStyle = cMid
        roundRect(x, yTop, barW, bh, barW / 2)
        ctx.restore()
        // 玻璃渐变主体：顶部白芯高光 → 主色 → 底部暗
        const grad = ctx.createLinearGradient(0, yTop, 0, bottomY)
        grad.addColorStop(0, `rgba(255,255,255,0.92)`)
        grad.addColorStop(0.2, cBright)
        grad.addColorStop(0.6, cMid)
        grad.addColorStop(1, cDark)
        ctx.fillStyle = grad
        roundRect(x, yTop, barW, bh, barW / 2)
      }
    }
    ctx.restore()
  }

  // 涟漪：鼓点触发的声波脉冲，从封面中心炸开、向外扩散并自然消隐。
  // 环带用径向渐变（内虚→实→外虚），非描边，像水面能量波而非工程图
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
    // 最大半径 = 中心到最远角的距离，最外圈正好扩散到岛边缘
    const maxR = Math.max(
      Math.hypot(cx, cy),
      Math.hypot(cx - w, cy),
      Math.hypot(cx, cy - h),
      Math.hypot(cx - w, cy - h)
    )

    // 清理已走完的脉冲；每圈生命周期 ~55 帧
    const LIFETIME = 55
    ripplePulses = ripplePulses.filter((p) => breatheTime - p.t < LIFETIME)

    // 无音频（未播放）：只保留中心一点柔和呼吸光，不发脉冲
    if (!analyser || !freqData) {
      const breathe = 0.5 + 0.5 * Math.sin(breatheTime * 0.03)
      const cr = Math.min(h * 0.3, (3 + breathe * 2) * dpr)
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr)
      g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.4)`)
      g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`)
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(cx, cy, cr, 0, Math.PI * 2)
      ctx.fill()
      return
    }

    // 逐圈绘制：easeOut 扩散（先快后慢），半径从 0 → maxR，透明度随进度消隐
    for (const p of ripplePulses) {
      const progress = Math.min(1, (breatheTime - p.t) / LIFETIME)
      const eased = 1 - Math.pow(1 - progress, 2.6) // easeOutQuart-ish
      const R = eased * maxR
      // 环带宽度随扩散略微变宽（真实声波前缘摊薄），中心态窄、边缘态宽
      const bandW = (6 + 16 * eased) * dpr
      const rIn = Math.max(0, R - bandW / 2)
      const rOut = R + bandW / 2
      const alpha = Math.pow(1 - progress, 1.4) * (0.5 + 0.5 * p.s)
      if (rOut <= rIn || alpha <= 0.01) continue
      const g = ctx.createRadialGradient(cx, cy, rIn, cx, cy, rOut)
      g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`)
      g.addColorStop(0.5, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha.toFixed(3)})`)
      g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`)
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(cx, cy, rOut, 0, Math.PI * 2)
      ctx.fill()
    }

    // 中心光点：随节拍强度亮，脉冲时刻最亮（封面像被鼓点敲亮）
    const cr = Math.min(h * 0.3, (4 + normBeat * 7) * dpr)
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr)
    g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(0.4 + normBeat * 0.5).toFixed(3)})`)
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

  // 边缘柔化：画布是直角矩形，波/涟漪/流光的发光会在左右边缘被硬切成直线（刀切）。
  // 播放时发光最亮、切痕最明显；用 destination-in 在左右两侧做水平淡出，让发光自然消隐。
  function softEdges(w, h, dpr) {
    const fade = Math.min(22 * dpr, w * 0.18)
    if (fade <= 0 || w <= 0) return
    ctx.save()
    ctx.globalCompositeOperation = 'destination-in'
    const g = ctx.createLinearGradient(0, 0, w, 0)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(fade / w, 'rgba(0,0,0,1)')
    g.addColorStop(1 - fade / w, 'rgba(0,0,0,1)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
    ctx.restore()
  }

  // 主循环：清屏 → 按形态 dispatch。流畅感靠 smooth[] 指数平滑，不靠残影
  function draw() {
    requestAnimationFrame(draw)
    if (!ctx) return
    syncWaveSize()
    const w = waveW
    const h = waveH
    if (style === 'none') {
      // 关闭律动：清空 canvas，避免残留上一个形态的最后一帧静态画面（用户报「无=固定上一个静态动画」）
      if (w >= 2 && h >= 2) ctx.clearRect(0, 0, w, h)
      return
    }
    updateShared()
    if (w < 2 || h < 2) return
    const dpr = window.devicePixelRatio || 1
    ctx.clearRect(0, 0, w, h)
    switch (style) {
      case 'bars': drawBars(w, h, dpr); break
      case 'ripple': drawRipple(w, h, dpr); softEdges(w, h, dpr); break
      case 'sweep': drawSweep(w, h, dpr); softEdges(w, h, dpr); break
      default: drawWave(w, h, dpr); softEdges(w, h, dpr)
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
