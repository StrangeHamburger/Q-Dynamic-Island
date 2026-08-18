// cover.js - 按 歌名 + 歌手 搜索音乐封面，返回 data URI（失败返回 null）
// 主进程运行（Node 环境），无 CORS 限制，多个音乐源并行兜底，谁先拿到用谁。
const { fetch } = globalThis

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

// query -> dataUrl（null 表示搜过但没结果，短期缓存避免反复请求）
const cache = new Map()
const inflight = new Map() // query -> Promise（并发去重）
const MAX_CACHE = 200

function withTimeout(ms) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  return { signal: ctl.signal, done: () => clearTimeout(t) }
}

async function fetchJson(url, timeout = 4000) {
  const { signal, done } = withTimeout(timeout)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://y.qq.com/' }, signal })
    if (!res.ok) return null
    return await res.json()
  } catch { return null } finally { done() }
}

async function fetchImageDataUrl(url, timeout = 5000) {
  const { signal, done } = withTimeout(timeout)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) return null
    const mime = res.headers.get('content-type') || 'image/jpeg'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch { return null } finally { done() }
}

// --- 各音乐源 ---

// QQ 音乐搜索
async function providerQQ(query) {
  const u = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(query)}&format=json&n=5&t=0`
  const j = await fetchJson(u)
  const list = j && j.data && j.data.song && j.data.song.list
  if (!list || !list.length) return null
  const albummid = list[0].albummid
  if (!albummid) return null
  return fetchImageDataUrl(`https://y.gtimg.cn/music/photo_new/T002R300x300M000${albummid}.jpg`)
}

// 网易云搜索（返回歌单数组，供打分挑选最佳匹配）
async function neteaseSearchSongs(query) {
  const u = `https://music.163.com/api/search/get/web?s=${encodeURIComponent(query)}&type=1&limit=20`
  const j = await fetchJson(u)
  const songs = j && j.result && j.result.songs
  return songs && songs.length ? songs : null
}

// 相似度：完全相同=1，互相包含=0.55，否则=0（用于歌名/歌手打分）
function strSim(a, b) {
  a = String(a || '').trim().toLowerCase()
  b = String(b || '').trim().toLowerCase()
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.includes(b) || b.includes(a)) return 0.55
  return 0
}

// 从网易云搜索结果里挑「歌名+歌手」最匹配的一首，避免翻唱/同名曲封面张冠李戴
function pickBestNetease(songs, title, artist) {
  let best = songs[0]
  let bestScore = -1
  for (const s of songs) {
    let score = strSim(s.name, title) * 0.7
    if (artist && Array.isArray(s.artists) && s.artists.length) {
      let as = 0
      for (const a of s.artists) as = Math.max(as, strSim(a.name, artist))
      score += as * 0.3
    }
    if (score > bestScore) { bestScore = score; best = s }
  }
  return best
}

function neteaseAlbumPicUrl(song) {
  const album = song && song.album || {}
  const pic = album.picUrl || album.blurPicUrl
  if (!pic) return null
  const url = String(pic).replace(/^http:/, 'https:')
  return url.includes('?') ? url : url + '?param=300y300'
}

// 网易云搜索（通用兜底：query 字符串，取首个结果）
async function providerNetease(query) {
  const songs = await neteaseSearchSongs(query)
  if (!songs) return null
  const url = neteaseAlbumPicUrl(songs[0])
  return url ? fetchImageDataUrl(url) : null
}

// 网易云精确匹配（网易云源主路径）：歌名+歌手打分挑最匹配，避免翻唱/同名曲封面不对
async function getNeteaseCover(title, artist) {
  const q = [title, artist].filter(Boolean).join(' ').trim()
  if (!q) return null
  const cacheKey = 'ne:' + q
  if (cache.has(cacheKey)) return cache.get(cacheKey)
  if (inflight.has(cacheKey)) return inflight.get(cacheKey)

  const promise = (async () => {
    let songs = await neteaseSearchSongs(q)
    if (!songs && title && title.trim() !== q) songs = await neteaseSearchSongs(title.trim())
    if (!songs) return null
    const best = pickBestNetease(songs, title, artist)
    const url = neteaseAlbumPicUrl(best)
    return url ? fetchImageDataUrl(url) : null
  })().then((dataUrl) => {
    cache.set(cacheKey, dataUrl)
    if (cache.size > MAX_CACHE) { const first = cache.keys().next().value; cache.delete(first) }
    return dataUrl
  })
  inflight.set(cacheKey, promise)
  promise.then(() => inflight.delete(cacheKey), () => inflight.delete(cacheKey))
  return promise
}

// 酷狗搜索（窗口标题模式酷狗独家歌的封面主源）
async function providerKugou(query) {
  const u = `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(query)}&page=1&pagesize=5`
  const j = await fetchJson(u)
  const list = j && j.data && j.data.info
  if (!list || !list.length) return null
  // union_cover 是模板 URL（含 {size} 占位符），替换成实际尺寸；无则退回 hash 拼接
  let url = list[0].trans_param && list[0].trans_param.union_cover
  if (url) {
    url = String(url).replace('{size}', '240')
  } else {
    const hash = list[0].hash
    if (!hash) return null
    url = `http://imge.kugou.com/stdmusic/240/${hash}.jpg`
  }
  return fetchImageDataUrl(String(url))
}

// iTunes 搜索（国外源，兜底主流歌曲）
async function providerITunes(query) {
  const u = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&limit=1&country=CN`
  const j = await fetchJson(u)
  const r = j && j.results && j.results[0]
  if (!r || !r.artworkUrl100) return null
  const big = String(r.artworkUrl100).replace('100x100bb', '300x300bb')
  return fetchImageDataUrl(big)
}

const PROVIDERS = [providerQQ, providerNetease, providerKugou, providerITunes]

// 并行尝试指定源，谁先拿到封面用谁；全部失败才返回 null
async function searchCover(query, providers) {
  const attempts = providers.map(async (p) => {
    const dataUrl = await p(query)
    if (!dataUrl) throw new Error('miss') // 让 Promise.any 跳过这个源继续等
    return dataUrl
  })
  try {
    return await Promise.any(attempts)
  } catch {
    return null
  }
}

// 单个查询串的封面搜索（带缓存 + 并发去重）
async function queryCover(query, providers = PROVIDERS) {
  if (cache.has(query)) return cache.get(query)
  if (inflight.has(query)) return inflight.get(query)

  const promise = searchCover(query, providers).then((dataUrl) => {
    cache.set(query, dataUrl)
    if (cache.size > MAX_CACHE) {
      const first = cache.keys().next().value
      cache.delete(first)
    }
    return dataUrl
  })
  inflight.set(query, promise)
  promise.then(() => inflight.delete(query), () => inflight.delete(query))
  return promise
}

// 对外：根据标题+歌手拿封面。source 指定播放器来源：网易云在播时先用网易云自己的库
// （封面跟播放器一致），搜不到再全源兜底。GSMTC 不提供封面字段，这里联网搜索。
// 主查询「歌名+歌手」失败时，再只拿歌名搜一轮 —— 组合搜不到的小众歌/平台独有歌，
// 纯歌名命中率往往更高。
async function getCover(title, artist, source) {
  const query = [title, artist].filter(Boolean).join(' ').trim()
  if (!query) return null
  let dataUrl
  if (source === '网易云音乐') {
    dataUrl = await getNeteaseCover(title, artist)
    if (!dataUrl) dataUrl = await queryCover(query, PROVIDERS)
  } else {
    dataUrl = await queryCover(query, PROVIDERS)
  }
  if (!dataUrl && title) {
    const t = title.trim()
    if (t && t !== query) dataUrl = await queryCover(t, PROVIDERS)
  }
  return dataUrl
}

module.exports = { getCover }
