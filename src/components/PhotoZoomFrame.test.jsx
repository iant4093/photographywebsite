import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import PhotoZoomFrame from './PhotoZoomFrame'

const props = {
    bounds: { width: 800, height: 600 },
    width: 6000,
    height: 4000,
    src: 'https://media.test/full.jpg',
    srcSet: 'https://media.test/preview.jpg 960w',
    sizes: '800px',
    alt: 'Photo',
    loaded: true,
}

describe('PhotoZoomFrame detail upgrade', () => {
    it('keeps the preview unchanged until full resolution decodes and retains it across zoom toggles', async () => {
        const onLoad = vi.fn()
        const { container } = render(<PhotoZoomFrame {...props} onLoad={onLoad} />)
        const preview = screen.getByAltText('Photo')
        const frame = screen.getByRole('button', { name: 'Zoom in on photo' })
        const size = frame.getAttribute('style')
        fireEvent.click(frame)
        const detail = container.querySelector('.linen-lightbox-photo-detail')
        let finishDecode
        detail.decode = () => new Promise(resolve => { finishDecode = resolve })
        fireEvent.load(detail)
        expect(detail).not.toHaveClass('is-ready')
        expect(preview).toHaveAttribute('srcset', props.srcSet)
        expect(preview).toHaveAttribute('src', props.src)
        expect(onLoad).not.toHaveBeenCalled()
        expect(frame.getAttribute('style')).toBe(size)

        // A delayed upgrade can finish during zoom-out without changing the
        // transform, replacing the preview, or restarting the viewer's fade.
        fireEvent.click(frame)
        const transform = preview.parentElement.style.transform
        await act(async () => finishDecode())
        expect(detail).toHaveClass('is-ready')
        expect(preview.parentElement.style.transform).toBe(transform)
        expect(screen.getByAltText('Photo')).toBe(preview)
        expect(frame.getAttribute('style')).toBe(size)
        fireEvent.click(frame)
        expect(container.querySelector('.linen-lightbox-photo-detail')).toBe(detail)
        expect(preview).toHaveAttribute('srcset', props.srcSet)
        expect(onLoad).not.toHaveBeenCalled()
    })

    it.each(['error', 'decode'])('keeps the photo usable after a detail %s failure and retries on the next zoom', async (failure) => {
        const onError = vi.fn()
        const { container } = render(<PhotoZoomFrame {...props} onError={onError} />)
        const frame = screen.getByRole('button', { name: 'Zoom in on photo' })
        fireEvent.click(frame)
        const detail = container.querySelector('.linen-lightbox-photo-detail')
        if (failure === 'decode') {
            detail.decode = () => Promise.reject(new Error('Unable to decode'))
            await act(async () => fireEvent.load(detail))
        } else fireEvent.error(detail)
        expect(container.querySelector('.linen-lightbox-photo-detail')).toBeNull()
        expect(screen.getByAltText('Photo')).toHaveAttribute('srcset', props.srcSet)
        expect(frame).toBeEnabled()
        expect(onError).not.toHaveBeenCalled()
        fireEvent.click(frame)
        fireEvent.click(frame)
        expect(container.querySelector('.linen-lightbox-photo-detail')).not.toBe(detail)
    })

    it('ignores a late decode from a replaced media URL', async () => {
        const { container, rerender } = render(<PhotoZoomFrame {...props} />)
        fireEvent.click(screen.getByRole('button', { name: 'Zoom in on photo' }))
        const detail = container.querySelector('.linen-lightbox-photo-detail')
        let finishDecode
        detail.decode = () => new Promise(resolve => { finishDecode = resolve })
        fireEvent.load(detail)
        rerender(<PhotoZoomFrame {...props} src="https://media.test/refreshed.jpg" />)
        await act(async () => finishDecode())
        expect(container.querySelector('.linen-lightbox-photo-detail')).toBeNull()
        expect(screen.getByAltText('Photo')).toHaveAttribute('src', 'https://media.test/refreshed.jpg')
    })
})
