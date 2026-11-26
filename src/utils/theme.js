export const THEME_STORAGE_KEY = 'ian-photography-theme'

export const normalizeTheme = (value) => (value === 'dark' ? 'dark' : 'light')

export function readStoredTheme(storage) {
  try {
    storage ??= typeof window !== 'undefined' ? window.localStorage : null
    return normalizeTheme(storage?.getItem(THEME_STORAGE_KEY))
  } catch {
    return 'light'
  }
}

export function storeTheme(theme, storage) {
  const normalized = normalizeTheme(theme)
  try {
    storage ??= typeof window !== 'undefined' ? window.localStorage : null
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
  return normalized
}
