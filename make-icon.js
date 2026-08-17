// 生成灵动岛托盘/应用图标 icon.png + 桌面快捷方式 icon.ico。
// 纯 Node 手写 PNG/ICO 编码，无需任何 image 依赖。运行：node make-icon.js
//
// 设计（极光网格渐变版）：
//   明亮磨砂玻璃圆角方块，内部是多色「极光」柔光团（青 → 蓝 → 紫 → 粉 → 暖金）
//   互相交融成无界的网格渐变，再加一道白色光丝与顶部玻璃高光。
//   抽象、通透、色彩丰富、无音符/柱状/黑色元素。
// 多尺寸 ICO 覆盖 256/48/32/16，托盘与桌面各取所需。
const zlib = require('zlib')
const fs = require('fs')
const path = require('path')

const W = 256
const H = 256

// ---------- PNG 编码 ----------
let crcTable = null
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
      crcTable[n] = c >>> 0
    }
  }
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}

function encodePng(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------- ICO 打包（多尺寸，各尺寸内嵌 PNG） ----------
function encodeIco(pngs) {
  const count = pngs.length
  const dir = Buffer.alloc(6 + 16 * count)
  dir.writeUInt16LE(0, 0)
  dir.writeUInt16LE(1, 2)
  dir.writeUInt16LE(count, 4)
  let offset = 6 + 16 * count
  const blobs = []
  pngs.forEach((p, i) => {
    const e = 6 + i * 16
    dir[e] = p.size >= 256 ? 0 : p.size
    dir[e + 1] = p.size >= 256 ? 0 : p.size
    dir[e + 2] = 0
    dir[e + 3] = 0
    dir.writeUInt16LE(1, e + 4)
    dir.writeUInt16LE(32, e + 6)
    dir.writeUInt32LE(p.data.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    blobs.push(p.data)
    offset += p.data.length
  })
  return Buffer.concat([dir, ...blobs])
}

// ---------- 采样 ----------
function lerp(a, b, t) { return a + (b - a) * t }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v }

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = Math.max(x0 + r, Math.min(x, x1 - r))
  const cy = Math.max(y0 + r, Math.min(y, y1 - r))
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

// 4x 超采样覆盖率
function coverage(x, y, inside) {
  let n = 0
  for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
    if (inside(x + ox, y + oy)) n++
  }
  return n / 4
}

// ---------- 设计：明亮磨砂玻璃 + 多色极光网格渐变 ----------
const BG = { x0: 22, y0: 22, x1: 234, y1: 234, r: 56 }

// 底色：极浅的冷白雾蓝（绝无黑色，整体明亮通透）
const BASE_TOP = [244, 246, 252]
const BASE_BOTTOM = [222, 228, 246]

// 极光柔光团：青 / 蓝 / 紫 / 粉 / 暖金，相互交融成无界网格渐变
const BLOBS = [
  { x: 78,  y: 92,  r: 95,  c: [60, 208, 190],  s: 0.82 }, // 青
  { x: 190, y: 74,  r: 96,  c: [96, 140, 255],  s: 0.88 }, // 蓝
  { x: 198, y: 172, r: 88,  c: [158, 120, 255], s: 0.82 }, // 紫
  { x: 70,  y: 186, r: 82,  c: [255, 128, 190], s: 0.78 }, // 粉
  { x: 128, y: 128, r: 175, c: [255, 214, 160], s: 0.32 }, // 暖金（中央柔暖）
]

// 白色光丝：一条极细发光正弦线横贯，给画面一个优雅的「流动」焦点
const FIL_CY = 128
const FIL_AMP = 42
const FIL_PERIODS = 3
const FIL_HALF = 2.2
const FIL_GLOW = 16

function filY(x) {
  return FIL_CY + FIL_AMP * Math.sin(FIL_PERIODS * 2 * Math.PI * x / W + 0.6)
}

const rgba = Buffer.alloc(W * H * 4)

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const cov = coverage(x, y, (px, py) => inRoundedRect(px, py, BG.x0, BG.y0, BG.x1, BG.y1, BG.r))
    if (cov <= 0) continue

    // --- 明亮磨砂玻璃底色（左上到右下极浅的亮度过渡） ---
    const bt = (x + y) / (W + H)
    let r = lerp(BASE_TOP[0], BASE_BOTTOM[0], bt)
    let g = lerp(BASE_TOP[1], BASE_BOTTOM[1], bt)
    let b = lerp(BASE_TOP[2], BASE_BOTTOM[2], bt)

    // --- 极光柔光团：按高斯衰减向团色混合，多团层层交融 ---
    for (const bl of BLOBS) {
      const dx = x - bl.x
      const dy = y - bl.y
      const w = Math.exp(-(dx * dx + dy * dy) / (2 * bl.r * bl.r))
      const t = w * bl.s
      if (t > 0.004) {
        r += (bl.c[0] - r) * t
        g += (bl.c[1] - g) * t
        b += (bl.c[2] - b) * t
      }
    }

    // --- 白色光丝（线体 + 柔光） ---
    const fd = y - filY(x)
    const fad = Math.abs(fd)
    if (fad <= FIL_HALF) {
      const t = 1 - fad / FIL_HALF
      const a = 0.42 + 0.4 * t
      r += (255 - r) * a; g += (255 - g) * a; b += (255 - b) * a
    } else if (fad <= FIL_HALF + FIL_GLOW) {
      const t = (fad - FIL_HALF) / FIL_GLOW
      const a = (1 - t) * 0.3
      r += (255 - r) * a; g += (255 - g) * a; b += (255 - b) * a
    }

    // --- 顶部玻璃高光 ---
    const hl = clamp01(1 - (y - BG.y0) / ((BG.y1 - BG.y0) * 0.5)) * 0.12
    r += (255 - r) * hl; g += (255 - g) * hl; b += (255 - b) * hl

    const idx = (y * W + x) * 4
    rgba[idx] = Math.round(r)
    rgba[idx + 1] = Math.round(g)
    rgba[idx + 2] = Math.round(b)
    rgba[idx + 3] = Math.round(cov * 255)
  }
}

// ---------- 降采样（area 平均，含 alpha） ----------
function downsample(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4)
  const sx = sw / dw, sy = sh / dh
  for (let dy = 0; dy < dh; dy++) {
    for (let dx = 0; dx < dw; dx++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0
      const x0 = Math.floor(dx * sx), x1 = Math.max(x0 + 1, Math.ceil((dx + 1) * sx))
      const y0 = Math.floor(dy * sy), y1 = Math.max(y0 + 1, Math.ceil((dy + 1) * sy))
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * sw + xx) * 4
          const aa = src[i + 3]
          r += src[i] * aa; g += src[i + 1] * aa; b += src[i + 2] * aa; a += aa; n++
        }
      }
      const o = (dy * dw + dx) * 4
      if (a > 0) {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
        out[o + 3] = Math.round(a / n)
      }
    }
  }
  return out
}

// ---------- 输出 ----------
const png256 = encodePng(rgba, W, H)
fs.writeFileSync(path.join(__dirname, 'icon.png'), png256)

const sizes = [256, 48, 32, 16]
const pngs = sizes.map((s) => ({
  size: s,
  data: s === 256 ? png256 : encodePng(downsample(rgba, W, H, s, s), s, s),
}))
fs.writeFileSync(path.join(__dirname, 'icon.ico'), encodeIco(pngs))

console.log('icon.png', png256.length, 'bytes')
console.log('icon.ico', fs.statSync(path.join(__dirname, 'icon.ico')).size, 'bytes,', sizes.join('/'), 'sizes')
