import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import useMuseumPreparation from './useMuseumPreparation'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('prepares the restored bay first and stages one nearby room at a time after entry', async () => {
    vi.useFakeTimers()
    const rooms = Array.from({ length: 6 }, (_, index) => ({ id: String(index), centerZ: index * 20 }))
    let finish
    const prepare = vi.fn(() => new Promise(resolve => { finish = resolve }))
    const props = { rooms, initialIds: ['4', '5'], nearbyIds: ['4'], enabled: false, busy: () => false, prepare, onError: vi.fn() }
    const { result, rerender, unmount } = renderHook(useMuseumPreparation, { initialProps: props })
    expect([...result.current.constructed]).toEqual(['4', '5'])
    await act(async () => vi.advanceTimersByTime(1000))
    expect(prepare).not.toHaveBeenCalled()
    rerender({ ...props, enabled: true })
    await act(async () => vi.advanceTimersByTime(250))
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(prepare.mock.calls[0][0].id).toBe('3')
    expect(result.current.constructed.has('3')).toBe(true)
    expect(result.current.ready.has('3')).toBe(false)
    await act(async () => vi.advanceTimersByTime(1000))
    expect(prepare).toHaveBeenCalledTimes(1)
    await act(async () => finish())
    expect(result.current.ready.has('3')).toBe(true)
    await act(async () => vi.advanceTimersByTime(250))
    expect(prepare.mock.calls[1][0].id).toBe('2')
    const signal = prepare.mock.calls[1][1]
    unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => finish())
    expect(vi.getTimerCount()).toBe(0)
})

it('defers hidden or busy work, handles failures, and resets when the catalog changes', async () => {
    vi.useFakeTimers()
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    const rooms = [0, 1, 2].map(id => ({ id }))
    const busy = vi.fn(() => true)
    const onError = vi.fn()
    const prepare = vi.fn().mockRejectedValue(new Error('GPU unavailable'))
    const props = { rooms, initialIds: ['invalid'], enabled: true, busy, prepare, onError }
    const { result, rerender } = renderHook(useMuseumPreparation, { initialProps: props })
    expect([...result.current.ready]).toEqual([0, 1])
    await act(async () => vi.advanceTimersByTime(250))
    expect(prepare).not.toHaveBeenCalled()
    hidden.mockReturnValue(false)
    await act(async () => vi.advanceTimersByTime(200))
    expect(prepare).not.toHaveBeenCalled()
    busy.mockReturnValue(false)
    await act(async () => vi.advanceTimersByTime(200))
    expect(onError).toHaveBeenCalledOnce()
    expect(result.current.ready.has(2)).toBe(false)
    rerender({ ...props, rooms: [{ id: 'new' }] })
    expect([...result.current.constructed]).toEqual(['new'])
    await act(async () => vi.advanceTimersByTime(1000))
    expect(prepare).toHaveBeenCalledOnce()
})


it('prepares an approaching bay even while movement remains held', async () => {
    vi.useFakeTimers()
    const rooms = ['a', 'b', 'c', 'd'].map(id => ({ id }))
    const prepare = vi.fn().mockResolvedValue()
    const props = { rooms, initialIds: ['a', 'b'], nearbyIds: ['c'], enabled: true, busy: () => true, prepare, onError: vi.fn() }
    const { result } = renderHook(useMuseumPreparation, { initialProps: props })
    await act(async () => vi.advanceTimersByTime(250))
    expect(result.current.ready.has('c')).toBe(true)
    await act(async () => vi.advanceTimersByTime(1000))
    expect(prepare).toHaveBeenCalledOnce()
    expect(result.current.constructed.has('d')).toBe(false)
})
