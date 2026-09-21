import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import useAlbumIntent from './useAlbumIntent'
import { prefetchPublicAlbum } from '../utils/api'
import { preloadAlbumRoute } from '../utils/routePreload'
vi.mock('../utils/api', () => ({ prefetchPublicAlbum: vi.fn() }))
vi.mock('../utils/routePreload', () => ({ preloadAlbumRoute: vi.fn().mockResolvedValue({}) }))
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it('requires sustained hover, cancels stale intent, and warms immediately on focus or touch', () => {
    vi.useFakeTimers()
    const publicAlbum = { albumId: 'public', visibility: 'public' }
    const { result, rerender, unmount } = renderHook(useAlbumIntent, { initialProps: publicAlbum })
    act(() => { result.current.onMouseEnter(); vi.advanceTimersByTime(100); result.current.onMouseLeave(); vi.advanceTimersByTime(300) })
    expect(prefetchPublicAlbum).not.toHaveBeenCalled()
    act(() => { result.current.onMouseEnter(); result.current.onMouseEnter(); vi.advanceTimersByTime(250) })
    expect(prefetchPublicAlbum).toHaveBeenCalledExactlyOnceWith('public')
    expect(preloadAlbumRoute).toHaveBeenCalledWith(publicAlbum)
    act(() => { result.current.onMouseEnter() })
    rerender({ albumId: 'private', visibility: 'private' })
    act(() => { vi.advanceTimersByTime(300); result.current.onFocus(); result.current.onPointerDown() })
    expect(prefetchPublicAlbum).toHaveBeenCalledOnce()
    rerender(publicAlbum)
    vi.stubGlobal('navigator', { connection: { saveData: true } })
    act(() => { result.current.onMouseEnter(); vi.advanceTimersByTime(300) })
    expect(prefetchPublicAlbum).toHaveBeenCalledOnce()
    act(() => result.current.onFocus())
    act(() => result.current.onPointerDown())
    expect(prefetchPublicAlbum).toHaveBeenCalledTimes(3)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
})
