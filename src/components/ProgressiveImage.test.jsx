import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import ProgressiveImage from './ProgressiveImage'
vi.mock('../utils/imagePlaceholder', () => ({ imagePlaceholder: () => 'data:image/png;base64,placeholder' }))
import { RECENT_IMAGE_LIFETIME_MS } from '../utils/imageRetention'

describe('ProgressiveImage responsive fallback', () => {
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

    it('keeps recognizable pixels after full-image expiry without bypassing the initial fade', () => {
        vi.useFakeTimers()
        let notify
        vi.stubGlobal('IntersectionObserver', class {
            constructor(callback) { notify = callback }
            observe() {}
            unobserve() {}
            disconnect() {}
        })
        const draw = vi.fn()
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw })
        const view = render(<ProgressiveImage src="/photo.jpg" alt="Photo" />)
        const target = view.container.firstElementChild
        act(() => notify([{ target, isIntersecting: true }]))
        const fullImage = screen.getByRole('img')
        Object.defineProperties(fullImage, { naturalWidth: { value: 1920 }, naturalHeight: { value: 1280 } })
        fireEvent.load(fullImage)
        expect(target.querySelector('canvas')).toBeNull()
        fireEvent.animationEnd(fullImage)
        const snapshot = target.querySelector('canvas')
        expect(snapshot.width).toBe(192)
        act(() => {
            notify([{ target, isIntersecting: false }])
            vi.advanceTimersByTime(RECENT_IMAGE_LIFETIME_MS)
        })
        expect(screen.queryByRole('img')).toBeNull()
        expect(target.querySelector('canvas')).toBe(snapshot)
        act(() => notify([{ target, isIntersecting: true }]))
        expect(screen.getByRole('img')).toHaveClass('opacity-0')
        expect(target.querySelector('canvas')).toBe(snapshot)
        view.rerender(<ProgressiveImage src="/different.jpg" alt="Photo" />)
        expect(target.querySelector('canvas')).toBeNull()
        expect(snapshot.width * snapshot.height).toBe(0)
        expect(draw).toHaveBeenCalledOnce()
    })

    it('keeps the same decoded image node during quick scroll reversals', () => {
        vi.useFakeTimers()
        let notify
        vi.stubGlobal('IntersectionObserver', class {
            constructor(callback) { notify = callback }
            observe() {}
            unobserve() {}
            disconnect() {}
        })
        const view = render(<ProgressiveImage src="/photo.jpg" alt="Photo" />)
        const target = view.container.firstElementChild
        act(() => notify([{ target, isIntersecting: true }]))
        const original = screen.getByRole('img')
        fireEvent.load(original)
        for (let pass = 0; pass < 5; pass++) {
            act(() => {
                notify([{ target, isIntersecting: false }])
                vi.advanceTimersByTime(500)
                notify([{ target, isIntersecting: true }])
            })
            expect(screen.getByRole('img')).toBe(original)
            expect(original).toHaveClass('opacity-100')
        }
    })

    it('does not reuse loaded state for a different photograph', () => {
        const view = render(<ProgressiveImage eager src="/one.jpg" alt="Photo" />)
        fireEvent.load(screen.getByRole('img'))
        view.rerender(<ProgressiveImage eager src="/two.jpg" alt="Photo" />)
        expect(screen.getByRole('img')).toHaveAttribute('src', '/two.jpg')
        expect(screen.getByRole('img')).toHaveClass('opacity-0')
    })

    it('keeps the placeholder visible until an evicted full image loads again', () => {
        vi.useFakeTimers()
        let notify
        const unobserve = vi.fn()
        vi.stubGlobal('IntersectionObserver', class {
            constructor(callback) { notify = callback }
            observe() {}
            unobserve = unobserve
            disconnect() {}
        })
        const view = render(<ProgressiveImage src="/photo.jpg" blurhash="hash" alt="Photo" />)
        const target = view.container.firstElementChild
        for (let visit = 0; visit < 3; visit += 1) {
            act(() => notify([{ target, isIntersecting: true }]))
            expect(target.querySelector('.progressive-image-placeholder')).toBeInTheDocument()
            expect(screen.getByRole('img')).toHaveClass('opacity-0')
            fireEvent.load(screen.getByRole('img'))
            expect(target.querySelector('.progressive-image-placeholder')).toBeInTheDocument()
            expect(screen.getByRole('img')).toHaveClass('opacity-100')
            act(() => notify([{ target, isIntersecting: false }]))
            expect(screen.getByRole('img')).toBeInTheDocument()
            act(() => vi.advanceTimersByTime(RECENT_IMAGE_LIFETIME_MS))
            expect(screen.queryByRole('img')).toBeNull()
            expect(target.querySelector('.progressive-image-placeholder')).toBeInTheDocument()
            expect(target).toBeInTheDocument()
        }
        view.unmount()
        expect(unobserve).toHaveBeenCalledWith(target)
    })

    it('shares one observer while keeping image loading independent', () => {
        let notify
        const create = vi.fn()
        vi.stubGlobal('IntersectionObserver', class {
            constructor(callback) { notify = callback; create() }
            observe() {}
            unobserve() {}
            disconnect() {}
        })
        const view = render(<><ProgressiveImage src="/one.jpg" alt="One" /><ProgressiveImage src="/two.jpg" alt="Two" /></>)
        const [first, second] = view.container.children
        act(() => notify([{ target: first, isIntersecting: true }]))
        expect(screen.getByRole('img', { name: 'One' })).toBeInTheDocument()
        expect(screen.queryByRole('img', { name: 'Two' })).toBeNull()
        act(() => notify([{ target: first, isIntersecting: false }, { target: second, isIntersecting: true }]))
        expect(screen.getByRole('img', { name: 'One' })).toBeInTheDocument()
        expect(screen.getByRole('img', { name: 'Two' })).toBeInTheDocument()
        expect(create).toHaveBeenCalledOnce()
    })
    it('retries the legacy src without srcset before surfacing an error', () => {
        const onError = vi.fn()
        const { rerender } = render(
            <ProgressiveImage
                eager
                src="https://media.example.test/legacy.jpg"
                srcSet="https://media.example.test/preview-640.webp 640w, https://media.example.test/preview-1280.webp 1280w"
                sizes="100vw"
                alt="Preview"
                onError={onError}
            />,
        )

        fireEvent.error(screen.getByRole('img', { name: 'Preview' }))
        expect(onError).not.toHaveBeenCalled()
        expect(screen.getByRole('img', { name: 'Preview' })).not.toHaveAttribute('srcset')

        fireEvent.error(screen.getByRole('img', { name: 'Preview' }))
        expect(onError).toHaveBeenCalledOnce()

        rerender(
            <ProgressiveImage
                eager
                src="https://media.example.test/legacy.jpg"
                srcSet="https://media.example.test/new-640.webp 640w, https://media.example.test/new-1280.webp 1280w"
                sizes="100vw"
                alt="Preview"
                onError={onError}
            />,
        )
        expect(screen.getByRole('img', { name: 'Preview' })).toHaveAttribute('srcset')
    })

    it.each([false, true])('releases album background loading after both sources fail, including resubscription=%s', resubscribe => {
        vi.useFakeTimers()
        const callbacks = new Map()
        vi.stubGlobal('IntersectionObserver', class {
            constructor(callback, config) { callbacks.set(config.rootMargin, callback) }
            observe() {}
            unobserve() {}
            disconnect() {}
        })
        const onError = vi.fn()
        const gallery = blurhash => <>
            <ProgressiveImage eager viewportFirst src="/missing.jpg" srcSet="/missing-640.webp 640w" blurhash={blurhash} alt="First" onError={onError} />
            <ProgressiveImage viewportFirst src="/second.jpg" alt="Second" />
        </>
        const view = render(gallery('initial'))
        const [first, second] = view.container.children
        act(() => {
            callbacks.get('800px')([{ target: first, isIntersecting: true }, { target: second, isIntersecting: true }])
            callbacks.get('0px')([{ target: first, isIntersecting: true }, { target: second, isIntersecting: false }])
            vi.advanceTimersByTime(20)
        })
        fireEvent.error(screen.getByRole('img', { name: 'First' }))
        act(() => vi.advanceTimersByTime(20))
        expect(screen.queryByRole('img', { name: 'Second' })).toBeNull()
        fireEvent.error(screen.getByRole('img', { name: 'First' }))
        if (resubscribe) {
            view.rerender(gallery('updated'))
            act(() => callbacks.get('0px')([{ target: first, isIntersecting: true }]))
        }
        act(() => vi.advanceTimersByTime(20))
        expect(onError).toHaveBeenCalledOnce()
        expect(screen.getByRole('img', { name: 'Second' })).toHaveAttribute('src', '/second.jpg')
    })
})

describe('ProgressiveImage signed-cookie retry', () => {
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
    const privateSrc = () => `${window.location.origin}/private-media/albums/a1/thumbnails/photo.jpg`
    const image = () => screen.getByRole('img', { name: 'Private' })

    it('retries a failed private-media image with a cache-busting query and reveals it on success', () => {
        vi.useFakeTimers()
        const onError = vi.fn()
        render(<ProgressiveImage eager src={privateSrc()} alt="Private" onError={onError} />)
        fireEvent.error(image())
        // The first failure asks the page to refresh metadata (and cookies).
        expect(onError).toHaveBeenCalledOnce()
        expect(image()).toHaveClass('opacity-0')
        act(() => vi.advanceTimersByTime(1499))
        expect(image()).toHaveAttribute('src', privateSrc())
        act(() => vi.advanceTimersByTime(1))
        expect(image()).toHaveAttribute('src', `${privateSrc()}?r=1`)
        fireEvent.load(image())
        expect(image()).toHaveClass('opacity-100')
        expect(onError).toHaveBeenCalledOnce()
    })

    it('demotes a responsive private image to src, then stops after three retries', () => {
        vi.useFakeTimers()
        const onError = vi.fn()
        const src = `${privateSrc()}?v=2`
        render(<ProgressiveImage eager src={src} srcSet={`${privateSrc()}-640.webp 640w`} sizes="100vw" alt="Private" onError={onError} />)
        fireEvent.error(image())
        expect(image()).not.toHaveAttribute('srcset')
        expect(onError).not.toHaveBeenCalled()
        fireEvent.error(image())
        for (const [attempt, delay] of [[1, 1500], [2, 4000], [3, 8000]]) {
            act(() => vi.advanceTimersByTime(delay))
            expect(image()).toHaveAttribute('src', `${src}&r=${attempt}`)
            expect(image()).not.toHaveAttribute('srcset')
            fireEvent.error(image())
        }
        act(() => vi.advanceTimersByTime(60_000))
        expect(image()).toHaveAttribute('src', `${src}&r=3`)
        expect(image()).toHaveClass('opacity-100')
        expect(onError).toHaveBeenCalledOnce()
    })

    it('does not retry public media URLs, which get a fresh URL on refresh', () => {
        vi.useFakeTimers()
        const onError = vi.fn()
        const src = 'https://bucket.s3.us-west-2.amazonaws.com/albums/a1/photo.jpg?X-Amz-Signature=x'
        render(<ProgressiveImage eager src={src} alt="Private" onError={onError} />)
        fireEvent.error(image())
        act(() => vi.advanceTimersByTime(60_000))
        expect(image()).toHaveAttribute('src', src)
        expect(onError).toHaveBeenCalledOnce()
    })

    it('cancels a pending retry on unmount and when the source changes', () => {
        vi.useFakeTimers()
        const clear = vi.spyOn(window, 'clearTimeout')
        const view = render(<ProgressiveImage eager src={privateSrc()} alt="Private" />)
        fireEvent.error(image())
        const other = `${window.location.origin}/private-media/albums/a1/thumbnails/other.jpg`
        view.rerender(<ProgressiveImage eager src={other} alt="Private" />)
        act(() => vi.advanceTimersByTime(60_000))
        expect(image()).toHaveAttribute('src', other)
        fireEvent.error(image())
        const pending = vi.getTimerCount()
        expect(pending).toBeGreaterThan(0)
        clear.mockClear()
        view.unmount()
        expect(clear).toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
    })
})
