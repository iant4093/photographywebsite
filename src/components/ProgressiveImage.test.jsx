import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import ProgressiveImage from './ProgressiveImage'
vi.mock('react-blurhash', () => ({ Blurhash: () => <canvas data-testid="blur-placeholder" /> }))

describe('ProgressiveImage responsive fallback', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('releases distant images and canvases, then restores them on reverse scrolling', () => {
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
            expect(screen.getByTestId('blur-placeholder')).toBeInTheDocument()
            fireEvent.load(screen.getByRole('img'))
            expect(screen.queryByTestId('blur-placeholder')).toBeNull()
            expect(screen.getByRole('img')).toHaveClass('opacity-100')
            act(() => notify([{ target, isIntersecting: false }]))
            expect(screen.queryByRole('img')).toBeNull()
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
        expect(screen.queryByRole('img', { name: 'One' })).toBeNull()
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
