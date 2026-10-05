(function initializeTheme() {
  var theme = 'light'
  try {
    if (window.localStorage.getItem('ian-photography-theme') === 'dark') {
      theme = 'dark'
    }
  } catch {
    theme = 'light'
  }
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  var themeColor = document.querySelector('meta[name="theme-color"]')
  if (themeColor) themeColor.setAttribute('content', theme === 'dark' ? '#171613' : '#faf8f5')
  if (theme === 'dark') {
    var darkStyles = document.createElement('link')
    darkStyles.id = 'dark-theme-styles'
    darkStyles.rel = 'stylesheet'
    darkStyles.href = '/dark-theme.css'
    document.head.appendChild(darkStyles)
  }
}())

// Discover the actual route's hero before the application bundle arrives.
// This shares the existing early script request and works with the strict CSP.
;(function preloadRouteHero() {
  var route = window.location.pathname.replace(/\/$/, '')
  if (route !== '' && route !== '/videos') return
  var origin = document.currentScript?.dataset.mediaOrigin
  if (!origin || !/^https:\/\/[a-z0-9.-]+$/i.test(origin)) return
  var video = route === '/videos'
  var still = video ? rememberedReelStill() : null
  var prefix = still
    ? origin + '/site/hero/versions/video/reel/v1/' + still.version + '/still-' + still.cut + '-'
    : origin + '/site/hero/' + (video ? 'video/' : '') + 'current/hero-'
  var preload = document.createElement('link')
  preload.rel = 'preload'
  preload.as = 'image'
  preload.type = 'image/avif'
  preload.href = prefix + '960.avif'
  preload.imageSrcset = [640, 960, 1280, 1920, 2560].map(function (width) {
    return prefix + width + '.avif ' + width + 'w'
  }).join(', ')
  preload.imageSizes = video
    ? '(min-width: 768px) max(100vw, calc(clamp(69.75rem, 138svh, 1170px) + 90px)), max(100vw, calc(clamp(55.5rem, 138svh, 1170px) + 90px))'
    : '(min-width: 768px) max(100vw, calc(clamp(72.54rem, 143.52svh, 1216.8px) + 0px)), max(100vw, calc(clamp(55.5rem, 138svh, 1170px) + 36px))'
  preload.fetchPriority = 'high'
  document.head.appendChild(preload)
}())

// A returning Videos visitor sees the opening still of a random reel cut; the
// page and the reel read the choice back from the root element's dataset.
function rememberedReelStill() {
  try {
    var memory = JSON.parse(window.localStorage.getItem('ian:hero-reel-stills:v1'))
    if (!memory || !/^[a-f0-9]{24}$/.test(memory.version) || !Array.isArray(memory.stills)) return null
    var cuts = memory.stills.filter(function (cut) { return Number.isInteger(cut) && cut >= 0 && cut < 8 })
    if (!cuts.length) return null
    var cut = cuts[Math.floor(Math.random() * cuts.length)]
    document.documentElement.dataset.heroStillVersion = memory.version
    document.documentElement.dataset.heroStillCut = String(cut)
    return { version: memory.version, cut: cut }
  } catch {
    return null
  }
}

// Preload the app's first catalog request (fetchAlbumsPage) byte for byte,
// unless a fresh tab snapshot lets the app skip it.
;(function preloadRouteCatalog() {
  var route = window.location.pathname.replace(/\/$/, '')
  if (route !== '' && route !== '/videos') return
  var type = route ? 'video' : 'photo'
  try {
    var snapshot = JSON.parse(window.sessionStorage.getItem('ian:public-catalog:v6:public-' + type + 's'))
    if (snapshot.version === 6 && Date.now() - snapshot.savedAt <= 300000) return
  } catch { /* Without a readable snapshot the app fetches the page. */ }
  var link = document.createElement('link')
  link.rel = 'preload'
  link.as = 'fetch'
  link.crossOrigin = 'anonymous'
  link.href = '/api/public/albums?type=' + type + '&limit=100'
  document.head.appendChild(link)
}())
