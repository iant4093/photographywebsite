export const THEME_STORAGE_KEY = 'ian-photography-theme'

export const normalizeTheme = (value) => (value === 'dark' ? 'dark' : 'light')

export function readStoredTheme(storage = typeof window !== 'undefined' ? window.localStorage : null) {
  try {
    return normalizeTheme(storage?.getItem(THEME_STORAGE_KEY))
  } catch {
    return 'light'
  }
}

export function storeTheme(theme, storage = typeof window !== 'undefined' ? window.localStorage : null) {
  const normalized = normalizeTheme(theme)
  try {
    storage?.setItem(THEME_STORAGE_KEY, normalized)
  } catch {
    // The theme still works for this session when storage is unavailable.
  }
  return normalized
}

export function applyDocumentTheme(theme, root = typeof document !== 'undefined' ? document.documentElement : null) {
  const normalized = normalizeTheme(theme)
  if (!root) return normalized

  root.dataset.theme = normalized
  root.style.colorScheme = normalized
  const themeColor = root.ownerDocument?.querySelector('meta[name="theme-color"]')
  themeColor?.setAttribute('content', normalized === 'dark' ? '#171613' : '#faf8f5')
  let darkStyles = root.ownerDocument?.getElementById('dark-theme-styles')
  if (!darkStyles && normalized === 'dark' && root.ownerDocument) {
    darkStyles = root.ownerDocument.createElement('link')
    darkStyles.id = 'dark-theme-styles'
    darkStyles.rel = 'stylesheet'
    darkStyles.href = '/dark-theme.css'
    root.ownerDocument.head.appendChild(darkStyles)
  }
  if (darkStyles) darkStyles.media = normalized === 'dark' ? 'all' : 'not all'
  return normalized
}
