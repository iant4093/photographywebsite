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
        fireEvent(window, new CustomEvent(PRINT_ORDER_OPEN_EVENT, {
            detail: { src: 'https://untrusted.example/print.html#session=capability' },
        }))
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

        openPrintModal()
        expect(screen.getByRole('dialog')).toBeInTheDocument()
        fireEvent.keyDown(window, { key: 'Escape' })
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
})
