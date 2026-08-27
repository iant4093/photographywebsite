import { afterEach, describe, expect, it, vi } from 'vitest'
import { showPrintOrderModal } from '../components/PrintOrderModalHost'
import { configuredPrintOrigin, openPrintOrder } from './printOrders'

vi.mock('../components/PrintOrderModalHost', () => ({ showPrintOrderModal: vi.fn() }))

describe('Fotomoto print launcher', () => {
    afterEach(() => vi.restoreAllMocks())

    it('opens the isolated print origin in the in-site dialog with the capability in a fragment', async () => {
        const token = `v1.${'a'.repeat(90)}.${'b'.repeat(43)}`

        const src = await openPrintOrder(() => Promise.resolve({ sessionToken: token }))

        expect(src).toBe(`${configuredPrintOrigin()}/print.html#session=${encodeURIComponent(token)}`)
        expect(showPrintOrderModal).toHaveBeenCalledWith(src)
    })

    it('fails clearly without opening a dialog when session preparation fails', async () => {
        await expect(openPrintOrder(null)).rejects.toThrow(/session request/i)
        await expect(openPrintOrder(() => Promise.reject(new Error('offline')))).rejects.toThrow('offline')
        expect(showPrintOrderModal).not.toHaveBeenCalled()
    })

    it('rejects an invalid capability without dispatching the print dialog', async () => {
        await expect(openPrintOrder(() => Promise.resolve({ sessionToken: 'short' }))).rejects.toThrow(/invalid/i)
        expect(showPrintOrderModal).not.toHaveBeenCalled()
    })
})
