import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
    afterEach(() => vi.unstubAllGlobals())

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

    it('keeps every visible loop copy interactive across all three lanes', () => {
        vi.stubGlobal('IntersectionObserver', undefined)
        const { container } = render(
            <MemoryRouter>
                <FloatingGallery albums={makeAlbums(30)} />
            </MemoryRouter>,
        )

        expect(screen.getAllByRole('link')).toHaveLength(60)
        expect(container.querySelectorAll('.floating-print-card')).toHaveLength(60)
        expect(container.querySelectorAll('.floating-loop-group[aria-hidden="true"]')).toHaveLength(0)
        expect(container.querySelectorAll('.floating-loop-group[inert]')).toHaveLength(0)
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
        let intersectionCallback
        const observe = vi.fn()
        const disconnect = vi.fn()
        vi.stubGlobal('IntersectionObserver', class {
            constructor(callback) {
                intersectionCallback = callback
            }
            observe(element) {
                observe(element)
            }
            disconnect() {
                disconnect()
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

        act(() => intersectionCallback([{ isIntersecting: true }]))
        expect(wall).toHaveClass('is-floating-visible')
        act(() => intersectionCallback([{ isIntersecting: false }]))
        expect(wall).not.toHaveClass('is-floating-visible')

        view.unmount()
        expect(disconnect).toHaveBeenCalledOnce()
    })
})
