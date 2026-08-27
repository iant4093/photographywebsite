import { afterEach, describe, expect, it, vi } from 'vitest'
import { configuredPrintOrigin, openPrintOrder, PRINT_ORDER_OPEN_EVENT } from './printOrders'

describe('Fotomoto print launcher', () => {
    afterEach(() => vi.restoreAllMocks())

    it('opens the isolated print origin in the in-site dialog with the capability in a fragment', async () => {
        const opened = vi.fn()
        window.addEventListener(PRINT_ORDER_OPEN_EVENT, opened, { once: true })
        const token = `v1.${'a'.repeat(90)}.${'b'.repeat(43)}`

        const src = await openPrintOrder(() => Promise.resolve({ sessionToken: token }))

        expect(src).toBe(`${configuredPrintOrigin()}/print.html#session=${encodeURIComponent(token)}`)
        expect(opened).toHaveBeenCalledOnce()
        expect(opened.mock.calls[0][0].detail).toEqual({ src })
    })

    it('fails clearly without opening a dialog when session preparation fails', async () => {
        await expect(openPrintOrder(null)).rejects.toThrow(/session request/i)
        const opened = vi.fn()
        window.addEventListener(PRINT_ORDER_OPEN_EVENT, opened)
        await expect(openPrintOrder(() => Promise.reject(new Error('offline')))).rejects.toThrow('offline')
        expect(opened).not.toHaveBeenCalled()
        window.removeEventListener(PRINT_ORDER_OPEN_EVENT, opened)
    })

    it('rejects an invalid capability without dispatching the print dialog', async () => {
        const opened = vi.fn()
        window.addEventListener(PRINT_ORDER_OPEN_EVENT, opened)
        await expect(openPrintOrder(() => Promise.resolve({ sessionToken: 'short' }))).rejects.toThrow(/invalid/i)
        expect(opened).not.toHaveBeenCalled()
        window.removeEventListener(PRINT_ORDER_OPEN_EVENT, opened)
    })
})
