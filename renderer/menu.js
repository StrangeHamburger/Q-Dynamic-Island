// 菜单窗口渲染进程：与岛窗口同 file:// origin → localStorage 互通，
// 初始值直接读岛窗口持久化的状态；改动经主进程转给岛窗口实时生效
(function () {
  const pinCheck = document.getElementById('pinCheck')
  const styleBtns = document.querySelectorAll('#styleGrid .style-btn')
  const scaleSlider = document.getElementById('scaleSlider')
  const scaleValue = document.getElementById('scaleValue')
  const bgOpacitySlider = document.getElementById('bgOpacitySlider')
  const bgOpacityValue = document.getElementById('bgOpacityValue')
  const menuClose = document.getElementById('menuClose')
  const menuQuit = document.getElementById('menuQuit')

  // 初始值：与岛窗口共享 localStorage
  let scale = parseFloat(localStorage.getItem('islandScale'))
  if (!(scale >= 0.67 && scale <= 1)) scale = 1
  let bgOpacity = parseFloat(localStorage.getItem('islandBgOpacity'))
  if (!(bgOpacity >= 0.2 && bgOpacity <= 1)) bgOpacity = 0.92
  const STYLES = ['none', 'wave', 'bars', 'ripple', 'sweep']
  let style = localStorage.getItem('islandStyle')
  if (!STYLES.includes(style)) style = 'wave'

  pinCheck.checked = false // 固定状态由主进程下发（island:pinned）
  applyStyleBtn(style)
  scaleSlider.value = String(scale)
  scaleValue.textContent = Math.round(scale * 100) + '%'
  bgOpacitySlider.value = String(bgOpacity)
  bgOpacityValue.textContent = Math.round(bgOpacity * 100) + '%'

  // 上报面板实际高度 → 主进程贴合窗口尺寸（去掉底部透明死区，避免挡桌面点击）
  window.island.setMenuSize(Math.ceil(document.body.scrollHeight) + 2)

  window.island.onPinned((v) => { pinCheck.checked = !!v })

  function applyStyleBtn(s) {
    styleBtns.forEach((b) => b.classList.toggle('active', b.dataset.style === s))
  }

  styleBtns.forEach((b) => {
    b.addEventListener('click', () => {
      const s = b.dataset.style
      localStorage.setItem('islandStyle', s)
      applyStyleBtn(s)
      window.island.setStyle(s)
    })
  })

  scaleSlider.addEventListener('input', () => {
    const s = parseFloat(scaleSlider.value)
    scaleValue.textContent = Math.round(s * 100) + '%'
    window.island.setScale(s) // 主进程改窗口尺寸 + 回传岛窗口应用 zoom
  })
  bgOpacitySlider.addEventListener('input', () => {
    const v = parseFloat(bgOpacitySlider.value)
    bgOpacityValue.textContent = Math.round(v * 100) + '%'
    window.island.setBgOpacity(v)
  })
  pinCheck.addEventListener('change', () => window.island.setPinned(pinCheck.checked))
  menuClose.addEventListener('click', () => window.island.setMenuOpen(false))
  menuQuit.addEventListener('click', () => window.island.quit())
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.island.setMenuOpen(false)
  })

  // 主进程据此完成首次弹出（先量好尺寸再显示，避免窗口尺寸跳变）
  window.island.menuReady()
})()
