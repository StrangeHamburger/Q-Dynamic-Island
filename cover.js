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

// 网易云搜索
async function providerNetease(query) {
  const u = `https://music.163.com/api/search/get/web?s=${encodeURIComponent(query)}&type=1&limit=5`
  const j = await fetchJson(u)
  const songs = j && j.result && j.result.songs
  if (!songs || !songs.length) return null
  const album = songs[0].album || {}
  const pic = album.picUrl || album.blurPicUrl
  if (!pic) return null
  const url = String(pic).replace(/^http:/, 'https:')
  return fetchImageDataUrl(url.includes('?') ? url : url + '?param=300y300')
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

const PROVIDERS = [providerQQ, providerNetease, providerITunes]

// 并行尝试所有源，谁先拿到封面用谁；全部失败才返回 null
async function searchCover(query) {
  const attempts = PROVIDERS.map(async (p) => {
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
async function queryCover(query) {
  if (cache.has(query)) return cache.get(query)
  if (inflight.has(query)) return inflight.get(query)

  const promise = searchCover(query).then((dataUrl) => {
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

// 对外：根据标题+歌手拿封面。
// GSMTC 不提供封面字段，这里联网搜索。主查询「歌名+歌手」三个源全失败时，
// 再只拿歌名搜一轮 —— 组合搜不到的小众歌/平台独有歌，纯歌名命中率往往更高。
async function getCover(title, artist) {
  const query = [title, artist].filter(Boolean).join(' ').trim()
  if (!query) return null
  let dataUrl = await queryCover(query)
  if (!dataUrl && title) {
    const t = title.trim()
    if (t && t !== query) dataUrl = await queryCover(t)
  }
  return dataUrl
}

module.exports = { getCover }
