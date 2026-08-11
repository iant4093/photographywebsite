import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as api from './api'
import {
  clearCatalogSnapshots,
  getCatalogSnapshot,
  reconcilePublicCatalogItems,
  setCatalogSnapshot,
} from './catalogState'

const jsonResponse = (body, init = {}) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
  ...init,
})

describe('public API client behavior', () => {
  beforeEach(() => {
    api.clearApiCache()
    clearCatalogSnapshots()
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })
  afterEach(() => {
    api.clearApiCache()
    clearCatalogSnapshots()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('normalizes, caches, deduplicates, forces, and filters legacy catalog pages', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [{ albumId: 'one', url: 'https://x.test/a' }], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ albumId: 'forced' }], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse([
        { albumId: 'p1', visibility: 'public', type: 'photo', ownerEmail: 'owner' },
        { albumId: 'v1', visibility: 'public', type: 'video', ownerEmail: 'owner' },
        { albumId: 'private', visibility: 'private', type: 'photo', ownerEmail: 'owner' },
      ]))
    vi.stubGlobal('fetch', fetchMock)
    const params = { type: 'photo', visibility: 'public', limit: 1 }
    const [first, shared] = await Promise.all([api.fetchAlbumsPage(params), api.fetchAlbumsPage(params)])
    expect(first).toBe(shared)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('/public/albums?')
    expect(fetchMock.mock.calls[0][0]).not.toContain('visibility=')
    expect(api.readCachedAlbumsPage(params)).toBe(first)
    await expect(api.fetchAlbumsPage(params, { force: true })).resolves.toMatchObject({ items: [{ albumId: 'forced' }] })
    const legacy = await api.fetchAlbumsPage({ visibility: 'public', ownerEmail: 'owner', type: 'video', limit: 1 }, { force: true })
    expect(legacy).toEqual({ items: [expect.objectContaining({ albumId: 'v1' })], nextCursor: null })
  })

  it('paginates all albums, delegates compatibility helpers, and rejects repeated cursors', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [{ albumId: 'one' }], nextCursor: 'two' }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ albumId: 'two' }], nextCursor: null })))
    await expect(api.fetchAlbums()).resolves.toEqual([{ albumId: 'one' }, { albumId: 'two' }])

    api.clearApiCache()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [{ albumId: 'one' }], nextCursor: 'repeat' }))
      .mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: 'repeat' })))
    await expect(api.fetchAlbumsFiltered({ type: 'photo' }, 'token')).rejects.toMatchObject({ code: 'REPEATED_CURSOR' })
  })

  it('rejects malformed request and response cursors before unsafe pagination', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ items: [], nextCursor: 123 })))
    expect(() => api.fetchAlbumsPage({ cursor: 'x'.repeat(4097) })).toThrow(/cursor was invalid/i)
    await expect(api.fetchAlbumsPage()).rejects.toMatchObject({ code: 'BAD_CURSOR' })
  })

  it('normalizes album and shared media payload shapes and signed expiry metadata', async () => {
    const signed = 'https://x.test/a?X-Amz-Date=20260101T000000Z&X-Amz-Expires=60'
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ album: {}, media: { items: [{ id: 'one', url: signed }] } }))
      .mockResolvedValueOnce(jsonResponse({ album: {}, media: [{ id: 'two', url: signed }] }))
      .mockResolvedValueOnce(jsonResponse({ album: {}, images: [{ id: 'shared', url: signed }] }))
      .mockResolvedValueOnce(jsonResponse(null)))
    expect((await api.fetchAlbum('a/b')).images[0]).toHaveProperty('mediaExpiresAt')
    expect(fetch.mock.calls[0][0]).toContain('/public/albums/a%2Fb')
    expect((await api.fetchAlbum('second')).images[0].id).toBe('two')
    expect((await api.fetchSharedAlbum('code/x', 'turnstile')).images[0]).toHaveProperty('mediaExpiresAt')
    await expect(api.fetchAlbum('null')).resolves.toBeNull()
  })

  it('keeps authenticated album catalog and detail reads on the mixed compatibility routes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse({ album: {}, images: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await api.fetchAlbumsPage({ visibility: 'private' }, { token: 'token' })
    await api.fetchAlbum('private/id', 'token')
    expect(fetchMock.mock.calls[0][0]).toContain('/albums?')
    expect(fetchMock.mock.calls[0][0]).not.toContain('/public/albums')
    expect(fetchMock.mock.calls[1][0]).toContain('/albums/private%2Fid')
    expect(fetchMock.mock.calls[1][1].headers).toEqual({ Authorization: 'Bearer token' })
  })

  it('calls every mutation endpoint with encoded identifiers, authorization, JSON, and null 204 handling', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })))
    vi.stubGlobal('fetch', fetchMock)
    const signal = new AbortController().signal
    await api.requestAlbumZip('a/b', 'token', { signal })
    await api.sendContactMessage({ name: 'Ian' }, { signal })
    await api.requestSharedAlbumZip('share/code', { signal })
    await api.requestAlbumMediaDownload('a/b', 'media', 'token', { signal })
    await api.requestSharedMediaDownload('share/code', 'media', { signal })
    await api.requestUploadUrl('token', 'album', 'file.jpg', 'image/jpeg', 2, 'raw', { signal })
    await api.requestHeroUploadUrl('token', new File(['hero'], 'hero.jpg', { type: 'image/jpeg' }), { signal })
    await api.completeHeroUpload('token', '0123456789abcdef0123456789abcdef', { signal })
    await api.createAlbum('token', { title: 'A' }, { signal })
    await api.updateAlbum('token', 'a/b', { title: 'B' }, { signal })
    await api.updateGalleryOrder('token', ['one', 'two'], { signal })
    await api.addImagesToAlbum('token', 'a/b', [{ id: 'one' }], { signal })
    await api.deleteAlbum('token', 'a/b', { signal })
    await api.deleteImages('token', 'a/b', ['key'], { signal })
    await api.updateImageThumbnail('token', 'a/b', 'raw', { blurhash: 'x' }, { signal })
    await api.createUser('token', 'user+one@example.com', { signal })
    await api.deleteUser('token', 'user+one@example.com', { signal })
    await api.editUser('token', 'user+one@example.com', { enabled: true }, { signal })
    expect(fetchMock).toHaveBeenCalledTimes(18)
    expect(fetchMock.mock.calls.some(([url]) => url.includes('a%2Fb'))).toBe(true)
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/admin/hero/upload-url'))).toBe(true)
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/admin/hero/complete'))).toBe(true)
    expect(fetchMock.mock.calls.some(([url, options]) => (
      url.endsWith('/admin/gallery-order')
      && options.method === 'POST'
      && options.body === JSON.stringify({ albumIds: ['one', 'two'] })
    ))).toBe(true)
    expect(fetchMock.mock.calls.every(([, options]) => options.signal)).toBe(true)

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await expect(api.deleteAlbum('token', 'a')).resolves.toBeNull()
  })

  it('invalidates complete snapshots and overlays successful album writes immediately', async () => {
    const stale = {
      albumId: 'old', type: 'photo', visibility: 'public', title: 'Old', createdAt: '2025-01-01',
    }
    const created = {
      albumId: 'new', type: 'photo', visibility: 'public', title: 'New', createdAt: '2026-01-01',
    }
    setCatalogSnapshot('public-photos', { items: [stale], nextCursor: null })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(created, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse({ ...created, visibility: 'private' }))
      .mockResolvedValueOnce(jsonResponse({ message: 'deleted' })))

    await api.createAlbum('token', { title: 'New' })
    expect(getCatalogSnapshot('public-photos')).toBeNull()
    expect(reconcilePublicCatalogItems([stale], 'photo').map((album) => album.albumId))
      .toEqual(['new', 'old'])

    setCatalogSnapshot('public-photos', { items: [created, stale], nextCursor: null })
    await api.updateAlbum('token', 'new', { visibility: 'private' })
    expect(getCatalogSnapshot('public-photos')).toBeNull()
    expect(reconcilePublicCatalogItems([created, stale], 'photo').map((album) => album.albumId))
      .toEqual(['old'])

    await api.deleteAlbum('token', 'old')
    expect(reconcilePublicCatalogItems([created, stale], 'photo')).toEqual([])
  })

  it('keeps catalog snapshots when an album mutation fails', async () => {
    const snapshot = { items: [{ albumId: 'old' }], nextCursor: null }
    setCatalogSnapshot('public-photos', snapshot)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 })))

    await expect(api.createAlbum('token', { title: 'Failed' })).rejects.toMatchObject({ status: 503 })
    expect(getCatalogSnapshot('public-photos')).toMatchObject(snapshot)
  })

  it('paginates modern users, supports the legacy array response, and rejects loops', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ users: [{ email: 'one' }], paginationToken: 'next' }))
      .mockResolvedValueOnce(jsonResponse({ users: [{ email: 'two' }], nextCursor: null })))
    await expect(api.listUsers('token')).resolves.toEqual([{ email: 'one' }, { email: 'two' }])

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([{ email: 'legacy' }])))
    await expect(api.listUsers('token')).resolves.toEqual([{ email: 'legacy' }])

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ users: [], paginationToken: 'same' }))
      .mockResolvedValueOnce(jsonResponse({ users: [], paginationToken: 'same' })))
    await expect(api.listUsers('token')).rejects.toMatchObject({ code: 'REPEATED_CURSOR' })
  })

  it('loads admin reports with authorization and caller cancellation', async () => {
    const report = { schemaVersion: 1, months: [] }
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(report)))
    vi.stubGlobal('fetch', fetchMock)
    const signal = new AbortController().signal
    await expect(api.fetchCostReport('admin-token', { signal })).resolves.toEqual(report)
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/admin\/costs$/)
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({
      headers: { Authorization: 'Bearer admin-token' },
      signal: expect.any(AbortSignal),
    }))
    await expect(api.fetchGoogleDriveUsage('admin-token', { signal })).resolves.toEqual(report)
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/admin\/drive-usage$/)
    expect(fetchMock.mock.calls[1][1]).toEqual(expect.objectContaining({
      headers: { Authorization: 'Bearer admin-token' },
      signal: expect.any(AbortSignal),
    }))
  })

  it.each([
    [400, 'request detail'],
    [401, 'session has expired'],
    [403, 'permission'],
    [404, 'missing detail'],
    [409, 'conflict detail'],
    [413, 'too large'],
    [429, 'Too many requests'],
    [500, 'temporarily unavailable'],
  ])('maps HTTP %i to a safe user-facing error', async (status, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      status >= 500 ? 'secret' : JSON.stringify({ message: `${message}` }),
      { status, headers: { 'Content-Type': status >= 500 ? 'text/plain' : 'application/json', 'Retry-After': '2' } },
    )))
    let error
    try {
      await api.sendContactMessage({})
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ status, retryAfterMs: status === 429 ? 2000 : expect.any(Number) })
    expect(error.message).toMatch(new RegExp(message, 'i'))
  })

  it('ignores unsafe or unreadable error bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('bad', { status: 400, headers: { 'Content-Type': 'text/plain' } })))
    await expect(api.sendContactMessage({})).rejects.toThrow(/not valid/i)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ message: 'x'.repeat(201) }, { status: 404 })))
    await expect(api.sendContactMessage({})).rejects.toThrow(/not found/i)
  })

  it('retries GET status and network failures but not POST network failures', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('retry', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ album: { title: 'Recovered' }, images: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const request = api.fetchAlbum('retry')
    await vi.advanceTimersByTimeAsync(250)
    await expect(request).resolves.toMatchObject({ album: { title: 'Recovered' } })

    const network = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(jsonResponse({ album: {}, images: [] }))
    vi.stubGlobal('fetch', network)
    const second = api.fetchAlbum('network')
    await vi.advanceTimersByTimeAsync(250)
    await expect(second).resolves.toBeTruthy()

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(api.sendContactMessage({})).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
  })

  it('distinguishes caller aborts from internal timeout aborts', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError'))))))
    const caller = api.fetchAlbum('abort', null, { signal: controller.signal })
    controller.abort()
    await expect(caller).rejects.toMatchObject({ name: 'AbortError' })

    vi.useFakeTimers()
    const timed = api.fetchAlbum('timeout')
    const timedExpectation = expect(timed).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(15_000)
    await timedExpectation
  })

  it('uploads with default/required headers, retries bounded failures, and surfaces final errors', async () => {
    vi.useFakeTimers()
    const file = new File(['x'], 'x.jpg', { type: 'image/jpeg' })
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const request = api.uploadFileToS3('https://upload.test', file, {}, { retries: 2 })
    await vi.advanceTimersByTimeAsync(400)
    await vi.advanceTimersByTimeAsync(800)
    await expect(request).resolves.toBeInstanceOf(Response)
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'image/jpeg' })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 400 })))
    await expect(api.uploadFileToS3('https://upload.test', file, { 'x-amz-tagging': 'x' }, { retries: 0 }))
      .rejects.toMatchObject({ code: 'UPLOAD_FAILED', status: 400 })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(api.uploadFileToS3('https://upload.test', file, {}, { retries: 0 }))
      .rejects.toMatchObject({ code: 'UPLOAD_NETWORK_ERROR' })
    const aborted = new DOMException('aborted', 'AbortError')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(aborted))
    await expect(api.uploadFileToS3('https://upload.test', file)).rejects.toBe(aborted)
  })
})
