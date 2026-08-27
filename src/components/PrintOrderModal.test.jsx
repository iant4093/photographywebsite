import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import PrintOrderModal from './PrintOrderModal'
import { configuredPrintOrigin, PRINT_ORDER_OPEN_EVENT } from '../utils/printOrders'

function openPrintModal(path = '/print.html#session=capability') {
    fireEvent(window, new CustomEvent(PRINT_ORDER_OPEN_EVENT, {
        detail: { src: `${configuredPrintOrigin()}${path}` },
    }))
}

describe('PrintOrderModal', () => {
    afterEach(() => {
        document.body.style.overflow = ''
        document.documentElement.removeAttribute('data-lightbox-scroll-lock')
    })

    it('embeds the isolated print bridge and closes back to the invoking control', () => {
        const trigger = document.createElement('button')
        trigger.textContent = 'Order a Print'
        document.body.append(trigger)
        trigger.focus()
        render(<PrintOrderModal />)

        openPrintModal()

        const dialog = screen.getByRole('dialog', { name: 'Print options' })
        const frame = screen.getByTitle('Fotomoto print options')
        expect(dialog).toBeInTheDocument()
        expect(frame).toHaveAttribute('src', `${configuredPrintOrigin()}/print.html#session=capability`)
        expect(screen.getByRole('button', { name: /close print options/i })).toHaveFocus()

        fireEvent.click(screen.getByRole('button', { name: /close print options/i }))
        expect(screen.queryByRole('dialog', { name: 'Print options' })).not.toBeInTheDocument()
        expect(trigger).toHaveFocus()
        trigger.remove()
    })

    it('closes with Escape and ignores untrusted frame destinations', () => {
        render(<PrintOrderModal />)
        fireEvent(window, new CustomEvent(PRINT_ORDER_OPEN_EVENT))
        fireEvent(window, new CustomEvent(PRINT_ORDER_OPEN_EVENT, { detail: { src: 42 } }))
        fireEvent(window, new CustomEvent(PRINT_ORDER_OPEN_EVENT, { detail: { src: 'not a URL' } }))
        fireEvent(window, new CustomEvent(PRINT_ORDER_OPEN_EVENT, {
            detail: { src: `${configuredPrintOrigin()}/another-page.html#session=capability` },
        }))
        fireEvent(window, new CustomEvent(PRINT_ORDER_OPEN_EVENT, {
            detail: { src: 'https://untrusted.example/print.html#session=capability' },
        }))
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

        openPrintModal()
        expect(screen.getByRole('dialog')).toBeInTheDocument()
        fireEvent.keyDown(window, { key: 'Escape' })
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('reveals the bridge after load, traps focus, and closes from the backdrop', () => {
        render(<PrintOrderModal />)
        openPrintModal()

        const dialog = screen.getByRole('dialog', { name: 'Print options' })
        const close = screen.getByRole('button', { name: /close print options/i })
        const frame = screen.getByTitle('Fotomoto print options')
        const loading = screen.getByRole('status')

        fireEvent.load(frame)
        expect(frame).toHaveClass('is-loaded')
        expect(loading).toHaveClass('is-hidden')

        fireEvent.keyDown(window, { key: 'Tab' })
        expect(frame).toHaveFocus()
        fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
        expect(close).toHaveFocus()

        fireEvent.mouseDown(dialog.firstElementChild)
        expect(screen.getByRole('dialog')).toBeInTheDocument()
        fireEvent.mouseDown(dialog)
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('preserves an existing lightbox lock and restores background dialog accessibility', () => {
        document.documentElement.setAttribute('data-lightbox-scroll-lock', '')
        document.body.style.overflow = 'clip'
        const retained = document.createElement('section')
        retained.setAttribute('role', 'dialog')
        retained.setAttribute('aria-hidden', 'false')
        retained.setAttribute('inert', '')
        const restored = document.createElement('section')
        restored.setAttribute('role', 'dialog')
        document.body.append(retained, restored)
        render(<PrintOrderModal />)

        openPrintModal()
        expect(document.body.style.overflow).toBe('clip')
        expect(retained).toHaveAttribute('aria-hidden', 'true')
        expect(restored).toHaveAttribute('inert')

        fireEvent.click(screen.getByRole('button', { name: /close print options/i }))
        expect(document.body.style.overflow).toBe('clip')
        expect(retained).toHaveAttribute('aria-hidden', 'false')
        expect(retained).toHaveAttribute('inert')
        expect(restored).not.toHaveAttribute('aria-hidden')
        expect(restored).not.toHaveAttribute('inert')
        retained.remove()
        restored.remove()
    })
})
