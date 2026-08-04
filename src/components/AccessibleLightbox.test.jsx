import { useCallback, useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import AccessibleLightbox from './AccessibleLightbox'

function Harness() {
    const [open, setOpen] = useState(false)
    const close = useCallback(() => setOpen(false), [])

    return (
        <>
            <button type="button" onClick={() => setOpen(true)}>Open viewer</button>
            {open && (
                <AccessibleLightbox
                    ariaLabel="Test viewer"
                    onClose={close}
                    className="test-dialog"
                >
                    <button type="button" data-lightbox-initial-focus onClick={close}>Close viewer</button>
                    <button type="button">Download item</button>
                </AccessibleLightbox>
            )}
        </>
    )
}

describe('AccessibleLightbox', () => {
    afterEach(() => document.getElementById('root')?.remove())

    it('isolates the page, traps focus, closes by keyboard, and restores focus', () => {
        const appRoot = document.createElement('div')
        appRoot.id = 'root'
        document.body.appendChild(appRoot)
        render(<Harness />, { container: appRoot })

        const opener = screen.getByRole('button', { name: 'Open viewer' })
        opener.focus()
        fireEvent.click(opener)

        expect(screen.getByRole('dialog', { name: 'Test viewer' })).toBeInTheDocument()
        expect(screen.getByRole('dialog', { name: 'Test viewer' }).parentElement).toBe(document.body)
        expect(screen.getByRole('dialog', { name: 'Test viewer' })).toHaveClass('linen-lightbox')
        expect(appRoot).toHaveAttribute('inert')
        expect(appRoot).toHaveAttribute('aria-hidden', 'true')
        expect(document.documentElement).toHaveClass('linen-lightbox-open')
        expect(document.body.style.overflow).toBe('hidden')

        const close = screen.getByRole('button', { name: 'Close viewer' })
        const download = screen.getByRole('button', { name: 'Download item' })
        expect(close).toHaveFocus()
        fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
        expect(download).toHaveFocus()
        fireEvent.keyDown(window, { key: 'Tab' })
        expect(close).toHaveFocus()

        fireEvent.keyDown(window, { key: 'Escape' })
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(appRoot).not.toHaveAttribute('inert')
        expect(appRoot).not.toHaveAttribute('aria-hidden')
        expect(document.documentElement).not.toHaveClass('linen-lightbox-open')
        expect(document.body.style.overflow).toBe('')
        expect(opener).toHaveFocus()
    })
})
