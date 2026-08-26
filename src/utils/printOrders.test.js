import { afterEach, describe, expect, it, vi } from 'vitest'
import { configuredPrintOrigin, openPrintOrder } from './printOrders'

describe('Fotomoto print launcher', () => {
    afterEach(() => vi.restoreAllMocks())

    it('opens synchronously, severs the opener, and passes the capability in a fragment', async () => {
        const replace = vi.fn()
        const popup = {
            closed: false,
            opener: window,
            location: { replace },
            document: {
                title: '',
                documentElement: { style: { cssText: '' } },
                body: { style: { cssText: '' }, textContent: '' },
            },
            close: vi.fn(),
        }
        vi.spyOn(window, 'open').mockReturnValue(popup)
        const token = `v1.${'a'.repeat(90)}.${'b'.repeat(43)}`

        await openPrintOrder(() => Promise.resolve({ sessionToken: token }))

        expect(window.open).toHaveBeenCalledOnce()
        expect(popup.opener).toBeNull()
        expect(replace).toHaveBeenCalledOnce()
        expect(replace).toHaveBeenCalledWith(`${configuredPrintOrigin()}/print.html#session=${encodeURIComponent(token)}`)
        expect(popup.close).not.toHaveBeenCalled()
    })

    it('fails clearly when the popup is blocked and closes on session failure', async () => {
        vi.spyOn(window, 'open').mockReturnValueOnce(null)
        await expect(openPrintOrder(vi.fn())).rejects.toThrow(/allow pop-ups/i)

        const popup = {
            closed: false,
            opener: window,
            location: { replace: vi.fn() },
            document: {
                documentElement: { style: { cssText: '' } },
                body: { style: { cssText: '' } },
            },
            close: vi.fn(),
        }
        vi.spyOn(window, 'open').mockReturnValueOnce(popup)
        await expect(openPrintOrder(() => Promise.reject(new Error('offline')))).rejects.toThrow('offline')
        expect(popup.close).toHaveBeenCalledOnce()
    })
})
