(function initializeTheme() {
  var theme = 'light'
  try {
    if (!window.location.pathname.startsWith('/admin') && window.localStorage.getItem('ian-photography-theme') === 'dark') {
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
