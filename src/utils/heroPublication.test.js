import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { waitForHeroPublication, HERO_PUBLISHED_EVENT } from './heroPublication'
import { fetchHeroManifest } from './mediaUrls'

vi.mock('./mediaUrls', () => ({ fetchHeroManifest: vi.fn(), HERO_PUBLISHED_EVENT: 'gallery-hero-published' }))
const version = 'a'.repeat(32)

beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('waits through an old manifest and transient failure for the exact uploaded video version', async () => {
    const manifest = { version }
    fetchHeroManifest.mockResolvedValueOnce({ version: 'b'.repeat(32) })
        .mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(manifest)
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    const result = waitForHeroPublication('video', `"${version}"`)
    await vi.advanceTimersByTimeAsync(3000)
    await expect(result).resolves.toEqual(manifest)
    expect(fetchHeroManifest).toHaveBeenCalledTimes(3)
    expect(fetchHeroManifest).toHaveBeenCalledWith({ heroType: 'video', signal: expect.any(AbortSignal) })
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: HERO_PUBLISHED_EVENT, detail: { heroType: 'video', manifest } }))
})

it('stops polling immediately on cancellation', async () => {
    fetchHeroManifest.mockResolvedValue(null)
    const controller = new AbortController()
    const result = waitForHeroPublication('photo', version, { signal: controller.signal })
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await assertion
    expect(vi.getTimerCount()).toBe(0)
})

it('reports an unconfirmed publication when the deadline expires', async () => {
    const deadline = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    fetchHeroManifest.mockResolvedValue(null)
    const result = waitForHeroPublication('photo', version)
    const assertion = expect(result).rejects.toThrow('publication has not been confirmed yet')
    await vi.advanceTimersByTimeAsync(0)
    deadline.abort(new DOMException('Timeout', 'TimeoutError'))
    await assertion
})
