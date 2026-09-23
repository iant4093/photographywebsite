import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, fetchAlbumMediaPage } from './api'
import { persistentStorage, tabStorage } from './browserStorage'
import { AuthProvider } from '../context/authContext'
import { uploadWithProgress } from './uploadTransport'
import { pollZipJob } from './zipDownload'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('request and browser failure recovery', () => {
    it('keeps the API deadline until the response body has finished', async () => {
        vi.useFakeTimers()
        vi.stubGlobal('fetch', vi.fn(async (_url, { signal }) => ({
            ok: true, status: 200,
            json: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })),
        })))
        const request = apiFetch('/test', {}, { timeoutMs: 25, retries: 0 })
        const rejected = expect(request).rejects.toMatchObject({ code: 'TIMEOUT' })
        await vi.advanceTimersByTimeAsync(26)
        await rejected
        expect(vi.getTimerCount()).toBe(0)
    })

    it('removes abort subscriptions after successful responses', async () => {
        const controller = new AbortController()
        const add = vi.spyOn(controller.signal, 'addEventListener')
        const remove = vi.spyOn(controller.signal, 'removeEventListener')
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}')))
        await apiFetch('/test', { signal: controller.signal })
        expect(add).toHaveBeenCalledTimes(1)
        expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1])
    })

    it('renders public content signed out when storage properties are blocked', async () => {
        for (const name of ['localStorage', 'sessionStorage']) {
            vi.spyOn(window, name, 'get').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
        }
        render(<AuthProvider><p>Public gallery</p></AuthProvider>)
        await waitFor(() => expect(screen.getByText('Public gallery')).toBeInTheDocument())
        expect(persistentStorage.keys()).toEqual([])
        expect(tabStorage.getItem('token')).toBeNull()
        expect(() => persistentStorage.setItem('token', 'secret')).toThrow('storage is unavailable')
        expect(() => persistentStorage.removeItem('token')).not.toThrow()
    })

    it('resumes only a server-recorded deletion when reopening the media manager', async () => {
        const fetch = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ album: { albumId: 'a' }, items: [], pendingDeletionKeys: ['old.jpg'] })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ deletedCount: 1 })))
        vi.stubGlobal('fetch', fetch)
        const page = await fetchAlbumMediaPage('token', 'a')
        expect(page.items).toEqual([])
        expect(fetch).toHaveBeenCalledTimes(2)
        expect(fetch.mock.calls[1][0]).toContain('/albums/a/delete-images')
        expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ keys: ['old.jpg'] })
    })

    it('waits the complete ZIP cooldown and never polls beyond its lifetime', async () => {
        for (const maxDurationMs of [600_000, 120_000]) {
            let time = 0
            const request = vi.fn()
                .mockRejectedValueOnce({ status: 429, retryAfterMs: 300_000 })
                .mockResolvedValue({ status: 'ready', url: 'https://download.test/file' })
            const result = pollZipJob({ jobKey: 'cooldown', request, now: () => time, maxDurationMs,
                storage: { getItem: () => null, setItem() {}, removeItem() {} },
                sleep: async delay => { time += delay } })
            if (maxDurationMs > 300_000) {
                await expect(result).resolves.toContain('download.test')
                expect(time).toBe(300_000)
                expect(request).toHaveBeenCalledTimes(2)
            } else {
                await expect(result).rejects.toMatchObject({ code: 'ZIP_TIMEOUT' })
                expect(request).toHaveBeenCalledTimes(1)
            }
        }
    })

    it('times out stalled uploads but permits a long transfer while bytes keep moving', async () => {
        vi.useFakeTimers()
        let xhr
        vi.stubGlobal('XMLHttpRequest', class {
            upload = {}
            status = 200
            responseText = ''
            constructor() { xhr = this }
            open() {}
            setRequestHeader() {}
            getAllResponseHeaders() { return '' }
            send() {}
            abort() { this.onabort() }
        })
        const options = { onProgress: vi.fn(), stallTimeoutMs: 1000 }
        const stalled = uploadWithProgress('/upload', new Blob(['abc']), {}, options)
        const rejected = expect(stalled).rejects.toThrow('stalled')
        await vi.advanceTimersByTimeAsync(1000)
        await rejected
        const active = uploadWithProgress('/upload', new Blob(['abcde']), {}, options)
        for (let loaded = 1; loaded < 5; loaded++) {
            await vi.advanceTimersByTimeAsync(900)
            xhr.upload.onprogress({ loaded })
        }
        xhr.onload()
        await expect(active).resolves.toMatchObject({ status: 200 })
        expect(vi.getTimerCount()).toBe(0)
    })
})
