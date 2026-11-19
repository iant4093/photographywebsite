import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PhotoZoomFrame from './PhotoZoomFrame'
import { lightboxMotionControllers, requestLightboxClose } from '../utils/lightboxMotionControl'

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
    render(<PhotoZoomFrame {...props} srcSet={undefined} />)
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
    const fullResolutionSrc = 'https://media.test/original.jpg'
    const objectUrl = 'blob:https://media.test/image'
    let fetchImage, decode, createObjectURL, revokeObjectURL
    const imageResponse = { ok: true, blob: async () => new Blob(['image'], { type: 'image/jpeg' }) }

    beforeEach(() => {
        vi.useFakeTimers()
        fetchImage = vi.fn().mockResolvedValue(imageResponse)
        decode = vi.fn().mockResolvedValue(undefined)
        createObjectURL = vi.fn().mockReturnValue(objectUrl)
        revokeObjectURL = vi.fn()
        vi.stubGlobal('fetch', fetchImage)
        vi.stubGlobal('Image', class {
            decode() { return decode() }
        })
        vi.stubGlobal('URL', class extends URL {
            static createObjectURL = createObjectURL
            static revokeObjectURL = revokeObjectURL
        })
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it('waits 800 ms after the preview loads and replaces the actual image only after the original decodes', async () => {
        const onLoad = vi.fn()
        let finishDecode
        decode.mockImplementation(() => new Promise(resolve => { finishDecode = resolve }))
        const { rerender, unmount } = render(<PhotoZoomFrame {...props} loaded={false} fullResolutionSrc={fullResolutionSrc} onLoad={onLoad} />)
        await act(async () => vi.advanceTimersByTimeAsync(800))
        expect(fetchImage).not.toHaveBeenCalled()

        rerender(<PhotoZoomFrame {...props} fullResolutionSrc={fullResolutionSrc} onLoad={onLoad} />)
        const photo = screen.getByAltText('Photo')
        const frame = screen.getByRole('button', { name: 'Zoom in on photo' })
        const size = frame.getAttribute('style')
        await act(async () => vi.advanceTimersByTimeAsync(799))
        expect(fetchImage).not.toHaveBeenCalled()
        await act(async () => vi.advanceTimersByTimeAsync(1))
        expect(fetchImage).toHaveBeenCalledWith(fullResolutionSrc, { signal: expect.any(AbortSignal) })
        expect(photo).toHaveAttribute('srcset', props.srcSet)

        await act(async () => finishDecode())
        const original = screen.getByAltText('Photo')
        expect(photo).not.toBeInTheDocument()
        expect(original).toHaveAttribute('src', objectUrl)
        expect(original).not.toHaveAttribute('srcset')
        expect(original).not.toHaveAttribute('sizes')
        expect(frame.getAttribute('style')).toBe(size)
        fireEvent.load(original)
        expect(onLoad).not.toHaveBeenCalled()
        unmount()
        expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(objectUrl)
    })

    it('starts immediately on zoom and keeps the original across zoom toggles', async () => {
        const { unmount } = render(<PhotoZoomFrame {...props} />)
        const frame = screen.getByRole('button', { name: 'Zoom in on photo' })
        await act(async () => fireEvent.click(frame))
        expect(fetchImage).toHaveBeenCalledWith(props.src, { signal: expect.any(AbortSignal) })
        expect(screen.getByAltText('Photo')).toHaveAttribute('src', objectUrl)
        fireEvent.click(frame)
        fireEvent.click(frame)
        await act(async () => vi.advanceTimersByTimeAsync(1000))
        expect(fetchImage).toHaveBeenCalledOnce()
        expect(screen.getByAltText('Photo')).toHaveAttribute('src', objectUrl)
        unmount()
    })

    it('clears the dwell timer on a fast navigation and aborts a transfer when the photo changes again', async () => {
        let finishFetch
        fetchImage.mockImplementationOnce(() => new Promise(resolve => { finishFetch = resolve }))
        const { rerender } = render(<PhotoZoomFrame {...props} />)
        await act(async () => vi.advanceTimersByTimeAsync(500))
        rerender(<PhotoZoomFrame {...props} src="https://media.test/second.jpg" />)
        await act(async () => vi.advanceTimersByTimeAsync(800))

        expect(fetchImage).toHaveBeenCalledExactlyOnceWith('https://media.test/second.jpg', { signal: expect.any(AbortSignal) })
        const { signal } = fetchImage.mock.calls[0][1]
        rerender(<PhotoZoomFrame {...props} src="https://media.test/third.jpg" />)
        expect(signal.aborted).toBe(true)
        await act(async () => finishFetch(imageResponse))
        expect(createObjectURL).not.toHaveBeenCalled()
        expect(screen.getByAltText('Photo')).toHaveAttribute('src', 'https://media.test/third.jpg')
    })

    it('aborts when the close animation starts and releases a stale image that is still decoding', async () => {
        let finishDecode
        decode.mockImplementation(() => new Promise(resolve => { finishDecode = resolve }))
        const { container, unmount } = render(<div className="linen-lightbox"><PhotoZoomFrame {...props} /></div>)
        const dialog = container.firstChild
        const requestClose = vi.fn()
        lightboxMotionControllers.set(dialog, { requestClose })
        await act(async () => vi.advanceTimersByTimeAsync(800))
        const { signal } = fetchImage.mock.calls[0][1]
        const close = vi.fn()
        requestLightboxClose(screen.getByAltText('Photo'), close)
        expect(requestClose).toHaveBeenCalledExactlyOnceWith(close)
        expect(signal.aborted).toBe(true)
        await act(async () => finishDecode())
        expect(screen.getByAltText('Photo')).toHaveAttribute('srcset', props.srcSet)
        unmount()
        expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(objectUrl)
    })

    it('keeps the preview available after a failed upgrade and can retry on zoom', async () => {
        decode.mockRejectedValueOnce(new Error('Unable to decode'))
        const onError = vi.fn()
        const { unmount } = render(<PhotoZoomFrame {...props} onError={onError} />)
        await act(async () => vi.advanceTimersByTimeAsync(800))
        expect(screen.getByAltText('Photo')).toHaveAttribute('srcset', props.srcSet)
        expect(onError).not.toHaveBeenCalled()
        await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Zoom in on photo' })))
        expect(fetchImage).toHaveBeenCalledTimes(2)
        expect(screen.getByAltText('Photo')).toHaveAttribute('src', objectUrl)
        unmount()
    })
})
