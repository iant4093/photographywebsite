import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import PhotoLightbox from './PhotoLightbox'

vi.mock('../utils/mediaUrls', () => ({
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

describe('PhotoLightbox', () => {
  it('shows the complete safe camera settings and uses one intrinsic media frame', () => {
    const { rerender } = render(
      <PhotoLightbox images={[landscape, portrait]} index={0} ariaLabel="Photo viewer" onClose={vi.fn()} />,
    )
    expect(screen.getByRole('dialog', { name: 'Photo viewer' })).toHaveTextContent('Canon EOS R7')
    expect(document.querySelector('.linen-lightbox-content')).toHaveClass('has-photo-metadata')
    expect(document.querySelector('.linen-lightbox-metadata')).toHaveTextContent('Canon EOS R7')
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
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('No photographs are available.')
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
})
