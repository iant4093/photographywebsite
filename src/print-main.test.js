import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'

function printDocument() {
    document.body.innerHTML = `
        <main>
            <h1 id="print-title">Preparing your print</h1>
            <p id="print-status">Preparing…</p>
            <button id="print-reopen" type="button" hidden>Reopen print options</button>
            <a id="print-fallback" href="#" hidden>Open store</a>
        </main>
    `
}

describe('isolated Fotomoto print bridge', () => {
    beforeEach(() => {
        vi.resetModules()
        vi.restoreAllMocks()
        delete window.FOTOMOTO
        delete window.fotomoto_loaded
        document.head.querySelectorAll('script').forEach((script) => script.remove())
        printDocument()
        window.history.replaceState(null, '', '/print.html')
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        delete window.FOTOMOTO
        delete window.fotomoto_loaded
    })

    it('rejects a missing capability without loading the vendor script', async () => {
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)

        await import('./print-main.js')

        await waitFor(() => expect(document.getElementById('print-title')).toHaveTextContent('Print store unavailable'))
        expect(document.getElementById('print-fallback')).not.toHaveAttribute('hidden')
        expect(fetchMock).not.toHaveBeenCalled()
        expect(document.querySelector('script[src*="fotomoto.com"]')).toBeNull()
    })

    it('rejects an oversized capability before making a request', async () => {
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)
        window.history.replaceState(null, '', `/print.html#session=${'a'.repeat(2049)}`)

        await import('./print-main.js')

        await waitFor(() => expect(document.getElementById('print-title')).toHaveTextContent('Print store unavailable'))
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('redeems the capability before loading Fotomoto and opens only the staged reference', async () => {
        const imageUrl = 'https://media.example.invalid/fotomoto/references/opaque_web.jpg'
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: vi.fn().mockResolvedValue({ imageUrl }),
        })
        const showWindow = vi.fn()
        vi.stubGlobal('fetch', fetchMock)
        window.history.replaceState(null, '', '/print.html#session=short-lived-capability')

        await import('./print-main.js')

        await waitFor(() => expect(document.querySelector('script[src*="widget.fotomoto.com"]')).not.toBeNull())
        window.FOTOMOTO = { API: { PRINT: 'PRINT', showWindow } }
        window.fotomoto_loaded()

        await waitFor(() => expect(showWindow).toHaveBeenCalledWith('PRINT', imageUrl))
        expect(document.getElementById('print-reopen')).not.toHaveAttribute('hidden')
        document.getElementById('print-reopen').click()
        expect(showWindow).toHaveBeenCalledTimes(2)
        expect(showWindow).toHaveBeenLastCalledWith('PRINT', imageUrl)
        // A late network event must not settle the already-opened widget twice.
        document.querySelector('script[src*="widget.fotomoto.com"]').onerror()
        expect(fetchMock).toHaveBeenCalledWith('/api/print/session', expect.objectContaining({
            method: 'POST',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
        }))
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
            sessionToken: 'short-lived-capability',
        })
        expect(window.location.hash).toBe('')
    })

    it('shows a retry path when an expired capability is rejected', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
        window.history.replaceState(null, '', '/print.html#session=expired-capability')

        await import('./print-main.js')

        await waitFor(() => expect(document.getElementById('print-title')).toHaveTextContent('Print store unavailable'))
        expect(document.getElementById('print-status')).toHaveTextContent('expired')
        expect(document.getElementById('print-fallback')).not.toHaveAttribute('hidden')
        expect(document.querySelector('script[src*="fotomoto.com"]')).toBeNull()
    })

    it('refuses a non-HTTPS staged image before loading Fotomoto', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: vi.fn().mockResolvedValue({ imageUrl: 'http://media.example.invalid/reference.jpg' }),
        }))
        window.history.replaceState(null, '', '/print.html#session=valid-looking-capability')

        await import('./print-main.js')

        await waitFor(() => expect(document.getElementById('print-status')).toHaveTextContent('not prepared correctly'))
        expect(document.querySelector('script[src*="fotomoto.com"]')).toBeNull()
    })

    it('reports a vendor initialization that does not expose the API', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: vi.fn().mockResolvedValue({
                imageUrl: 'https://media.example.invalid/fotomoto/references/opaque_web.jpg',
            }),
        }))
        window.history.replaceState(null, '', '/print.html#session=valid-looking-capability')

        await import('./print-main.js')

        await waitFor(() => expect(document.querySelector('script[src*="widget.fotomoto.com"]')).not.toBeNull())
        window.fotomoto_loaded()
        await waitFor(() => expect(document.getElementById('print-status')).toHaveTextContent('did not initialize'))
    })

    it('reports a blocked Fotomoto script without exposing the staged image', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: vi.fn().mockResolvedValue({
                imageUrl: 'https://media.example.invalid/fotomoto/references/opaque_web.jpg',
            }),
        }))
        window.history.replaceState(null, '', '/print.html#session=valid-looking-capability')

        await import('./print-main.js')

        const script = await waitFor(() => {
            const candidate = document.querySelector('script[src*="widget.fotomoto.com"]')
            expect(candidate).not.toBeNull()
            return candidate
        })
        script.onerror()
        await waitFor(() => expect(document.getElementById('print-status')).toHaveTextContent('could not be loaded'))
    })

    it('uses a safe generic message for an unclassified redemption failure', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(null))
        window.history.replaceState(null, '', '/print.html#session=valid-looking-capability')

        await import('./print-main.js')

        await waitFor(() => expect(document.getElementById('print-status')).toHaveTextContent('Return to the photograph'))
    })
})
