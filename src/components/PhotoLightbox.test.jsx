import { render, screen } from '@testing-library/react'
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
    expect(screen.getByRole('dialog')).toHaveTextContent('Sigma 18-50mm F2.8')
    expect(screen.getByRole('dialog')).toHaveTextContent('18mm')
    expect(screen.getByRole('dialog')).toHaveTextContent('f/4')
    expect(screen.getByRole('dialog')).toHaveTextContent('1/250s')
    expect(screen.getByRole('dialog')).toHaveTextContent('ISO 100')
    expect(document.querySelector('.linen-lightbox-media')).toHaveClass('absolute', 'inset-0')

    rerender(<PhotoLightbox images={[landscape, portrait]} index={1} ariaLabel="Photo viewer" onClose={vi.fn()} />)
    const fullImage = screen.getByAltText('Full size preview')
    expect(fullImage).toHaveAttribute('width', '1280')
    expect(fullImage).toHaveAttribute('height', '1920')
    expect(document.querySelectorAll('.linen-lightbox-media')).toHaveLength(1)
  })
})
