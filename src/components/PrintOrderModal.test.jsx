import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { showPrintOrderModal } from './PrintOrderModalHost'
import { configuredPrintOrigin } from '../utils/printOrders'

function openPrintModal(path = '/print.html#session=capability') {
    act(() => showPrintOrderModal(`${configuredPrintOrigin()}${path}`))
}

describe('PrintOrderModal', () => {
    afterEach(() => {
        document.body.style.overflow = ''
        document.documentElement.removeAttribute('data-lightbox-scroll-lock')
    })

    it('embeds the isolated print bridge and closes back to the invoking control', async () => {
        const trigger = document.createElement('button')
        trigger.textContent = 'Order a Print'
        document.body.append(trigger)
        trigger.focus()
        openPrintModal()

        const dialog = await screen.findByRole('dialog', { name: 'Print options' })
        const frame = screen.getByTitle('Fotomoto print options')
        expect(dialog).toBeInTheDocument()
        expect(frame).toHaveAttribute('src', `${configuredPrintOrigin()}/print.html#session=capability`)
        expect(frame).toHaveFocus()
        expect(screen.queryByRole('button', { name: /close print options/i })).toBeNull()

        fireEvent(window, new MessageEvent('message', {
            origin: configuredPrintOrigin(),
            source: frame.contentWindow,
            data: { type: 'ian-photography:close-print-dialog' },
        }))
        expect(screen.queryByRole('dialog', { name: 'Print options' })).not.toBeInTheDocument()
        expect(trigger).toHaveFocus()
        trigger.remove()
    })

    it('closes with Escape and ignores untrusted frame destinations', async () => {
        expect(showPrintOrderModal()).toBe(false)
        expect(showPrintOrderModal(42)).toBe(false)
        expect(showPrintOrderModal('not a URL')).toBe(false)
        expect(showPrintOrderModal(`${configuredPrintOrigin()}/another-page.html#session=capability`)).toBe(false)
        expect(showPrintOrderModal('https://untrusted.example/print.html#session=capability')).toBe(false)
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

        openPrintModal()
        expect(await screen.findByRole('dialog')).toBeInTheDocument()
        const frame = screen.getByTitle('Fotomoto print options')
        fireEvent(window, new MessageEvent('message', {
            origin: 'https://untrusted.example',
            source: frame.contentWindow,
            data: { type: 'ian-photography:close-print-dialog' },
        }))
        expect(screen.getByRole('dialog')).toBeInTheDocument()
        fireEvent.keyDown(window, { key: 'Escape' })
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('reveals the bridge after load, traps focus, and closes from the backdrop', async () => {
        openPrintModal()

        const dialog = await screen.findByRole('dialog', { name: 'Print options' })
        const frame = screen.getByTitle('Fotomoto print options')
        const loading = screen.getByRole('status')

        fireEvent.load(frame)
        expect(frame).toHaveClass('is-loaded')
        expect(loading).toHaveClass('is-hidden')

        fireEvent.keyDown(window, { key: 'Tab' })
        expect(frame).toHaveFocus()
        fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
        expect(frame).toHaveFocus()

        fireEvent.mouseDown(dialog.firstElementChild)
        expect(screen.getByRole('dialog')).toBeInTheDocument()
        fireEvent.mouseDown(dialog)
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('preserves an existing lightbox lock and restores background dialog accessibility', async () => {
        document.documentElement.setAttribute('data-lightbox-scroll-lock', '')
        document.body.style.overflow = 'clip'
        const retained = document.createElement('section')
        retained.setAttribute('role', 'dialog')
        retained.setAttribute('aria-hidden', 'false')
        retained.setAttribute('inert', '')
        const restored = document.createElement('section')
        restored.setAttribute('role', 'dialog')
        document.body.append(retained, restored)
        openPrintModal()
        await screen.findByRole('dialog', { name: 'Print options' })
        expect(document.body.style.overflow).toBe('clip')
        expect(retained).toHaveAttribute('aria-hidden', 'true')
        expect(restored).toHaveAttribute('inert')

        const frame = screen.getByTitle('Fotomoto print options')
        fireEvent(window, new MessageEvent('message', {
            origin: configuredPrintOrigin(),
            source: frame.contentWindow,
            data: { type: 'ian-photography:close-print-dialog' },
        }))
        expect(document.body.style.overflow).toBe('clip')
        expect(retained).toHaveAttribute('aria-hidden', 'false')
        expect(retained).toHaveAttribute('inert')
        expect(restored).not.toHaveAttribute('aria-hidden')
        expect(restored).not.toHaveAttribute('inert')
        retained.remove()
        restored.remove()
    })
})
