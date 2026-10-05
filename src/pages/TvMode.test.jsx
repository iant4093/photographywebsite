import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ fetchAllFavoritePhotos: vi.fn() }))
vi.mock('../utils/api', () => api)

import TvMode, { FADE_MS } from './TvMode'
import { TV_SETTINGS_KEY } from '../utils/tvSlideshow'

const srcSet = (name) => [640, 960, 1440, 1920].map((width) => ({ width, url: `https://cdn.test/${name}-${width}.webp` }))
const photo = (name, extra = {}) => ({
    id: name, url: `https://cdn.test/${name}.jpg`, previewSrcSet: srcSet(name), width: 3000, height: 2000,
    albumTitle: `Album ${name}`, exif: { model: 'Canon EOS R7', focalRatio: 'f/4' }, ...extra,
})

class TestPointerEvent extends MouseEvent {
    constructor(type, init = {}) {
        super(type, init)
        this.pointerType = init.pointerType || 'mouse'
    }
}

let images
class FakeImage {
    constructor() { images.push(this) }
    set src(value) {
        this._src = value
        queueMicrotask(() => (value.includes('broken') ? this.onerror?.() : this.onload?.()))
    }
    get src() { return this._src }
    decode() { return Promise.resolve() }
    removeAttribute() {}
}

async function flush() {
    for (let index = 0; index < 6; index += 1) await act(async () => { await Promise.resolve() })
}

function mounted(entries = ['/', '/tv']) {
    return render(
        <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
            <Routes>
                <Route path="/" element={<h1>Home page</h1>} />
                <Route path="/contact" element={<h1>Contact page</h1>} />
                <Route path="/tv" element={<TvMode />} />
            </Routes>
        </MemoryRouter>,
    )
}

const current = () => document.querySelector('.tv-layer.is-current .tv-frame img')

describe('TV mode', () => {
    beforeEach(() => {
        images = []
        vi.useFakeTimers()
        vi.stubGlobal('Image', FakeImage)
        vi.stubGlobal('PointerEvent', TestPointerEvent)
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800 })
        localStorage.setItem(TV_SETTINGS_KEY, JSON.stringify({ order: 'newest' }))
        api.fetchAllFavoritePhotos.mockResolvedValue({ images: [photo('a'), photo('b', { width: 2000, height: 3000 }), photo('c')] })
        Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true })
    })
    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
        localStorage.clear()
        delete document.fullscreenEnabled
        delete document.fullscreenElement
    })

    it('waits for the first decoded photo, then plays through every favorite', async () => {
        mounted()
        expect(screen.getByRole('status')).toHaveTextContent('Gathering favorite photos…')
        await flush()
        expect(current()).toHaveAttribute('src', 'https://cdn.test/a.jpg')
        expect(current()).toHaveAttribute('sizes', '1200px')
        expect(current().getAttribute('srcset')).toContain('a-1920.webp 1920w')
        expect(screen.getByText('1 / 3')).toBeInTheDocument()
        expect(screen.getByText('Album a')).toBeInTheDocument()
        expect(screen.getByText('Canon EOS R7 · f/4')).toBeInTheDocument()
        expect(document.documentElement.style.overflow).toBe('hidden')
        // Photos ahead are decoded at the size their slide will use.
        expect(images.find((image) => image._src === 'https://cdn.test/b.jpg').sizes).toBe('534px')

        await act(async () => { vi.advanceTimersByTime(8000) })
        await flush()
        expect(current()).toHaveAttribute('src', 'https://cdn.test/b.jpg')
        expect(document.querySelectorAll('.tv-layer')).toHaveLength(2)
        await act(async () => { vi.advanceTimersByTime(FADE_MS) })
        expect(document.querySelectorAll('.tv-layer')).toHaveLength(1)
        expect(screen.getByText('2 / 3')).toBeInTheDocument()
    })

    it('moves, pauses and closes from buttons and the keyboard', async () => {
        mounted()
        await flush()
        fireEvent.click(screen.getByRole('button', { name: 'Next photo' }))
        await flush()
        expect(screen.getByText('2 / 3')).toBeInTheDocument()
        fireEvent.keyDown(window, { key: 'ArrowLeft' })
        await flush()
        expect(screen.getByText('1 / 3')).toBeInTheDocument()
        fireEvent.keyDown(window, { key: 'ArrowLeft' })
        await flush()
        expect(screen.getByText('3 / 3')).toBeInTheDocument()

        fireEvent.keyDown(window, { key: ' ' })
        expect(screen.getByRole('button', { name: 'Play slideshow' })).toBeInTheDocument()
        await act(async () => { vi.advanceTimersByTime(30000) })
        expect(screen.getByText('3 / 3')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Play slideshow' }))
        // Playing again lets the idle controls hide.
        expect(screen.getByRole('button', { name: 'Pause slideshow', hidden: true })).toBeInTheDocument()
        fireEvent.keyDown(window, { key: 'q' })
        fireEvent.keyDown(window, { key: 'ArrowRight', ctrlKey: true })
        expect(screen.getByText('3 / 3')).toBeInTheDocument()

        fireEvent.keyDown(window, { key: 'Escape' })
        expect(screen.getByRole('heading', { name: 'Home page' })).toBeInTheDocument()
        expect(document.documentElement.style.overflow).toBe('')
    })

    it('hides the controls when idle and wakes them on movement', async () => {
        const { container } = mounted()
        await flush()
        const root = container.querySelector('.tv-mode')
        expect(root).toHaveClass('is-awake')
        await act(async () => { vi.advanceTimersByTime(3100) })
        expect(root).not.toHaveClass('is-awake')
        fireEvent.pointerMove(root, { clientX: 10 })
        expect(root).toHaveClass('is-awake')
        await act(async () => { vi.advanceTimersByTime(3100) })
        expect(root).not.toHaveClass('is-awake')
        // Touch: a tap shows the controls, a second tap hides them.
        fireEvent.pointerMove(root, { pointerType: 'touch' })
        expect(root).not.toHaveClass('is-awake')
        fireEvent.pointerDown(root, { pointerType: 'touch', clientX: 100, clientY: 100 })
        fireEvent.pointerUp(root, { pointerType: 'touch', clientX: 102, clientY: 101 })
        expect(root).toHaveClass('is-awake')
        fireEvent.pointerDown(root, { pointerType: 'touch', clientX: 100, clientY: 100 })
        fireEvent.pointerUp(root, { pointerType: 'touch', clientX: 100, clientY: 100 })
        expect(root).not.toHaveClass('is-awake')
        // A swipe moves between photos.
        fireEvent.pointerDown(root, { pointerType: 'touch', clientX: 400, clientY: 100 })
        fireEvent.pointerUp(root, { pointerType: 'touch', clientX: 200, clientY: 110 })
        await flush()
        expect(screen.getByText('2 / 3')).toBeInTheDocument()
        fireEvent.pointerDown(root, { clientX: 200, clientY: 100 })
        fireEvent.pointerUp(root, { clientX: 400, clientY: 100 })
        await flush()
        expect(screen.getByText('1 / 3')).toBeInTheDocument()
        fireEvent.pointerUp(root, { clientX: 400, clientY: 100 })
        fireEvent.pointerDown(root, { clientX: 1, clientY: 1 })
        fireEvent.pointerUp(screen.getByRole('button', { name: 'Next photo' }), { clientX: 300, clientY: 1 })
        expect(screen.getByText('1 / 3')).toBeInTheDocument()
    })

    it('saves settings and applies them to the show', async () => {
        const { container } = mounted()
        await flush()
        fireEvent.click(screen.getByRole('button', { name: 'Slideshow settings' }))
        const panel = screen.getByRole('dialog', { name: 'Slideshow settings' })
        expect(panel).toHaveTextContent('Space pauses')
        fireEvent.click(screen.getByRole('button', { name: '30s' }))
        fireEvent.click(screen.getByRole('button', { name: 'Dark' }))
        fireEvent.click(screen.getByLabelText('Clock'))
        fireEvent.click(screen.getByLabelText('Album & camera'))
        fireEvent.click(screen.getByLabelText('Progress bar'))
        fireEvent.click(screen.getByLabelText('Slow zoom'))
        const root = container.querySelector('.tv-mode')
        expect(root.style.getPropertyValue('--tv-interval')).toBe('30s')
        expect(root).not.toHaveClass('has-motion')
        expect(container.querySelector('.tv-backdrop')).toBeNull()
        expect(container.querySelector('.tv-clock')).toBeNull()
        expect(container.querySelector('.tv-caption')).toBeNull()
        expect(container.querySelector('.tv-progress')).not.toBeNull()
        expect(JSON.parse(localStorage.getItem(TV_SETTINGS_KEY))).toMatchObject({ interval: 30, background: 'dark', clock: false, caption: false, progress: true, motion: false })

        // Shuffling keeps the photo on screen.
        fireEvent.click(screen.getByRole('button', { name: 'Shuffle' }))
        expect(current()).toHaveAttribute('src', 'https://cdn.test/a.jpg')
        fireEvent.click(screen.getByRole('button', { name: 'Shuffle' }))
        fireEvent.click(screen.getByRole('button', { name: 'Newest first' }))
        expect(screen.getByText('1 / 3')).toBeInTheDocument()

        fireEvent.keyDown(window, { key: 'Escape' })
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(screen.getByRole('region', { name: 'Favorite photos slideshow' })).toBeInTheDocument()
        await act(async () => { vi.advanceTimersByTime(29000) })
        expect(screen.getByText('1 / 3')).toBeInTheDocument()
    })

    it('skips a photo that cannot load and handles empty and failed lists', async () => {
        api.fetchAllFavoritePhotos.mockResolvedValueOnce({ images: [photo('broken'), photo('ok')] })
        const first = mounted()
        await flush()
        expect(current()).toHaveAttribute('src', 'https://cdn.test/ok.jpg')
        expect(screen.getByRole('button', { name: 'Next photo' })).toBeEnabled()
        first.unmount()

        api.fetchAllFavoritePhotos.mockResolvedValueOnce({ images: [] })
        const empty = mounted()
        await flush()
        expect(screen.getByText('There are no favorite photos to show yet.')).toBeInTheDocument()
        empty.unmount()

        api.fetchAllFavoritePhotos.mockRejectedValueOnce(new Error('offline'))
        mounted(['/tv'])
        await flush()
        expect(screen.getByText('The slideshow could not load.')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
        await flush()
        expect(current()).toHaveAttribute('src', 'https://cdn.test/a.jpg')
        fireEvent.click(screen.getByRole('button', { name: 'Close slideshow' }))
        expect(screen.getByRole('heading', { name: 'Home page' })).toBeInTheDocument()
    })

    it('toggles full screen and keeps the screen awake while playing', async () => {
        const release = vi.fn(() => Promise.resolve())
        const request = vi.fn(() => Promise.resolve({ release }))
        vi.stubGlobal('navigator', { ...navigator, wakeLock: { request } })
        const exitFullscreen = vi.fn(() => Promise.resolve())
        document.exitFullscreen = exitFullscreen
        const { container, unmount } = mounted()
        await flush()
        expect(request).toHaveBeenCalledWith('screen')
        const root = container.querySelector('.tv-mode')
        root.requestFullscreen = vi.fn(() => {
            Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: root })
            document.dispatchEvent(new Event('fullscreenchange'))
            return Promise.resolve()
        })
        fireEvent.click(screen.getByRole('button', { name: 'Full screen' }))
        await flush()
        expect(root.requestFullscreen).toHaveBeenCalled()
        expect(screen.getByRole('button', { name: 'Exit full screen' })).toBeInTheDocument()
        // Escape in full screen is the browser's; the slideshow stays.
        fireEvent.keyDown(window, { key: 'Escape' })
        expect(screen.getByRole('region', { name: 'Favorite photos slideshow' })).toBeInTheDocument()
        fireEvent.keyDown(window, { key: 'f' })
        expect(exitFullscreen).toHaveBeenCalledTimes(1)
        fireEvent.click(screen.getByRole('button', { name: 'Pause slideshow' }))
        await flush()
        expect(release).toHaveBeenCalled()
        unmount()
        expect(exitFullscreen).toHaveBeenCalledTimes(2)
        delete document.exitFullscreen
    })
})
