import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
const loader = vi.hoisted(() => ({ loadExplorerViewer: vi.fn(), readExplorerViewer: vi.fn() }))
const sharing = vi.hoisted(() => ({ sharePage: vi.fn() }))
vi.mock('../utils/explorerViewer', () => loader)
vi.mock('../utils/share', () => sharing)
vi.mock('../utils/mediaUrls', () => ({ mediaDisplayUrl: image => image.url, mediaId: image => image.id, mediaPreviewSrcSet: () => '', mediaBeforeDisplayUrl: image => image?.before?.url || '', mediaBeforeSrcSet: () => '' }))
vi.mock('../utils/mediaAccessibility', () => ({ photoDescription: image => image.title }))
import ExplorerPhotoLightbox from './ExplorerPhotoLightbox'

let resolveViewer, rejectViewer
const props = {
    images: [{ id: 'one', title: 'One', url: '/one.webp', width: 1200, height: 800 }, { id: 'two', title: 'Two', url: '/two.webp', width: 1200, height: 800 }],
    index: 0, ariaLabel: 'Photographs', onClose: vi.fn(), onNext: vi.fn(), onPrevious: vi.fn(),
}
function Viewer({ initialImageReady, initialComparisonRequested, initialOriginalReady }) {
    return <div role="dialog" aria-label="Loaded viewer">{initialImageReady ? 'Photo remains ready' : 'Photo loading'}
        {initialComparisonRequested && (initialOriginalReady ? 'Original remains ready' : 'Original requested')}
    </div>
}
beforeEach(() => {
    loader.readExplorerViewer.mockReturnValue(null)
    loader.loadExplorerViewer.mockImplementation(() => new Promise((resolve, reject) => { resolveViewer = resolve; rejectViewer = reject }))
    sharing.sharePage.mockResolvedValue('copied')
})

it('enhances after copied-link feedback resets without another visitor interaction', async () => {
    vi.useFakeTimers()
    const view = render(<ExplorerPhotoLightbox {...props} />)
    try {
        fireEvent.load(screen.getByRole('img', { name: 'One' }))
        await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Share photo' })))
        expect(screen.getByText('Link Copied')).toBeVisible()
        await act(async () => resolveViewer(Viewer))
        await act(async () => vi.advanceTimersByTime(400))
        expect(screen.queryByRole('dialog', { name: 'Loaded viewer' })).not.toBeInTheDocument()
        await act(async () => vi.advanceTimersByTime(2200))
        await act(async () => vi.advanceTimersByTime(300))
        expect(screen.getByRole('dialog', { name: 'Loaded viewer' })).toHaveTextContent('Photo remains ready')
    } finally {
        view.unmount()
        vi.useRealTimers()
    }
})

it('keeps the selected photo, navigation, escape and focus trap available while code is delayed', async () => {
    const view = render(<ExplorerPhotoLightbox {...props} />)
    const dialog = screen.getByRole('dialog', { name: 'Photographs' })
    expect(screen.getByRole('img', { name: 'One' })).toHaveAttribute('src', '/one.webp')
    expect(screen.getByRole('button', { name: 'Close photo viewer' })).toHaveFocus()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(props.onNext).toHaveBeenCalledOnce()
    view.rerender(<ExplorerPhotoLightbox {...props} index={1} />)
    expect(screen.getByRole('img', { name: 'Two' })).toHaveAttribute('src', '/two.webp')
    const last = screen.getByRole('button', { name: 'Next photo' })
    last.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(dialog).toContainElement(document.activeElement)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalledOnce()
})

it('carries a displayed photo through the handoff, without marking another photo ready', async () => {
    const view = render(<ExplorerPhotoLightbox {...props} />)
    fireEvent.load(screen.getByRole('img', { name: 'One' }))
    await act(async () => resolveViewer(Viewer))
    expect(await screen.findByRole('dialog', { name: 'Loaded viewer' })).toHaveTextContent('Photo remains ready')
    view.rerender(<ExplorerPhotoLightbox {...props} index={1} />)
    expect(screen.getByRole('dialog', { name: 'Loaded viewer' })).toHaveTextContent('Photo loading')
})

it('keeps photos usable after a chunk error and lets the visitor retry the controls', async () => {
    render(<ExplorerPhotoLightbox {...props} />)
    await act(async () => rejectViewer(new Error('Network unavailable')))
    expect(screen.getByRole('alert')).toHaveTextContent('Photo controls could not be loaded')
    expect(screen.getByRole('img', { name: 'One' })).toBeVisible()
    fireEvent.load(screen.getByRole('img', { name: 'One' }))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(loader.loadExplorerViewer).toHaveBeenCalledTimes(2))
    await act(async () => resolveViewer(Viewer))
    expect(await screen.findByRole('dialog', { name: 'Loaded viewer' })).toBeVisible()
})

it('ignores a late code response after the visitor closes', async () => {
    const view = render(<ExplorerPhotoLightbox {...props} />)
    view.unmount()
    await act(async () => resolveViewer(Viewer))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('keeps zoom, download and print available before the viewer code arrives', async () => {
    const onDownload = vi.fn(), onPrint = vi.fn().mockResolvedValue(undefined)
    render(<ExplorerPhotoLightbox {...props} onDownload={onDownload} onPrint={onPrint} />)
    fireEvent.load(screen.getByRole('img', { name: 'One' }))
    fireEvent.click(screen.getByRole('button', { name: 'Download photo' }))
    expect(onDownload).toHaveBeenCalledWith(expect.anything(), props.images[0], 0)
    fireEvent.click(screen.getByRole('button', { name: 'Order a print of this photo' }))
    await waitFor(() => expect(onPrint).toHaveBeenCalledOnce())
    expect(screen.getByRole('button', { name: /zoom/i })).toBeEnabled()
})

it('preserves an original comparison opened while the viewer code is delayed', async () => {
    const image = { ...props.images[0], before: { status: 'ready', url: '/before.webp', width: 1200, height: 800 } }
    render(<ExplorerPhotoLightbox {...props} images={[image]} onDownload={vi.fn()} onPrint={vi.fn()} />)
    fireEvent.load(screen.getByRole('img', { name: 'One' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    fireEvent.load(screen.getByRole('img', { name: 'Before editing — One', hidden: true }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download edited photo' })).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Order a print of the edited photo' })).toBeEnabled()
    await act(async () => resolveViewer(Viewer))
    expect(await screen.findByRole('dialog', { name: 'Loaded viewer' })).toHaveTextContent('Original remains ready')
})
