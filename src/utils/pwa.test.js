import { describe, expect, it, vi } from 'vitest'
import { registerPwa } from './pwa'

describe('PWA registration', () => {
    it('registers a release-addressed worker and checks for updates', async () => {
        document.documentElement.dataset.releaseSha = 'abc123'
        const registration = { update: vi.fn().mockResolvedValue(undefined) }
        const serviceWorker = { register: vi.fn().mockResolvedValue(registration) }
        await expect(registerPwa(serviceWorker)).resolves.toBe(registration)
        expect(serviceWorker.register).toHaveBeenCalledWith('/service-worker.js?v=abc123', {
            scope: '/', updateViaCache: 'none',
        })
        expect(registration.update).toHaveBeenCalledOnce()
        window.dispatchEvent(new Event('focus'))
        expect(registration.update).toHaveBeenCalledTimes(2)
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
        expect(registration.update).toHaveBeenCalledTimes(2)
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
        document.dispatchEvent(new Event('visibilitychange'))
        expect(registration.update).toHaveBeenCalledTimes(3)
        delete document.documentElement.dataset.releaseSha
    })

    it('uses a stable worker address without a release and ignores update failures', async () => {
        const registration = { update: vi.fn().mockRejectedValue(new Error('offline')) }
        const serviceWorker = { register: vi.fn().mockResolvedValue(registration) }
        await expect(registerPwa(serviceWorker)).resolves.toBe(registration)
        expect(serviceWorker.register).toHaveBeenCalledWith('/service-worker.js?v=stable', {
            scope: '/', updateViaCache: 'none',
        })
    })

    it('does nothing when service workers are unavailable', async () => {
        await expect(registerPwa(null)).resolves.toBeNull()
    })
})
