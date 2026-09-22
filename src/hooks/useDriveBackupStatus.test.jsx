import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useDriveBackupStatus from './useDriveBackupStatus'
import { fetchDriveBackupStatus } from '../utils/api'

vi.mock('../utils/api', () => ({ fetchDriveBackupStatus: vi.fn(), retryDriveBackup: vi.fn() }))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

describe('backup polling coordination', () => {
    beforeEach(() => { vi.useFakeTimers(); fetchDriveBackupStatus.mockReset(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false) })
    afterEach(() => vi.useRealTimers())

    it('shares the running poll across repeated tab returns and retains normal completion notifications', async () => {
        const first = deferred()
        fetchDriveBackupStatus.mockReturnValueOnce(first.promise).mockResolvedValue({ items: [{ albumId: 'a', status: 'synced' }] })
        const token = vi.fn().mockResolvedValue('token'), notify = vi.fn()
        const { result, unmount } = renderHook(() => useDriveBackupStatus(['a'], token, notify))
        await act(async () => {})
        act(() => { document.dispatchEvent(new Event('visibilitychange')); document.dispatchEvent(new Event('visibilitychange')) })
        expect(fetchDriveBackupStatus).toHaveBeenCalledTimes(1)
        await act(async () => first.resolve({ items: [{ albumId: 'a', status: 'queued' }] }))
        await act(async () => vi.advanceTimersByTimeAsync(3000))
        expect(fetchDriveBackupStatus).toHaveBeenCalledTimes(2)
        expect(result.current.statuses.a.status).toBe('synced')
        expect(notify).toHaveBeenCalledExactlyOnceWith('Google Drive backup updated.')
        unmount()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('coordinates every batch and does not start a request after unmount during token acquisition', async () => {
        const token = deferred()
        const { unmount } = renderHook(() => useDriveBackupStatus(['a'], () => token.promise, vi.fn()))
        unmount()
        await act(async () => token.resolve('token'))
        expect(fetchDriveBackupStatus).not.toHaveBeenCalled()

        const first = deferred(), second = deferred()
        fetchDriveBackupStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
        const getToken = vi.fn().mockResolvedValue('token'), notify = vi.fn()
        const ids = Array.from({ length: 101 }, (_, index) => String(index))
        const hook = renderHook(() => useDriveBackupStatus(ids, getToken, notify))
        await act(async () => {})
        await act(async () => first.resolve({ items: [] }))
        act(() => document.dispatchEvent(new Event('visibilitychange')))
        expect(fetchDriveBackupStatus).toHaveBeenCalledTimes(2)
        expect(fetchDriveBackupStatus.mock.calls.map(call => call[1].length)).toEqual([100, 1])
        hook.unmount()
        await act(async () => second.resolve({ items: [] }))
        expect(vi.getTimerCount()).toBe(0)
    })

    it('does not poll empty catalogs on tab return and still retries transient failures', async () => {
        const token = vi.fn().mockResolvedValue('token'), notify = vi.fn()
        const { rerender, unmount } = renderHook(({ ids }) => useDriveBackupStatus(ids, token, notify), { initialProps: { ids: [] } })
        act(() => document.dispatchEvent(new Event('visibilitychange')))
        expect(token).not.toHaveBeenCalled()
        fetchDriveBackupStatus.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ items: [] })
        rerender({ ids: ['a'] })
        await act(async () => {})
        await act(async () => vi.advanceTimersByTimeAsync(15000))
        expect(fetchDriveBackupStatus).toHaveBeenCalledTimes(2)
        unmount()
    })
})
