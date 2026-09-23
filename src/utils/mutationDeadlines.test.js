import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestAuthentication } from './authActions'
import { completeAlbumMutation } from './albumMutation'

const input = { email: 'test@example.com', password: 'example', turnstileToken: 'test' }
beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('authentication transport deadlines', () => {
  it.each(['headers', 'body'])('bounds stalled %s without replaying credentials', async stage => {
    const json = vi.fn(() => new Promise(() => {}))
    const fetch = vi.fn(() => stage === 'headers' ? new Promise(() => {}) : Promise.resolve({ ok: true, json }))
    vi.stubGlobal('fetch', fetch)
    const result = requestAuthentication('login', input, { timeoutMs: 50 })
    const rejected = expect(result).rejects.toThrow('temporarily unavailable')
    await vi.advanceTimersByTimeAsync(50)
    await rejected
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cancels a stalled body and rejects a pre-cancelled request before transport', async () => {
    const controller = new AbortController()
    const fetch = vi.fn(async () => ({ ok: true, json: () => new Promise(() => {}) }))
    vi.stubGlobal('fetch', fetch)
    const result = requestAuthentication('mfa', { ...input, signal: controller.signal })
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve(); controller.abort(); await rejected
    await expect(requestAuthentication('login', { ...input, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cleans up successful transport without cancelling its caller', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ AuthenticationResult: { IdToken: 'result' } }) })))
    await expect(requestAuthentication('login', { ...input, signal: controller.signal })).resolves.toEqual({ AuthenticationResult: { IdToken: 'result' } })
    expect(controller.signal.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('automatic save continuation', () => {
  it('continues pending work and explicit contention until the original save completes', async () => {
    const request = vi.fn().mockResolvedValueOnce({ pending: true }).mockRejectedValueOnce({ code: 'MEDIA_BUSY' }).mockResolvedValue({ complete: true })
    const result = completeAlbumMutation(request, undefined, { delayMs: 10 })
    await vi.advanceTimersByTimeAsync(30)
    await expect(result).resolves.toEqual({ complete: true })
    expect(request).toHaveBeenCalledTimes(3)
  })
  it('does not replay uncertain errors', async () => {
    const request = vi.fn().mockRejectedValue(new Error('network failure'))
    await expect(completeAlbumMutation(request)).rejects.toThrow('network failure')
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('honors server delays and backs off subsequent browser polls', async () => {
    const request = vi.fn().mockResolvedValueOnce({ pending: true, retryAfter: 15 })
      .mockRejectedValueOnce({ code: 'MEDIA_BUSY', retryAfterMs: 20_000 }).mockResolvedValue({ complete: true })
    const result = completeAlbumMutation(request)
    await vi.advanceTimersByTimeAsync(14_999)
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(request).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(19_999)
    expect(request).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await expect(result).resolves.toEqual({ complete: true })
  })
  it('accepts deletion completed by the worker only after an explicit pending receipt', async () => {
    const missing = { status: 404, code: 'HTTP_404' }
    const request = vi.fn().mockResolvedValueOnce({ pending: true }).mockRejectedValue(missing)
    const result = completeAlbumMutation(request, undefined, { missingAfterPending: true })
    await vi.advanceTimersByTimeAsync(1000)
    await expect(result).resolves.toEqual({ complete: true })
    await expect(completeAlbumMutation(request, undefined, { missingAfterPending: true })).rejects.toBe(missing)
    const edit = completeAlbumMutation(vi.fn().mockResolvedValueOnce({ pending: true }).mockRejectedValue(missing))
    const rejected = expect(edit).rejects.toBe(missing)
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
  })
  it('bounds repeated contention and stops after cancellation', async () => {
    const request = vi.fn().mockResolvedValue({ pending: true })
    const result = completeAlbumMutation(request, undefined, { timeoutMs: 20, delayMs: 10 })
    const rejected = expect(result).rejects.toThrow('still being completed')
    await vi.advanceTimersByTimeAsync(20); await rejected
    const controller = new AbortController()
    const cancelled = completeAlbumMutation(request, controller.signal)
    const aborted = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve(); controller.abort(); await aborted
    expect(vi.getTimerCount()).toBe(0)
  })
})
