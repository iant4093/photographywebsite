import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import FloatingGallery from './FloatingGallery'

function makeAlbums(count) {
    return Array.from({ length: count }, (_, index) => ({
        albumId: `album-${index + 1}`,
        title: `Album ${index + 1}`,
        category: `Category ${index % 4}`,
        coverImageUrl: `https://images.test/${index + 1}.jpg`,
    }))
}

describe('FloatingGallery', () => {
    beforeEach(() => { window.matchMedia = vi.fn(() => ({ matches: false })) })
    afterEach(() => vi.unstubAllGlobals())

    it('bounds the width of animated tracks on mobile', () => {
        vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query.includes('pointer: coarse') }))
        const { container } = render(<MemoryRouter><FloatingGallery albums={makeAlbums(75)} /></MemoryRouter>)
        expect(container.querySelectorAll('.floating-lane')).toHaveLength(3)
        expect(container.querySelectorAll('.floating-print-card')).toHaveLength(24)
        expect(screen.getAllByRole('link')).toHaveLength(12)
    })

    it('pauses a visible wall while the document is hidden', () => {
        vi.stubGlobal('IntersectionObserver', undefined)
        const { container } = render(<MemoryRouter><FloatingGallery albums={makeAlbums(12)} /></MemoryRouter>)
        const wall = container.querySelector('.floating-print-wall')
        expect(wall).toHaveClass('is-floating-visible')
        const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
        fireEvent(document, new Event('visibilitychange'))
        expect(wall).not.toHaveClass('is-floating-visible')
        hidden.mockReturnValue(false)
        fireEvent(document, new Event('visibilitychange'))
        expect(wall).toHaveClass('is-floating-visible')
    })

    it('selects stable randomized lanes from the full available catalog', () => {
        const albums = makeAlbums(36)
        const view = render(
            <MemoryRouter>
                <FloatingGallery albums={albums} />
            </MemoryRouter>,
        )
        const selectedHrefs = () => Array.from(
            view.container.querySelectorAll('.floating-lane > .floating-loop-track > .floating-loop-group:first-child a'),
            (link) => link.getAttribute('href'),
        )
        const firstSelection = selectedHrefs()

        expect(firstSelection).toHaveLength(30)
        expect(new Set(firstSelection)).toHaveLength(30)
        view.rerender(
            <MemoryRouter>
                <FloatingGallery albums={[...albums]} />
            </MemoryRouter>,
        )
        expect(selectedHrefs()).toEqual(firstSelection)
    })

    it('ignores albums without covers and de-duplicates repeated catalog entries', () => {
        const covered = makeAlbums(4)
        const { container } = render(
            <MemoryRouter>
                <FloatingGallery albums={[
                    ...covered,
                    { ...covered[0], title: 'Duplicate' },
                    { albumId: 'missing-cover', title: 'Missing cover' },
                ]} />
            </MemoryRouter>,
        )
        const firstLaneHrefs = Array.from(
            container.querySelectorAll('.floating-lane-0 .floating-loop-group:first-child a'),
            (link) => link.getAttribute('href'),
        )

        expect(firstLaneHrefs).toHaveLength(4)
        expect(new Set(firstLaneHrefs)).toHaveLength(4)
        expect(firstLaneHrefs).not.toContain('/album/missing-cover')
    })

    it('keeps visual loop copies clickable while removing duplicates from assistive navigation', () => {
        vi.stubGlobal('IntersectionObserver', undefined)
        const { container } = render(
            <MemoryRouter>
                <FloatingGallery albums={makeAlbums(30)} />
            </MemoryRouter>,
        )

        expect(screen.getAllByRole('link')).toHaveLength(30)
        expect(container.querySelectorAll('.floating-print-card')).toHaveLength(60)
        expect(container.querySelectorAll('.floating-loop-group[aria-hidden="true"]')).toHaveLength(3)
        const duplicateLinks = container.querySelectorAll('.floating-loop-group[aria-hidden="true"] a')
        expect(duplicateLinks).toHaveLength(30)
        duplicateLinks.forEach((link) => expect(link).toHaveAttribute('tabindex', '-1'))
        expect(container.querySelector('.floating-print-wall')).toHaveClass('is-floating-visible')
        expect(container.querySelector('.floating-lane').style.maskImage)
            .toBe('linear-gradient(90deg,transparent,#000 3%,#000 97%,transparent)')
    })

    it('slows rather than stops the wall for pointer and keyboard interaction', () => {
        vi.stubGlobal('IntersectionObserver', undefined)
        const { container } = render(
            <MemoryRouter>
                <FloatingGallery albums={makeAlbums(12)} />
            </MemoryRouter>,
        )
        const wall = container.querySelector('.floating-print-wall')
        const animations = Array.from(container.querySelectorAll('.floating-loop-track'), () => ({
            updatePlaybackRate: vi.fn(),
        }))
        container.querySelectorAll('.floating-loop-track').forEach((track, index) => {
            track.getAnimations = () => [animations[index]]
        })

        fireEvent.pointerEnter(wall, { pointerType: 'mouse' })
        animations.forEach((animation) => expect(animation.updatePlaybackRate).toHaveBeenCalledWith(0.38))
        fireEvent.pointerLeave(wall)
        animations.forEach((animation) => expect(animation.updatePlaybackRate).toHaveBeenCalledWith(1))

        const firstLink = screen.getAllByRole('link')[0]
        fireEvent.focus(firstLink)
        animations.forEach((animation) => expect(animation.updatePlaybackRate).toHaveBeenCalledWith(0.38))
        fireEvent.blur(firstLink, { relatedTarget: document.body })
        animations.forEach((animation) => expect(animation.updatePlaybackRate).toHaveBeenCalledWith(1))
    })

    it('uses a slower-duration class when the Web Animations API is unavailable', () => {
        vi.stubGlobal('IntersectionObserver', undefined)
        const { container } = render(
            <MemoryRouter>
                <FloatingGallery albums={makeAlbums(12)} />
            </MemoryRouter>,
        )
        const wall = container.querySelector('.floating-print-wall')

        fireEvent.pointerEnter(wall)
        expect(wall).toHaveClass('is-floating-slow-fallback')
        fireEvent.pointerLeave(wall)
        expect(wall).not.toHaveClass('is-floating-slow-fallback')
    })

    it('starts observing when asynchronously loaded albums create the wall', () => {
        const observe = vi.fn()
        const unobserve = vi.fn()
        const observers = []
        vi.stubGlobal('IntersectionObserver', class {
            constructor(callback) {
                this.callback = callback
                this.targets = []
                this.disconnect = vi.fn()
                observers.push(this)
            }
            observe(element) {
                this.targets.push(element)
                observe(element)
            }
            unobserve(element) {
                unobserve(element)
            }
        })
        const view = render(
            <MemoryRouter>
                <FloatingGallery albums={[]} />
            </MemoryRouter>,
        )

        expect(view.container.querySelector('.floating-print-wall')).toBeNull()
        expect(observe).not.toHaveBeenCalled()

        view.rerender(
            <MemoryRouter>
                <FloatingGallery albums={makeAlbums(12)} />
            </MemoryRouter>,
        )
        const wall = view.container.querySelector('.floating-print-wall')
        expect(observe).toHaveBeenCalledWith(wall)
        const intersectionCallback = observers.find(observer => observer.targets.includes(wall)).callback

        act(() => intersectionCallback([{ isIntersecting: true }]))
        expect(wall).toHaveClass('is-floating-visible')
        act(() => intersectionCallback([{ isIntersecting: false }]))
        expect(wall).not.toHaveClass('is-floating-visible')

        view.unmount()
        // Both the wall animation and the shared image observer release work.
        observers.forEach(observer => expect(observer.disconnect).toHaveBeenCalledOnce())
    })
})
