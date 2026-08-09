import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  albumCoverUrl,
  annotateMediaExpiry,
  cdnUrl,
  mediaDisplayUrl,
  mediaExpiresAt,
  mediaFileName,
  mediaHlsUrl,
  mediaId,
  mediaPreviewCandidates,
  mediaThumbnailUrl,
  resolveMediaDownloadUrl,
  signedUrlExpiresAt,
  startBrowserDownload,
} from './mediaUrls'
import {
  getHorizontalScroll,
  getSavedScroll,
  isRevealed,
  markAsRevealed,
  saveHorizontalScroll,
  saveVerticalScroll,
  useScrollRestoration,
} from './scroll'
import { useMediaExpiryRefresh } from './useMediaExpiryRefresh'

describe('media URL edge cases and browser download behavior', () => {
  it('rejects malformed previews and signed URLs while preserving compatible fallbacks', () => {
    expect(mediaPreviewCandidates(null)).toEqual([])
    expect(mediaPreviewCandidates({ previewSrcSet: 'nope' })).toEqual([])
    expect(mediaPreviewCandidates({ previewSrcSet: [] })).toEqual([])
    expect(mediaPreviewCandidates({ previewSrcSet: [
      { width: 640, url: 'https://ok.test/a.webp whitespace' },
      { width: 960, url: 'https://ok.test/960.webp' },
      { width: 1440, url: 'https://ok.test/1440.webp' },
      { width: 1920, url: 'https://ok.test/1920.webp' },
    ] })).toEqual([])
    expect(mediaPreviewCandidates({ previewSrcSet: [
      { width: 640, url: 'not-a-url' },
      { width: 960, url: 'https://ok.test/960.webp' },
      { width: 1440, url: 'https://ok.test/1440.webp' },
      { width: 1920, url: 'https://ok.test/1920.webp' },
    ] })).toEqual([])
    expect(signedUrlExpiresAt(null)).toBeNull()
    expect(signedUrlExpiresAt('mailto:test@example.com')).toBeNull()
    expect(signedUrlExpiresAt('https://x.test/?X-Amz-Date=bad&X-Amz-Expires=10')).toBeNull()
    expect(signedUrlExpiresAt('https://x.test/?X-Amz-Date=20260101T000000Z&X-Amz-Expires=0')).toBeNull()
    expect(signedUrlExpiresAt('https://%')).toBeNull()
    expect(mediaExpiresAt(null)).toBeNull()
    expect(mediaExpiresAt('https://plain.test/photo')).toBeNull()
    expect(mediaExpiresAt({ expiresAt: 'invalid' })).toBeNull()
    const media = { expiresAt: 2_000_000_000_000 }
    expect(annotateMediaExpiry(media)).toEqual({ ...media, mediaExpiresAt: 2_000_000_000_000 })
    const annotated = { ...media, mediaExpiresAt: 2_000_000_000_000 }
    expect(annotateMediaExpiry(annotated)).toBe(annotated)
    expect(annotateMediaExpiry('legacy')).toBe('legacy')
  })

  it('covers every legacy URL and identifier fallback', () => {
    expect(cdnUrl('')).toBe('')
    expect(cdnUrl('relative/key')).toMatch(/\/relative\/key$/)
    expect(albumCoverUrl({ coverImageUrl: 'https://x.test/cover' })).toBe('https://x.test/cover')
    expect(albumCoverUrl(null)).toBe('')
    expect(mediaThumbnailUrl('https://x.test/string')).toBe('https://x.test/string')
    expect(mediaThumbnailUrl({ url: 'https://x.test/url' })).toBe('https://x.test/url')
    expect(mediaThumbnailUrl(null)).toBe('')
    expect(mediaDisplayUrl('https://x.test/string')).toBe('https://x.test/string')
    expect(mediaDisplayUrl({ key: 'relative' })).toMatch(/\/relative$/)
    expect(mediaHlsUrl(null)).toBe('')
    expect(mediaId('opaque')).toBe('opaque')
    expect(mediaId({ rawKey: 'raw' })).toBe('raw')
    expect(mediaId({ key: 'key' })).toBe('key')
    expect(mediaFileName({ id: '/' }, 'fallback.bin')).toBe('fallback.bin')
  })

  it('uses successful and legacy download responses and creates a disposable anchor', async () => {
    await expect(resolveMediaDownloadUrl(() => Promise.resolve({ downloadUrl: 'https://x.test/new' }), {}))
      .resolves.toBe('https://x.test/new')
    await expect(resolveMediaDownloadUrl(() => Promise.resolve({ url: 'https://x.test/newer' }), {}))
      .resolves.toBe('https://x.test/newer')
    const notFound = Object.assign(new Error('missing'), { status: 404 })
    await expect(resolveMediaDownloadUrl(() => Promise.reject(notFound), 'https://x.test/legacy'))
      .resolves.toBe('https://x.test/legacy')
    await expect(resolveMediaDownloadUrl(() => Promise.reject(notFound), null)).rejects.toBe(notFound)

    const click = vi.fn()
    const original = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const element = original(tag)
      if (tag === 'a') element.click = click
      return element
    })
    startBrowserDownload('https://x.test/file', 'file.jpg')
    expect(click).toHaveBeenCalledOnce()
    expect(document.querySelector('a[href="https://x.test/file"]')).toBeNull()
  })
})

describe('scroll memory and restoration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0, writable: true })
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  })

  afterEach(() => vi.useRealTimers())

  it('remembers reveal, horizontal, and vertical positions and ignores empty keys', () => {
    expect(isRevealed('public-card')).toBe(false)
    markAsRevealed()
    markAsRevealed('public-card')
    expect(isRevealed('public-card')).toBe(true)
    expect(isRevealed('')).toBe(false)
    saveHorizontalScroll('', 4)
    expect(getHorizontalScroll('')).toBeUndefined()
    saveHorizontalScroll('row', 42)
    expect(getHorizontalScroll('row')).toBe(42)
    window.scrollY = 88
    saveVerticalScroll('/gallery')
    expect(getSavedScroll('/gallery')).toBe(88)
  })

  it('records scroll events and restores POP navigation twice', () => {
    window.scrollY = 135
    const first = renderHook(() => useScrollRestoration('/restore', false))
    window.dispatchEvent(new Event('scroll'))
    first.unmount()

    renderHook(() => useScrollRestoration('/restore', true))
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 135, behavior: 'instant' })
    act(() => vi.advanceTimersByTime(10))
    expect(window.scrollTo).toHaveBeenCalledTimes(2)
  })

  it('does not scroll when a POP route has no saved position', () => {
    renderHook(() => useScrollRestoration('/never-visited', true))
    expect(window.scrollTo).not.toHaveBeenCalled()
  })
})

describe('useMediaExpiryRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('refreshes once near the earliest expiry and suppresses a duplicate expiry', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const expiry = Date.now() + 35_000
    const { result } = renderHook(() => useMediaExpiryRefresh([
      { expiresAt: expiry + 20_000 },
      { expiresAt: expiry },
    ], refresh))
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(refresh).toHaveBeenCalledWith('expiry')
    await expect(result.current('expiry')).resolves.toBe(false)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('deduplicates in-flight requests, applies error cooldown, and converts failures to false', async () => {
    let release
    const refresh = vi.fn(() => new Promise((resolve) => { release = resolve }))
    const { result, rerender } = renderHook(({ callback }) => useMediaExpiryRefresh([], callback), {
      initialProps: { callback: refresh },
    })
    let first
    await act(async () => {
      first = result.current('media-error')
      expect(result.current('media-error')).toBe(first)
      await Promise.resolve()
      release()
      await first
    })
    await expect(result.current('media-error')).resolves.toBe(false)

    vi.advanceTimersByTime(15_000)
    const failing = vi.fn().mockRejectedValue(new Error('refresh failed'))
    rerender({ callback: failing })
    await expect(result.current('manual-error')).resolves.toBe(false)
    expect(failing).toHaveBeenCalledWith('manual-error')
  })

  it('does not schedule refresh without expiry', () => {
    const refresh = vi.fn()
    renderHook(() => useMediaExpiryRefresh([{ url: 'https://plain.test' }], refresh))
    vi.runAllTimers()
    expect(refresh).not.toHaveBeenCalled()
  })
})
