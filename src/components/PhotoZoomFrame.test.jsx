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

// JSDOM does not implement PointerEvent; retain real mouse coordinates while
// supplying the pointer identity used by both mouse and touch gestures.
function pointer(frame, type, options = {}) {
    const { pointerId = 1, pointerType = 'mouse', ...coordinates } = options
    fireEvent(frame, Object.assign(new MouseEvent(type, { bubbles: true, button: 0, ...coordinates }), {
        pointerId, pointerType, isPrimary: true,
    }))
}

function zoomedFrame() {
    render(<PhotoZoomFrame {...props} />)
    const frame = screen.getByRole('button', { name: 'Zoom in on photo' })
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 800, height: 600 })
    frame.setPointerCapture = vi.fn()
    frame.hasPointerCapture = vi.fn().mockReturnValue(true)
    frame.releasePointerCapture = vi.fn()
    fireEvent.click(frame)
    return { frame, surface: screen.getByAltText('Photo').parentElement }
}

describe('PhotoZoomFrame panning', () => {
    it.each(['mouse', 'touch'])('drags a zoomed photo with %s without zooming out on release', (pointerType) => {
        const { frame, surface } = zoomedFrame()
        pointer(frame, 'pointerdown', { pointerType, clientX: 400, clientY: 300 })
        expect(frame.setPointerCapture).toHaveBeenCalledWith(1)
        pointer(frame, 'pointermove', { pointerType, clientX: 520, clientY: 390 })
        expect(surface).toHaveStyle({ transform: 'translate(-60%, -60%) scale(2.5)' })
        expect(frame).toHaveClass('is-panning')
        pointer(frame, 'pointerup', { pointerType, clientX: 520, clientY: 390 })
        fireEvent.click(frame, { detail: 1, clientX: 520, clientY: 390 })
        expect(frame).toHaveAttribute('aria-pressed', 'true')
        expect(frame).not.toHaveClass('is-panning')
        expect(frame.releasePointerCapture).toHaveBeenCalledWith(1)

        pointer(frame, 'pointerdown', { pointerType, clientX: 520, clientY: 390 })
        pointer(frame, 'pointerup', { pointerType, clientX: 520, clientY: 390 })
        fireEvent.click(frame, { detail: 1, clientX: 520, clientY: 390 })
        expect(frame).toHaveAttribute('aria-pressed', 'false')
    })

    it('keeps the photo within its edges and immediately responds when dragging back', () => {
        const { frame, surface } = zoomedFrame()
        pointer(frame, 'pointerdown', { clientX: 400, clientY: 300 })
        pointer(frame, 'pointermove', { clientX: 4000, clientY: 3000 })
        expect(surface).toHaveStyle({ transform: 'translate(0%, 0%) scale(2.5)' })
        pointer(frame, 'pointermove', { clientX: 3880, clientY: 2910 })
        expect(surface).toHaveStyle({ transform: 'translate(-15%, -15%) scale(2.5)' })
        pointer(frame, 'pointermove', { clientX: -4000, clientY: -3000 })
        expect(surface).toHaveStyle({ transform: 'translate(-150%, -150%) scale(2.5)' })
    })

    it('treats a small finger movement as a tap and ignores unrelated pointers', () => {
        const { frame, surface } = zoomedFrame()
        pointer(frame, 'pointerdown', { clientX: 400, clientY: 300 })
        pointer(frame, 'pointermove', { pointerId: 2, clientX: 600, clientY: 450 })
        pointer(frame, 'pointerup', { pointerId: 2 })
        pointer(frame, 'pointermove', { clientX: 402, clientY: 301 })
        expect(surface).toHaveStyle({ transform: 'translate(-75%, -75%) scale(2.5)' })
        pointer(frame, 'pointerup', { clientX: 402, clientY: 301 })
        fireEvent.click(frame, { detail: 1 })
        expect(frame).toHaveAttribute('aria-pressed', 'false')
    })

    it.each(['pointercancel', 'lostpointercapture'])('ends a drag on %s', (eventType) => {
        const { frame, surface } = zoomedFrame()
        pointer(frame, 'pointerdown', { clientX: 400, clientY: 300 })
        pointer(frame, 'pointermove', { clientX: 520, clientY: 390 })
        pointer(frame, eventType)
        const transform = surface.style.transform
        pointer(frame, 'pointermove', { clientX: 640, clientY: 480 })
        expect(surface.style.transform).toBe(transform)
        expect(frame).not.toHaveClass('is-panning')
    })
})

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
