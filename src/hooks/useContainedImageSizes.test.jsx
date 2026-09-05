import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import useContainedImageSizes from './useContainedImageSizes'

afterEach(() => vi.unstubAllGlobals())

function Viewer({ show = true, image = { width: 6000, height: 4000 } }) {
    const { containerRef, sizesFor } = useContainedImageSizes()
    return <>
        {show && <div ref={containerRef} data-testid="media" />}
        <output>{sizesFor(image)}</output>
    </>
}

describe('useContainedImageSizes', () => {
    it('uses the fitted image width for landscape and portrait images without applying device pixel ratio twice', () => {
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 700, height: 300 })
        const { rerender } = render(<Viewer />)
        expect(screen.getByRole('status')).toHaveTextContent('450px')
        rerender(<Viewer image={{ width: 4000, height: 6000 }} />)
        expect(screen.getByRole('status')).toHaveTextContent('200px')
        rerender(<Viewer image={{ width: 9000, height: 1000 }} />)
        expect(screen.getByRole('status')).toHaveTextContent('700px')
    })

    it('remeasures container changes and disconnects when conditional media or the viewer disappears', () => {
        const observers = []
        vi.stubGlobal('ResizeObserver', class {
            constructor(callback) { this.callback = callback; this.observe = vi.fn(); this.disconnect = vi.fn(); observers.push(this) }
        })
        const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 700, height: 300 })
        const { rerender, unmount } = render(<Viewer show={false} />)
        expect(screen.getByRole('status')).toHaveTextContent('100vw')
        rerender(<Viewer />)
        expect(observers[0].observe).toHaveBeenCalledWith(screen.getByTestId('media'))
        rect.mockReturnValue({ width: 360, height: 580 })
        act(() => observers[0].callback())
        expect(screen.getByRole('status')).toHaveTextContent('360px')
        rerender(<Viewer show={false} />)
        expect(observers[0].disconnect).toHaveBeenCalledOnce()
        rect.mockReturnValue({ width: 100, height: 100 })
        act(() => observers[0].callback())
        expect(screen.getByRole('status')).toHaveTextContent('360px')
        rerender(<Viewer />)
        unmount()
        expect(observers[1].disconnect).toHaveBeenCalledOnce()
    })

    it('supports window resizing without ResizeObserver and falls back safely for unknown dimensions', () => {
        vi.stubGlobal('ResizeObserver', undefined)
        const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 390, height: 500 })
        const { rerender } = render(<Viewer image={{ width: 0 }} />)
        expect(screen.getByRole('status')).toHaveTextContent('390px')
        rect.mockReturnValue({ width: 844, height: 320 })
        act(() => window.dispatchEvent(new Event('resize')))
        expect(screen.getByRole('status')).toHaveTextContent('844px')
        rerender(<Viewer image={{ width: true, height: 500 }} />)
        expect(screen.getByRole('status')).toHaveTextContent('844px')
        rect.mockReturnValue({ width: 0, height: 0 })
        act(() => window.dispatchEvent(new Event('resize')))
        expect(screen.getByRole('status')).toHaveTextContent('100vw')
    })
})
