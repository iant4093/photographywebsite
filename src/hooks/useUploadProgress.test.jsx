import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useUploadProgress } from './useUploadProgress'

afterEach(() => vi.useRealTimers())

it('samples live bytes, stops on failure/finalization, ignores old sessions, and cleans up on unmount', () => {
    vi.useFakeTimers()
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const { result, unmount } = renderHook(useUploadProgress)
    const file = { size: 10_000_000 }
    let first
    act(() => { first = result.current.startUpload([file]) })
    const update = first.progressFor('0:original', file)
    update({ loaded: 0 })
    now = 2000
    update({ loaded: 2_000_000 })
    act(() => vi.advanceTimersByTime(500))
    expect(result.current.progress).toMatchObject({ bytesPerSecond: 1_000_000, remainingSeconds: 8 })
    act(() => first.stop())
    expect(vi.getTimerCount()).toBe(0)
    let second
    act(() => { second = result.current.startUpload([file, file]) })
    act(() => first.completeFile())
    expect(result.current.progress).toMatchObject({ completedFiles: 0, totalFiles: 2, loadedBytes: 0 })
    act(() => { second.completeFile(); second.finalize() })
    expect(result.current.progress.phase).toBe('saving')
    expect(vi.getTimerCount()).toBe(0)
    act(() => result.current.startUpload([file]))
    unmount()
    expect(vi.getTimerCount()).toBe(0)
})
