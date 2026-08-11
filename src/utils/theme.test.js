import { describe, expect, it, vi } from 'vitest'
import { applyDocumentTheme, normalizeTheme, readStoredTheme, storeTheme, THEME_STORAGE_KEY } from './theme'

describe('color theme helpers', () => {
  it('defaults invalid and missing values to light mode', () => {
    expect(normalizeTheme('dark')).toBe('dark')
    expect(normalizeTheme('system')).toBe('light')
    expect(readStoredTheme({ getItem: () => null })).toBe('light')
    expect(readStoredTheme({ getItem: () => 'unexpected' })).toBe('light')
  })

  it('reads and stores the explicit dark preference', () => {
    const storage = { getItem: vi.fn(() => 'dark'), setItem: vi.fn() }
    expect(readStoredTheme(storage)).toBe('dark')
    expect(storeTheme('dark', storage)).toBe('dark')
    expect(storage.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, 'dark')
  })

  it('fails safely when browser storage is unavailable', () => {
    const storage = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
    }
    expect(readStoredTheme(storage)).toBe('light')
    expect(storeTheme('dark', storage)).toBe('dark')
  })

  it('updates the document palette and browser theme color', () => {
    document.head.innerHTML = '<meta name="theme-color" content="#faf8f5">'
    expect(applyDocumentTheme('dark')).toBe('dark')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#171613')
    expect(document.getElementById('dark-theme-styles')).toHaveAttribute('media', 'all')
    expect(applyDocumentTheme('light')).toBe('light')
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#faf8f5')
    expect(document.getElementById('dark-theme-styles')).toHaveAttribute('media', 'not all')
  })
})
