import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useMediaExpiryRefresh } from './useMediaExpiryRefresh'

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-23T21:00:00Z'))
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })
const advance = ms => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const expiring = () => [{ mediaExpiresAt: Date.now() + 31000 }]

it('retries a failed expiry refresh and stops after successful recovery', async () => {
    const refresh = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    const items = expiring()
    renderHook(() => useMediaExpiryRefresh(items, refresh))
    await advance(1000); expect(refresh).toHaveBeenCalledTimes(1)
    await advance(15000); expect(refresh).toHaveBeenCalledTimes(2)
    await advance(120000); expect(refresh).toHaveBeenCalledTimes(2)
    expect(refresh.mock.calls[1][0]).toBe('expiry')
})

it('bounds automatic backoff and resumes on connectivity without a retry storm', async () => {
    const refresh = vi.fn().mockRejectedValue(new Error('outage'))
    const items = expiring()
    renderHook(() => useMediaExpiryRefresh(items, refresh))
    await advance(300000); expect(refresh).toHaveBeenCalledTimes(4)
    await act(async () => { window.dispatchEvent(new Event('online')) })
    expect(refresh).toHaveBeenCalledTimes(5)
    await act(async () => { for (let i = 0; i < 20; i++) window.dispatchEvent(new Event('online')) })
    expect(refresh).toHaveBeenCalledTimes(5)
    refresh.mockResolvedValue(undefined)
    await advance(15000); expect(refresh).toHaveBeenCalledTimes(6)
    await advance(300000); expect(refresh).toHaveBeenCalledTimes(6)
})

it('defers offline and hidden expiry work until the browser can use it', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const refresh = vi.fn().mockResolvedValue(undefined), items = expiring()
    renderHook(() => useMediaExpiryRefresh(items, refresh))
    await advance(60000); expect(refresh).not.toHaveBeenCalled()
    online.mockReturnValue(true)
    await act(async () => { window.dispatchEvent(new Event('online')) })
    expect(refresh).not.toHaveBeenCalled()
    visible.mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(refresh).toHaveBeenCalledTimes(1)
})

it('deduplicates media errors, keeps their cause during retry, and aborts on unmount', async () => {
    let reject
    const refresh = vi.fn().mockImplementationOnce(() => new Promise((_, fail) => { reject = fail })).mockResolvedValue(undefined)
    const items = expiring(), { result, unmount } = renderHook(() => useMediaExpiryRefresh(items, refresh))
    let first, second
    await act(async () => { first = result.current('media-error'); second = result.current('media-error') })
    expect(first).toBe(second); expect(refresh).toHaveBeenCalledTimes(1)
    await act(async () => { reject(new Error('offline')); await first })
    await advance(15000)
    expect(refresh.mock.calls[1][0]).toBe('media-error')
    const signal = refresh.mock.calls[1][1].signal
    unmount(); expect(signal.aborted).toBe(true)
    await advance(60000); expect(refresh).toHaveBeenCalledTimes(2)
})

it('cancels obsolete account/album work and ignores its late completion', async () => {
    let resolveOld
    const old = vi.fn(() => new Promise(resolve => { resolveOld = resolve }))
    const fresh = vi.fn().mockResolvedValue(undefined), items = expiring()
    const { rerender } = renderHook(({ refresh }) => useMediaExpiryRefresh(items, refresh), { initialProps: { refresh: old } })
    await advance(1000)
    const signal = old.mock.calls[0][1].signal
    rerender({ refresh: fresh }); expect(signal.aborted).toBe(true)
    await advance(0); expect(fresh).toHaveBeenCalledTimes(1)
    await act(async () => { resolveOld() })
    await advance(120000); expect(fresh).toHaveBeenCalledTimes(1)
})

it('retains the expiry timer after a successful earlier image-error refresh', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const items = [{ mediaExpiresAt: Date.now() + 90000 }]
    const { result } = renderHook(() => useMediaExpiryRefresh(items, refresh))
    await act(async () => { await result.current('media-error') })
    await advance(60000); expect(refresh.mock.calls.map(call => call[0])).toEqual(['media-error', 'expiry'])
})


it('keeps an expiry refresh scheduled when it falls inside the image-error cooldown', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const items = [{ mediaExpiresAt: Date.now() + 35000 }]
    const { result } = renderHook(() => useMediaExpiryRefresh(items, refresh))
    await act(async () => { await result.current('media-error') })
    await advance(5000); expect(refresh).toHaveBeenCalledTimes(1)
    await advance(10000); expect(refresh).toHaveBeenCalledTimes(2)
})
