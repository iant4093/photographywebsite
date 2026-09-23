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

// React replaces the fallback on mount. Never reload a running app.
;(function watchStartup() {
  function unavailable() {
    var retry = document.getElementById('startup-retry')
    if (retry) retry.hidden = false
  }
  window.setTimeout(unavailable, 15000)
  window.addEventListener('error', function (event) {
    if (event.target === window || event.target?.type === 'module') {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', unavailable, { once: true })
      else unavailable()
    }
  }, true)
}())

// Discover the actual route's hero before the application bundle arrives.
// This shares the existing early script request and works with the strict CSP.
;(function preloadRouteHero() {
  var route = window.location.pathname.replace(/\/$/, '')
  if (route !== '' && route !== '/videos') return
  var origin = document.currentScript?.dataset.mediaOrigin
  if (!origin || !/^https:\/\/[a-z0-9.-]+$/i.test(origin)) return
  var video = route === '/videos'
  var prefix = origin + '/site/hero/' + (video ? 'video/' : '') + 'current/hero-'
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
