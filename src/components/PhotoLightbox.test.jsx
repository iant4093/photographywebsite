import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import PhotoLightbox from './PhotoLightbox'

vi.mock('../utils/mediaUrls', () => ({
  mediaBeforeDisplayUrl: image => image?.before?.status === 'ready' ? image.before.url || '' : '',
  mediaBeforeSrcSet: image => (image?.before?.srcSet || []).map(({ url, width }) => `${url} ${width}w`).join(', '),
  mediaDisplayUrl: image => image.url,
  mediaId: image => image.id,
  mediaPreviewSrcSet: () => '',
  mediaThumbnailUrl: image => image.thumbnailUrl,
}))

const landscape = {
  id: 'landscape',
  url: 'https://media.test/landscape.jpg',
  thumbnailUrl: 'https://media.test/landscape-thumb.jpg',
  width: 1920,
  height: 1280,
  before: { status: 'pending' },
  exif: {
    model: 'Canon EOS R7',
    lens: 'Sigma 18-50mm F2.8',
    focalLength: '18mm',
    focalRatio: 'f/4',
    shutterSpeed: '1/250s',
    iso: 'ISO 100',
  },
}
const portrait = { ...landscape, id: 'portrait', width: 1280, height: 1920 }
const comparisonPhoto = {
  ...landscape,
  before: {
    status: 'ready',
    url: 'https://media.test/original.jpg?signature=one',
    srcSet: [
      { width: 640, url: 'https://media.test/original-640.jpg?signature=one' },
      { width: 1920, url: 'https://media.test/original-1920.jpg?signature=one' },
    ],
    width: 6000,
    height: 4000,
  },
}

describe('PhotoLightbox', () => {
  it('shows the complete safe camera settings and uses one intrinsic media frame', () => {
    const { rerender } = render(
      <PhotoLightbox images={[landscape, portrait]} index={0} ariaLabel="Photo viewer" onClose={vi.fn()} />,
    )
    expect(screen.getByRole('dialog', { name: 'Photo viewer' })).toHaveTextContent('Canon EOS R7')
    expect(document.querySelector('.linen-lightbox-content')).toHaveClass('has-photo-metadata')
    expect(document.querySelector('.linen-lightbox-metadata')).toHaveTextContent('Canon EOS R7')
    const navigation = screen.getByRole('navigation', { name: 'Photo navigation' })
    expect(navigation.children[0]).toHaveAccessibleName('Previous photo')
    expect(navigation.children[1]).toHaveClass('linen-lightbox-metadata')
    expect(navigation.children[2]).toHaveAccessibleName('Next photo')
    expect(screen.getByRole('dialog')).toHaveTextContent('Sigma 18-50mm F2.8')
    expect(screen.getByRole('dialog')).toHaveTextContent('18mm')
    expect(screen.getByRole('dialog')).toHaveTextContent('f/4')
    expect(screen.getByRole('dialog')).toHaveTextContent('1/250s')
    expect(screen.getByRole('dialog')).toHaveTextContent('ISO 100')
    expect(document.querySelector('.linen-lightbox-media')).toHaveStyle({
      gridTemplate: 'minmax(0, 1fr) / minmax(0, 1fr)',
    })
    const landscapePreview = screen.getByAltText('Full size preview')
    expect(landscapePreview).not.toHaveClass('is-loaded')
    fireEvent.load(landscapePreview)
    expect(landscapePreview).toHaveClass('is-loaded')

    rerender(<PhotoLightbox images={[landscape, portrait]} index={1} ariaLabel="Photo viewer" onClose={vi.fn()} />)
    const fullImage = screen.getByAltText('Full size preview')
    const outgoingImage = document.querySelector('.linen-lightbox-photo-outgoing')
    expect(outgoingImage).toBeInTheDocument()
    expect(outgoingImage).toHaveAttribute('src', landscape.url)
    expect(outgoingImage).not.toHaveClass('is-exiting')
    expect(fullImage).not.toHaveClass('is-loaded')
    fireEvent.load(fullImage)
    expect(fullImage).toHaveClass('is-loaded')
    expect(outgoingImage).toHaveClass('is-exiting')
    expect(fullImage).toHaveAttribute('width', '1280')
    expect(fullImage).toHaveAttribute('height', '1920')
    expect(fullImage).toHaveStyle({
      width: 'auto',
      height: 'auto',
      maxWidth: '100%',
      maxHeight: '100%',
    })
    expect(document.querySelectorAll('.linen-lightbox-media')).toHaveLength(1)
    expect(screen.getByRole('navigation', { name: 'Photo navigation' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close photo viewer' })).toHaveClass('linen-lightbox-close')
    expect(screen.getByRole('dialog')).toHaveClass('bg-charcoal/90')
  })

  it('shows pending and empty states without requiring an active photograph', () => {
    const onRetry = vi.fn()
    const { rerender } = render(
      <PhotoLightbox
        images={[]}
        index={0}
        ariaLabel="Random viewer"
        onClose={vi.fn()}
        loading
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Finding random photos')
    expect(screen.queryByRole('navigation')).toBeNull()

    rerender(
      <PhotoLightbox
        images={[]}
        index={0}
        ariaLabel="Random viewer"
        onClose={vi.fn()}
        emptyMessage="No photographs are available."
        onRetry={onRetry}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('No photographs are available.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('supports a single metadata-free photo and reports media errors', () => {
    const onMediaError = vi.fn()
    const image = { ...landscape, exif: undefined }
    render(
      <PhotoLightbox
        images={[image]}
        index={0}
        ariaLabel="Single viewer"
        onClose={vi.fn()}
        onMediaError={onMediaError}
      />,
    )

    expect(screen.queryByRole('navigation')).toBeNull()
    expect(document.querySelector('.linen-lightbox-content')).not.toHaveClass('has-photo-metadata')
    expect(document.querySelector('.linen-lightbox-metadata')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Download photo' })).toBeNull()
    screen.getByAltText('Full size preview').dispatchEvent(new Event('error'))
    expect(onMediaError).toHaveBeenCalledOnce()
  })

  it('offers print ordering only when a caller authorizes the action', async () => {
    const onPrint = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(
      <PhotoLightbox
        images={[landscape]}
        index={0}
        ariaLabel="Printable viewer"
        onClose={vi.fn()}
        onPrint={onPrint}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Order a print of this photo' }))
    expect(onPrint).toHaveBeenCalledWith(expect.any(Object), landscape, 0)

    rerender(
      <PhotoLightbox images={[landscape]} index={0} ariaLabel="Viewer" onClose={vi.fn()} />,
    )
    expect(screen.queryByRole('button', { name: 'Order a print of this photo' })).toBeNull()
  })

  it('presents photo downloads as a labeled action button', () => {
    const onDownload = vi.fn()
    render(
      <PhotoLightbox
        images={[landscape]}
        index={0}
        ariaLabel="Downloadable viewer"
        onClose={vi.fn()}
        onDownload={onDownload}
      />,
    )

    const download = screen.getByRole('button', { name: 'Download photo' })
    expect(download).toHaveTextContent('Download')
    expect(download).toHaveClass('linen-lightbox-download')
    fireEvent.click(download)
    expect(onDownload).toHaveBeenCalledWith(expect.any(Object), landscape, 0)
  })

  it('offers native page sharing before the download action', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    render(
      <PhotoLightbox
        images={[landscape]}
        index={0}
        ariaLabel="Shareable viewer"
        shareTitle="Landscape Album"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />,
    )

    const actions = document.querySelector('.linen-lightbox-actions')
    const shareButton = screen.getByRole('button', { name: 'Share photo' })
    const downloadButton = screen.getByRole('button', { name: 'Download photo' })
    expect(actions.compareDocumentPosition(shareButton) & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeTruthy()
    expect(shareButton.compareDocumentPosition(downloadButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(shareButton)
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ title: 'Landscape Album' }))
    delete navigator.share
  })

  it('shares the exact active photograph URL supplied by its gallery', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    render(
      <PhotoLightbox
        images={[landscape, portrait]}
        index={1}
        ariaLabel="Shareable viewer"
        onClose={vi.fn()}
        shareUrl={(image, index) => `https://example.test/album/a1?photo=${image.id}&index=${index}`}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Share photo' }))
    expect(share).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://example.test/album/a1?photo=portrait&index=1',
    }))
    delete navigator.share
  })

  it('does not expose sharing for a private viewer', () => {
    render(
      <PhotoLightbox
        images={[landscape]}
        index={0}
        ariaLabel="Private viewer"
        onClose={vi.fn()}
        onDownload={vi.fn()}
        canShare={false}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Share photo' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Download photo' })).toBeInTheDocument()
  })

  it('offers comparison immediately before share and loads the complete original only on request', () => {
    render(<PhotoLightbox images={[comparisonPhoto]} index={0} ariaLabel="Viewer" onClose={vi.fn()} />)
    const edited = screen.getByAltText('Full size preview')
    fireEvent.load(edited)
    const toggle = screen.getByRole('button', { name: 'Show original photo' })
    expect(toggle.nextElementSibling).toBe(screen.getByRole('button', { name: 'Share photo' }))
    expect(screen.queryByAltText('Before — Camera JPG')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('After — Edited')

    fireEvent.click(toggle)
    const original = screen.getByAltText('Before — Camera JPG')
    expect(original).toHaveAttribute('src', comparisonPhoto.before.url)
    expect(original).toHaveAttribute('srcset', 'https://media.test/original-640.jpg?signature=one 640w, https://media.test/original-1920.jpg?signature=one 1920w')
    expect(original).toHaveAttribute('width', '6000')
    expect(original).toHaveAttribute('height', '4000')
    expect(original).toHaveClass('object-contain')
    expect(original).toHaveStyle({ width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: '100%', visibility: 'hidden' })
    expect(screen.getByRole('status')).toHaveTextContent('Loading original…')
    expect(edited).toBeVisible()

    fireEvent.load(original)
    expect(original).toBeVisible()
    expect(edited).not.toBeVisible()
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Before — Camera JPG')

    fireEvent.click(screen.getByRole('button', { name: 'Show edited photo' }))
    expect(edited).toBeVisible()
    expect(screen.getByAltText('Before — Camera JPG')).toBe(original)
    expect(original).not.toBeVisible()
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(screen.getByAltText('Before — Camera JPG')).toBe(original)
    expect(original).toBeVisible()
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
  })

  it('removes a retained original if its signed source changes while showing the edit', () => {
    const props = { index: 0, ariaLabel: 'Viewer', onClose: vi.fn() }
    const { rerender } = render(<PhotoLightbox {...props} images={[comparisonPhoto]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    const original = screen.getByAltText('Before — Camera JPG')
    fireEvent.load(original)
    fireEvent.click(screen.getByRole('button', { name: 'Show edited photo' }))
    expect(original.isConnected).toBe(true)
    rerender(<PhotoLightbox {...props} images={[{ ...comparisonPhoto, before: { ...comparisonPhoto.before, url: 'https://media.test/refreshed.jpg', srcSet: [] } }]} />)
    expect(screen.queryByAltText('Before — Camera JPG')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    expect(screen.getByAltText('Before — Camera JPG')).not.toBe(original)
    expect(screen.getByRole('status')).toHaveTextContent('Loading original…')
  })

  it('keeps the edit visible until the original is decoded and reuses it on later toggles', async () => {
    render(<PhotoLightbox images={[comparisonPhoto]} index={0} ariaLabel="Viewer" onClose={vi.fn()} />)
    const edited = screen.getByAltText('Full size preview')
    fireEvent.load(edited)
    const placeholder = document.querySelector('.linen-lightbox-placeholder')
    expect(placeholder).toHaveClass('is-placeholder-hidden')
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    const original = screen.getByAltText('Before — Camera JPG')
    let finishDecode
    original.decode = vi.fn(() => new Promise(resolve => { finishDecode = resolve }))
    fireEvent.load(original)
    expect(original.decode).toHaveBeenCalledOnce()
    expect(edited).toBeVisible()
    expect(original).not.toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('Loading original…')
    await act(async () => { finishDecode() })
    expect(original).toBeVisible()
    expect(edited).toHaveClass('is-comparison-hidden')

    fireEvent.click(screen.getByRole('button', { name: 'Show edited photo' }))
    expect(placeholder).toHaveClass('is-placeholder-hidden')
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    expect(original.decode).toHaveBeenCalledOnce()
    expect(screen.getByAltText('Before — Camera JPG')).toBe(original)
  })

  it('does not reveal a late decoded original after cancellation or a source replacement', async () => {
    const props = { index: 0, ariaLabel: 'Viewer', onClose: vi.fn() }
    const { rerender } = render(<PhotoLightbox {...props} images={[comparisonPhoto]} />)
    fireEvent.load(screen.getByAltText('Full size preview'))
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    const original = screen.getByAltText('Before — Camera JPG')
    let finishDecode
    original.decode = () => new Promise(resolve => { finishDecode = resolve })
    fireEvent.load(original)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel loading original' }))
    await act(async () => { finishDecode() })
    expect(screen.queryByAltText('Before — Camera JPG')).toBeNull()
    expect(screen.getByRole('button', { name: 'Show original photo' })).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    const oldSource = screen.getByAltText('Before — Camera JPG')
    oldSource.decode = () => new Promise(resolve => { finishDecode = resolve })
    fireEvent.load(oldSource)
    rerender(<PhotoLightbox {...props} images={[{ ...comparisonPhoto, before: { ...comparisonPhoto.before, url: 'https://media.test/fresh-original.jpg' } }]} />)
    const freshSource = screen.getByAltText('Before — Camera JPG')
    await act(async () => { finishDecode() })
    expect(freshSource).not.toBeVisible()
    expect(screen.getByAltText('Full size preview')).toBeVisible()
  })

  it.each(['reject', 'throw'])('keeps the edit available when original decoding fails with %s', async (failure) => {
    const onBeforeRefresh = vi.fn().mockResolvedValue(undefined)
    render(<PhotoLightbox images={[comparisonPhoto]} index={0} ariaLabel="Viewer" onClose={vi.fn()} onBeforeRefresh={onBeforeRefresh} />)
    fireEvent.load(screen.getByAltText('Full size preview'))
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    const original = screen.getByAltText('Before — Camera JPG')
    original.decode = () => {
      if (failure === 'throw') throw new Error('Decode failed')
      return Promise.reject(new Error('Decode failed'))
    }
    await act(async () => { fireEvent.load(original) })
    expect(screen.getByAltText('Full size preview')).toBeVisible()
    expect(screen.queryByAltText('Before — Camera JPG')).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry original' })).toBeInTheDocument()
    expect(onBeforeRefresh).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }), comparisonPhoto, { reason: 'media-error' })
  })

  it('holds the original on screen when returning to an edit that is still decoding', async () => {
    render(<PhotoLightbox images={[comparisonPhoto]} index={0} ariaLabel="Viewer" onClose={vi.fn()} />)
    const edited = screen.getByAltText('Full size preview')
    let finishDecode
    edited.decode = () => new Promise(resolve => { finishDecode = resolve })
    fireEvent.load(edited)
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    const original = screen.getByAltText('Before — Camera JPG')
    fireEvent.load(original)
    fireEvent.click(screen.getByRole('button', { name: 'Show edited photo' }))
    expect(original).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('Loading edited photo…')
    expect(screen.getByRole('button', { name: 'Cancel loading edited photo' })).toHaveAttribute('aria-pressed', 'true')
    await act(async () => { finishDecode() })
    expect(edited).toBeVisible()
    expect(original).not.toBeVisible()
    expect(screen.getByRole('button', { name: 'Show original photo' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('ignores a stale edit decode when a refreshed URL reuses the current image element', async () => {
    const props = { index: 0, ariaLabel: 'Viewer', onClose: vi.fn() }
    const { rerender } = render(<PhotoLightbox {...props} images={[comparisonPhoto]} />)
    const edited = screen.getByAltText('Full size preview')
    let finishDecode
    edited.decode = () => new Promise(resolve => { finishDecode = resolve })
    fireEvent.load(edited)
    rerender(<PhotoLightbox {...props} images={[{ ...comparisonPhoto, url: 'https://media.test/fresh-edit.jpg' }]} />)
    expect(screen.getByAltText('Full size preview')).toBe(edited)
    await act(async () => { finishDecode() })
    expect(edited).not.toHaveClass('is-loaded')
    fireEvent.load(edited)
    await act(async () => { finishDecode() })
    expect(edited).toHaveClass('is-loaded')
  })

  it('resets comparison on navigation, return, and reopen and ignores detached original events', () => {
    const onMediaError = vi.fn()
    const props = { images: [comparisonPhoto, portrait], ariaLabel: 'Viewer', onClose: vi.fn(), onMediaError }
    const { rerender, unmount } = render(<PhotoLightbox {...props} index={0} />)
    fireEvent.load(screen.getByAltText('Full size preview'))
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    const original = screen.getByAltText('Before — Camera JPG')
    fireEvent.load(original)

    rerender(<PhotoLightbox {...props} index={1} />)
    expect(screen.queryByAltText('Before — Camera JPG')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('After — Edited')
    fireEvent.load(original)
    fireEvent.error(original)
    expect(onMediaError).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Show original photo' })).toHaveAttribute('aria-pressed', 'false')
    rerender(<PhotoLightbox {...props} index={0} />)
    expect(screen.queryByAltText('Before — Camera JPG')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    fireEvent.load(screen.getByAltText('Before — Camera JPG'))
    unmount()

    render(<PhotoLightbox {...props} index={0} />)
    expect(screen.queryByAltText('Before — Camera JPG')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('After — Edited')
  })

  it('keeps the edit on original failure, refreshes once, and supports an explicit retry', async () => {
    const onMediaError = vi.fn().mockResolvedValue(undefined)
    render(<PhotoLightbox images={[comparisonPhoto]} index={0} ariaLabel="Viewer" onClose={vi.fn()} onMediaError={onMediaError} />)
    const edited = screen.getByAltText('Full size preview')
    fireEvent.load(edited)
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    const original = screen.getByAltText('Before — Camera JPG')
    fireEvent.error(original)
    fireEvent.error(original)
    expect(onMediaError).toHaveBeenCalledOnce()
    expect(edited).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('Original could not be loaded.')
    expect(screen.queryByAltText('Before — Camera JPG')).toBeNull()

    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Retry original' }))
    expect(onMediaError).toHaveBeenCalledTimes(2)
    const retry = screen.getByAltText('Before — Camera JPG')
    expect(retry).not.toBe(original)
    fireEvent.error(retry)
    expect(onMediaError).toHaveBeenCalledTimes(2)
    expect(edited).toBeVisible()
  })

  it('recovers an expired URL when the parent refreshes its before descriptor', () => {
    const props = { index: 0, ariaLabel: 'Viewer', onClose: vi.fn(), onMediaError: vi.fn() }
    const { rerender } = render(<PhotoLightbox {...props} images={[comparisonPhoto]} />)
    fireEvent.load(screen.getByAltText('Full size preview'))
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    const expired = screen.getByAltText('Before — Camera JPG')
    fireEvent.error(expired)
    const refreshed = { ...comparisonPhoto, before: { ...comparisonPhoto.before, url: 'https://media.test/original.jpg?signature=two', srcSet: [] } }
    rerender(<PhotoLightbox {...props} images={[refreshed]} />)
    const original = screen.getByAltText('Before — Camera JPG')
    expect(original).toHaveAttribute('src', refreshed.before.url)
    expect(screen.getByRole('status')).toHaveTextContent('Loading original…')
    fireEvent.load(expired)
    expect(original).not.toBeVisible()
    fireEvent.load(original)
    expect(original).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('Before — Camera JPG')
  })

  it('resolves an open comparison again when a gallery refresh replaces it with an unresolved hint', async () => {
    const onBeforeRefresh = vi.fn().mockResolvedValue(undefined)
    const props = { index: 0, ariaLabel: 'Viewer', onClose: vi.fn(), onBeforeRefresh }
    const { rerender } = render(<PhotoLightbox {...props} images={[comparisonPhoto]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    fireEvent.load(screen.getByAltText('Before — Camera JPG'))

    const refreshedPhoto = { ...comparisonPhoto, before: { status: 'unresolved' } }
    rerender(<PhotoLightbox {...props} images={[refreshedPhoto]} />)
    expect(onBeforeRefresh).toHaveBeenCalledExactlyOnceWith(undefined, refreshedPhoto, { reason: 'original-status' })
    expect(screen.getByRole('status')).toHaveTextContent('Loading original…')
    await act(async () => {})

    rerender(<PhotoLightbox {...props} images={[{ ...refreshedPhoto }]} />)
    expect(onBeforeRefresh).toHaveBeenCalledOnce()
    rerender(<PhotoLightbox {...props} images={[comparisonPhoto]} />)
    fireEvent.load(screen.getByAltText('Before — Camera JPG'))
    expect(screen.getByAltText('Before — Camera JPG')).toBeVisible()
  })

  it('does not duplicate the first unresolved request or repeatedly retry an unresolved response', async () => {
    const onBeforeRefresh = vi.fn().mockResolvedValue(undefined)
    const photo = { ...landscape, before: { status: 'unresolved' } }
    const props = { index: 0, ariaLabel: 'Viewer', onClose: vi.fn(), onBeforeRefresh }
    const { rerender } = render(<PhotoLightbox {...props} images={[photo]} />)
    expect(onBeforeRefresh).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    await act(async () => {})
    expect(onBeforeRefresh).toHaveBeenCalledOnce()
    rerender(<PhotoLightbox {...props} images={[{ ...photo }]} />)
    await act(async () => {})
    expect(onBeforeRefresh).toHaveBeenCalledOnce()
  })

  it.each([false, true])('waits for an obsolete status request before resolving refreshed gallery data (cancelled: %s)', async (cancelled) => {
    let finish
    const onBeforeRefresh = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValue(undefined)
    const props = { index: 0, ariaLabel: 'Viewer', onClose: vi.fn(), onBeforeRefresh }
    const { rerender } = render(<PhotoLightbox {...props} images={[landscape]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    const refreshedPhoto = { ...landscape, before: { status: 'unresolved' } }
    rerender(<PhotoLightbox {...props} images={[refreshedPhoto]} />)
    expect(onBeforeRefresh).toHaveBeenCalledOnce()
    if (cancelled) fireEvent.click(screen.getByRole('button', { name: 'Cancel loading original' }))

    await act(async () => { finish() })
    expect(onBeforeRefresh).toHaveBeenCalledTimes(cancelled ? 1 : 2)
    if (!cancelled) {
      expect(onBeforeRefresh).toHaveBeenLastCalledWith(undefined, refreshedPhoto, { reason: 'original-status' })
    }
  })

  it('checks pending matches on request and shows the required message for a missing original', () => {
    const onMediaError = vi.fn()
    const props = { index: 0, ariaLabel: 'Viewer', onClose: vi.fn(), onBeforeRefresh: onMediaError }
    const { rerender } = render(<PhotoLightbox {...props} images={[landscape]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    expect(screen.getByRole('status')).toHaveTextContent('Preparing original…')
    expect(onMediaError).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
    rerender(<PhotoLightbox {...props} images={[comparisonPhoto]} />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading original…')
    expect(screen.getByAltText('Before — Camera JPG')).toBeInTheDocument()

    rerender(<PhotoLightbox {...props} images={[{ ...landscape, before: { status: 'unavailable' } }]} />)
    expect(screen.getByRole('status')).toHaveTextContent('Unable to locate original')
    expect(document.querySelector('.linen-lightbox-before-tooltip')).toHaveTextContent('Unable to locate original')
    expect(screen.queryByAltText('Before — Camera JPG')).toBeNull()
    expect(screen.getByRole('button', { name: 'Unable to locate original' })).toHaveAttribute('title', 'Unable to locate original')
  })

  it('keeps downloads and print orders tied to the edited photo with explicit labels in before mode', () => {
    const onDownload = vi.fn()
    const onPrint = vi.fn().mockResolvedValue(undefined)
    render(<PhotoLightbox images={[comparisonPhoto]} index={0} ariaLabel="Viewer" onClose={vi.fn()} onDownload={onDownload} onPrint={onPrint} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    fireEvent.load(screen.getByAltText('Before — Camera JPG'))
    fireEvent.click(screen.getByRole('button', { name: 'Download edited photo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Order a print of the edited photo' }))
    expect(onDownload).toHaveBeenCalledWith(expect.any(Object), comparisonPhoto, 0)
    expect(onPrint).toHaveBeenCalledWith(expect.any(Object), comparisonPhoto, 0)
  })

  it('uses the original-specific refresh callback while routing edited image errors separately', () => {
    const onBeforeRefresh = vi.fn().mockResolvedValue(undefined)
    const onMediaError = vi.fn()
    render(<PhotoLightbox images={[landscape]} index={0} ariaLabel="Viewer" onClose={vi.fn()} onBeforeRefresh={onBeforeRefresh} onMediaError={onMediaError} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    expect(onBeforeRefresh).toHaveBeenCalledWith(expect.any(Object), landscape, { reason: 'original-status' })
    expect(onMediaError).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Cancel loading original' })).toHaveAttribute('aria-busy', 'true')
    fireEvent.error(screen.getByAltText('Full size preview'))
    expect(onMediaError).toHaveBeenCalledOnce()
  })

  it('does not expose original comparison for legacy demo image strings', () => {
    render(<PhotoLightbox images={['https://media.test/demo.jpg']} index={0} ariaLabel="Viewer" onClose={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Show original photo' })).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('marks original load errors and retry clicks as media errors so signed URLs are refreshed', async () => {
    const onBeforeRefresh = vi.fn().mockResolvedValue(undefined)
    render(<PhotoLightbox images={[comparisonPhoto]} index={0} ariaLabel="Viewer" onClose={vi.fn()} onBeforeRefresh={onBeforeRefresh} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    fireEvent.error(screen.getByAltText('Before — Camera JPG'))
    expect(onBeforeRefresh).toHaveBeenLastCalledWith(expect.any(Object), comparisonPhoto, { reason: 'media-error' })
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Retry original' }))
    expect(onBeforeRefresh).toHaveBeenCalledTimes(2)
    expect(onBeforeRefresh).toHaveBeenLastCalledWith(expect.any(Object), comparisonPhoto, { reason: 'media-error' })
  })

  it('does not expose original comparison when the API omits its descriptor', () => {
    const onMediaError = vi.fn()
    render(<PhotoLightbox images={[{ ...landscape, before: undefined }]} index={0} ariaLabel="Viewer" onClose={vi.fn()} onMediaError={onMediaError} />)
    expect(screen.queryByRole('button', { name: 'Show original photo' })).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(onMediaError).not.toHaveBeenCalled()
  })

  it('hides a requested comparison and status when refreshed data omits the descriptor', () => {
    const props = { index: 0, ariaLabel: 'Viewer', onClose: vi.fn() }
    const { rerender } = render(<PhotoLightbox {...props} images={[landscape]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    expect(screen.getByRole('status')).toHaveTextContent('Preparing original…')
    rerender(<PhotoLightbox {...props} images={[{ ...landscape, before: undefined }]} />)
    expect(screen.queryByRole('button', { name: 'Show edited photo' })).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByAltText('Full size preview')).toBeInTheDocument()
  })

  it.each(['pending', 'failed'])('does not send a %s original status to the protected-media error handler', (status) => {
    const onMediaError = vi.fn()
    render(<PhotoLightbox images={[{ ...landscape, before: { status } }]} index={0} ariaLabel="Viewer" onClose={vi.fn()} onMediaError={onMediaError} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    expect(onMediaError).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry original' })).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent(status === 'pending' ? 'Preparing original…' : 'Original could not be loaded.')
    if (status === 'failed') {
      fireEvent.click(screen.getByRole('button', { name: 'Show edited photo' }))
      expect(onMediaError).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: 'Show original photo' })).toBeInTheDocument()
      expect(document.querySelector('.linen-lightbox-before-tooltip')).toBeNull()
    }
  })

  it('uses one comparison button for failure retry and keeps action text and highlighting stable', async () => {
    const onBeforeRefresh = vi.fn().mockResolvedValue(undefined)
    const props = { index: 0, ariaLabel: 'Viewer', onClose: vi.fn(), onBeforeRefresh, onDownload: vi.fn(), onPrint: vi.fn() }
    const { rerender } = render(<PhotoLightbox {...props} images={[comparisonPhoto]} />)
    const toggle = screen.getByRole('button', { name: 'Show original photo' })
    const actionButtons = document.querySelector('.linen-lightbox-action-buttons')
    const actionCount = actionButtons.querySelectorAll('button').length
    const afterWord = toggle.querySelector('[data-label="After"] > span')
    const beforeWord = toggle.querySelector('[data-label="Before"] > span')
    expect(afterWord).toHaveClass('is-active')
    expect(beforeWord).not.toHaveClass('is-active')
    expect(screen.getByRole('status')).toHaveClass('linen-lightbox-before-status')
    expect(document.querySelector('.linen-lightbox-before-retry')).toBeNull()

    fireEvent.click(toggle)
    expect(toggle).toHaveTextContent('Before/After')
    expect(afterWord).toHaveClass('is-active')
    fireEvent.load(screen.getByAltText('Before — Camera JPG'))
    expect(beforeWord).toHaveClass('is-active')
    expect(afterWord).not.toHaveClass('is-active')
    expect(screen.getByRole('button', { name: 'Download edited photo' })).toHaveTextContent(/^Download$/)
    expect(screen.getByRole('button', { name: 'Order a print of the edited photo' })).toHaveTextContent(/^Order a Print$/)

    rerender(<PhotoLightbox {...props} images={[{ ...comparisonPhoto, before: { status: 'failed' } }]} />)
    expect(screen.getByRole('button', { name: 'Retry original' })).toBe(toggle)
    expect(actionButtons.querySelectorAll('button')).toHaveLength(actionCount)
    fireEvent.click(toggle)
    expect(onBeforeRefresh).toHaveBeenCalledOnce()
    await act(async () => {})
  })

  it('polls a selected pending original at a bounded rate and stops once its descriptor is ready', async () => {
    vi.useFakeTimers()
    try {
      const onBeforeRefresh = vi.fn().mockResolvedValue(undefined)
      const props = { index: 0, ariaLabel: 'Viewer', onClose: vi.fn(), onBeforeRefresh }
      const { rerender, unmount } = render(<PhotoLightbox {...props} images={[landscape]} />)
      fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
      expect(onBeforeRefresh).toHaveBeenCalledOnce()
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(onBeforeRefresh).toHaveBeenCalledTimes(4)
      await act(async () => { await vi.advanceTimersByTimeAsync(59_999) })
      expect(onBeforeRefresh).toHaveBeenCalledTimes(4)
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(onBeforeRefresh).toHaveBeenCalledTimes(5)
      rerender(<PhotoLightbox {...props} images={[comparisonPhoto]} />)
      fireEvent.load(screen.getByAltText('Before — Camera JPG'))
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
      expect(onBeforeRefresh).toHaveBeenCalledTimes(5)
      expect(screen.getByRole('button', { name: 'Show edited photo' })).toHaveAttribute('aria-pressed', 'true')
      unmount()
    } finally { vi.useRealTimers() }
  })

  it('does not overlap a slow initial refresh and cancels scheduled checks on navigation and unmount', async () => {
    vi.useFakeTimers()
    try {
      let finish
      const onBeforeRefresh = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue(undefined)
      const props = { images: [landscape, portrait], ariaLabel: 'Viewer', onClose: vi.fn(), onBeforeRefresh }
      const { rerender, unmount } = render(<PhotoLightbox {...props} index={0} />)
      fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(onBeforeRefresh).toHaveBeenCalledOnce()
      rerender(<PhotoLightbox {...props} index={1} />)
      await act(async () => { finish(); await vi.advanceTimersByTimeAsync(120_000) })
      expect(onBeforeRefresh).toHaveBeenCalledOnce()
      expect(screen.getByRole('button', { name: 'Show original photo' })).toHaveAttribute('aria-pressed', 'false')
      fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
      expect(onBeforeRefresh).toHaveBeenCalledTimes(2)
      unmount()
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
      expect(onBeforeRefresh).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it.each(['selected', 'replaced', 'left', 'unmounted'])('serializes another image retry and discards obsolete queued reads when %s', async (selection) => {
    let finish
    const onBeforeRefresh = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue(undefined)
    const failed = { ...portrait, before: { status: 'failed' } }
    const next = { ...failed, id: 'next' }
    const props = { images: [landscape, failed, next], ariaLabel: 'Viewer', onClose: vi.fn(), onBeforeRefresh }
    const { rerender, unmount } = render(<PhotoLightbox {...props} index={0} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    rerender(<PhotoLightbox {...props} index={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry original' }))
    expect(onBeforeRefresh).toHaveBeenCalledOnce()

    if (selection === 'replaced') {
      rerender(<PhotoLightbox {...props} index={2} />)
      fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
    } else if (selection === 'left') {
      rerender(<PhotoLightbox {...props} index={0} />)
      rerender(<PhotoLightbox {...props} index={1} />)
    } else if (selection === 'unmounted') unmount()

    await act(async () => { finish() })
    if (selection === 'selected' || selection === 'replaced') {
      expect(onBeforeRefresh).toHaveBeenCalledTimes(2)
      expect(onBeforeRefresh.mock.calls[1][1]).toBe(selection === 'selected' ? failed : next)
      expect(onBeforeRefresh.mock.calls[1][2]).toEqual({ reason: selection === 'selected' ? 'media-error' : 'original-status' })
    } else expect(onBeforeRefresh).toHaveBeenCalledOnce()
    if (selection !== 'unmounted') unmount()
  })

  it('pauses pending checks while hidden and cancels them when the same comparison button is toggled off', async () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    try {
      visibility.mockReturnValue('visible')
      const onBeforeRefresh = vi.fn().mockResolvedValue(undefined)
      const { unmount } = render(<PhotoLightbox images={[landscape]} index={0} ariaLabel="Viewer" onClose={vi.fn()} onBeforeRefresh={onBeforeRefresh} />)
      fireEvent.click(screen.getByRole('button', { name: 'Show original photo' }))
      visibility.mockReturnValue('hidden')
      fireEvent(document, new Event('visibilitychange'))
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
      expect(onBeforeRefresh).toHaveBeenCalledOnce()
      visibility.mockReturnValue('visible')
      fireEvent(document, new Event('visibilitychange'))
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
      expect(onBeforeRefresh).toHaveBeenCalledTimes(2)
      fireEvent.click(screen.getByRole('button', { name: 'Cancel loading original' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
      expect(onBeforeRefresh).toHaveBeenCalledTimes(2)
      unmount()
    } finally { visibility.mockRestore(); vi.useRealTimers() }
  })
})
