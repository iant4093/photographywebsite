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
        delete document.documentElement.dataset.releaseSha
    })

    it('does nothing when service workers are unavailable', async () => {
        await expect(registerPwa(null)).resolves.toBeNull()
    })
})
