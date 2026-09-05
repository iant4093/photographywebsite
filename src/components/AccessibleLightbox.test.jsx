import { useCallback, useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import AccessibleLightbox from './AccessibleLightbox'

function Harness() {
    const [open, setOpen] = useState(false)
    const close = useCallback(() => setOpen(false), [])

    return (
        <>
            <div className="linen-nav" data-testid="site-navigation" />
            <div className="editorial-progress" data-testid="film-scrollbar" />
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

function NestedHarness() {
    const [album, setAlbum] = useState(true)
    const [photo, setPhoto] = useState(false)
    return <>
        <button type="button">Gallery control</button>
        {album && <AccessibleLightbox ariaLabel="Album" onClose={() => setAlbum(false)}>
            <button type="button" onClick={() => setPhoto(true)}>Open photograph</button>
            <button type="button">Album action</button>
            {photo && <AccessibleLightbox ariaLabel="Photograph" onClose={() => setPhoto(false)}>
                <button type="button" onClick={() => setPhoto(false)}>Close photograph</button>
                <button type="button">Photo action</button>
            </AccessibleLightbox>}
        </AccessibleLightbox>}
    </>
}

describe('AccessibleLightbox', () => {
    afterEach(() => document.getElementById('root')?.remove())

    it('closes only the top dialog and restores album focus without unlocking the page', () => {
        const { container } = render(<NestedHarness />)
        const opener = screen.getByRole('button', { name: 'Open photograph' })
        opener.focus()
        fireEvent.click(opener)
        const album = document.querySelector('[role="dialog"][aria-label="Album"]')
        expect(album).toHaveAttribute('inert')
        expect(screen.getByRole('button', { name: 'Close photograph' })).toHaveFocus()
        fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
        expect(screen.getByRole('button', { name: 'Photo action' })).toHaveFocus()
        fireEvent.keyDown(window, { key: 'Escape' })
        expect(screen.queryByRole('dialog', { name: 'Photograph' })).toBeNull()
        expect(screen.getByRole('dialog', { name: 'Album' })).not.toHaveAttribute('inert')
        expect(opener).toHaveFocus()
        expect(container).toHaveAttribute('inert')
        expect(document.body.style.position).toBe('fixed')
        expect(document.documentElement).toHaveAttribute('data-lightbox-scroll-lock')
        fireEvent.keyDown(window, { key: 'Escape' })
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(container).not.toHaveAttribute('inert')
        expect(document.body.style.position).toBe('')
    })

    it('releases nested locks when the route unmounts both dialogs together', () => {
        const { container, unmount } = render(<NestedHarness />)
        fireEvent.click(screen.getByRole('button', { name: 'Open photograph' }))
        unmount()
        expect(container).not.toHaveAttribute('inert')
        expect(container).not.toHaveAttribute('aria-hidden')
        expect(document.body.style.position).toBe('')
        expect(document.body.style.overflow).toBe('')
        expect(document.documentElement).not.toHaveAttribute('data-lightbox-scroll-lock')
    })

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
        expect(screen.getByTestId('site-navigation').style.visibility).toBe('')
        expect(screen.getByTestId('site-navigation').style.pointerEvents).toBe('')
        expect(screen.getByTestId('film-scrollbar').style.visibility).toBe('')
        expect(screen.getByTestId('film-scrollbar').style.pointerEvents).toBe('')
        expect(document.documentElement).toHaveAttribute('data-lightbox-scroll-lock')
        expect(document.body.style.overflow).toBe('hidden')
        expect(document.body.style.position).toBe('fixed')

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
        expect(screen.getByTestId('site-navigation')).not.toHaveStyle({ visibility: 'hidden' })
        expect(screen.getByTestId('film-scrollbar')).not.toHaveStyle({ visibility: 'hidden' })
        expect(document.documentElement).not.toHaveAttribute('data-lightbox-scroll-lock')
        expect(document.body.style.overflow).toBe('')
        expect(document.body.style.position).toBe('')
        expect(opener).toHaveFocus()
    })

    it('keeps its original scroll lock across callback rerenders and restores the exact offset', () => {
        window.scrollTo.mockClear()
        vi.spyOn(window, 'scrollX', 'get').mockReturnValue(11)
        vi.spyOn(window, 'scrollY', 'get').mockReturnValue(640)
        const firstClose = vi.fn()
        const secondClose = vi.fn()
        const firstNext = vi.fn()
        const secondNext = vi.fn()
        const secondPrevious = vi.fn()
        const { rerender, unmount } = render(
            <AccessibleLightbox ariaLabel="Stable viewer" onClose={firstClose} onNext={firstNext}>
                <button type="button">Viewer action</button>
            </AccessibleLightbox>,
        )

        expect(document.body.style.top).toBe('-640px')
        rerender(
            <AccessibleLightbox
                ariaLabel="Stable viewer"
                onClose={secondClose}
                onNext={secondNext}
                onPrevious={secondPrevious}
            >
                <button type="button">Viewer action</button>
            </AccessibleLightbox>,
        )
        expect(window.scrollTo).not.toHaveBeenCalled()
        expect(document.body.style.top).toBe('-640px')

        fireEvent.keyDown(window, { key: 'ArrowRight' })
        fireEvent.keyDown(window, { key: 'ArrowLeft' })
        expect(firstNext).not.toHaveBeenCalled()
        expect(secondNext).toHaveBeenCalledOnce()
        expect(secondPrevious).toHaveBeenCalledOnce()
        fireEvent.keyDown(window, { key: 'Escape' })
        expect(firstClose).not.toHaveBeenCalled()
        expect(secondClose).toHaveBeenCalledOnce()
        unmount()
        expect(window.scrollTo).toHaveBeenLastCalledWith(11, 640)
        expect(document.body.style.top).toBe('')
    })

    it('keeps the live viewport in place on short coarse-pointer landscape screens', () => {
        window.scrollTo.mockClear()
        vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
            matches: query.includes('orientation: landscape') && query.includes('pointer: coarse'),
            media: query,
            onchange: null,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            addListener: vi.fn(),
            removeListener: vi.fn(),
            dispatchEvent: vi.fn(),
        }))

        const { unmount } = render(
            <AccessibleLightbox ariaLabel="Landscape viewer" onClose={vi.fn()}>
                <button type="button" data-lightbox-initial-focus>Close viewer</button>
            </AccessibleLightbox>,
        )

        expect(screen.getByRole('dialog', { name: 'Landscape viewer' })).toHaveFocus()
        expect(document.documentElement.style.overflow).toBe('hidden')
        expect(document.body.style.overflow).toBe('hidden')
        expect(document.body.style.position).toBe('')

        unmount()
        expect(document.documentElement.style.overflow).toBe('')
        expect(document.body.style.overflow).toBe('')
        expect(window.scrollTo).not.toHaveBeenCalled()
    })
})
