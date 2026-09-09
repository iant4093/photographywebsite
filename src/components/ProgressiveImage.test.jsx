import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import ProgressiveImage from './ProgressiveImage'
vi.mock('../utils/imagePlaceholder', () => ({ imagePlaceholder: () => 'data:image/png;base64,placeholder' }))
import { RECENT_IMAGE_LIFETIME_MS } from '../utils/imageRetention'

describe('ProgressiveImage responsive fallback', () => {
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

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
})
