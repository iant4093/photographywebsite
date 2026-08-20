import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ fetchAlbums: vi.fn(), fetchPhotographyStats: vi.fn() }))
vi.mock('../utils/api', () => api)

import Stats from './Stats'


const report = {
    generatedAt: '2026-08-11T10:00:00Z',
    taken: { photos: 63900, videos: 1081 },
    kept: { photos: 2855, videos: 31, photoPercent: 4.5, videoPercent: 2.9 },
    storage: { totalBytes: 1135083324424 },
    albums: { photos: 69, videos: 13 },
    outputByYear: [
        { year: 2025, photoAlbums: 11, photos: 289, videoAlbums: 1, videos: 2 },
        { year: 2026, photoAlbums: 58, photos: 2566, videoAlbums: 12, videos: 29 },
    ],
    categories: [
        { category: 'Hikes', albums: 31, photos: 855, videos: 12 },
        { category: 'Portraits', albums: 9, photos: 553, videos: 0 },
    ],
    mostActive: {
        year: { year: 2026, photoAlbums: 58, photos: 2566, videoAlbums: 12, videos: 29 },
        category: { category: 'Hikes', albums: 31, photos: 855, videos: 12 },
    },
    gear: {
        cameras: [{ name: 'Canon EOS R7', photos: 2499 }],
        lenses: [
            { name: '17-40mm F1.8 DC | Art 025', photos: 1635 },
            { name: 'Sirui Nightwalker 75mm T1.2', photos: 15 },
        ],
        manualLensFallback: 'Sirui Nightwalker 75mm T1.2',
    },
}

const timelineAlbums = [
    {
        albumId: 'older-photo', type: 'photo', title: 'Older Photo Album', category: 'Portraits',
        createdAt: '2025-02-01T12:00:00Z', coverThumbnailUrl: 'https://media.test/older.jpg',
    },
    {
        albumId: 'newer-video', type: 'video', title: 'Newer Video Album', category: 'Hikes',
        createdAt: '2026-07-04T12:00:00Z', coverThumbnailUrl: 'https://media.test/newer.jpg',
    },
    {
        albumId: 'same-day-photo', type: 'photo', title: 'Same Day Photo Album', category: 'Hikes',
        createdAt: '2026-07-04T08:00:00Z', coverThumbnailUrl: 'https://media.test/same-day.jpg',
    },
]

function renderStats() {
    return render(<MemoryRouter><Stats /></MemoryRouter>)
}

describe('photography statistics page', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        api.fetchAlbums.mockResolvedValue(timelineAlbums)
    })
    afterEach(() => vi.restoreAllMocks())

    it('renders the available aggregate archive, timeline, category, and EXIF data', async () => {
        api.fetchPhotographyStats.mockResolvedValue(report)
        const view = renderStats()

        expect(screen.getByRole('status', { name: 'Loading photography statistics' })).toBeInTheDocument()
        expect(await screen.findByText('63,900')).toBeInTheDocument()
        expect(screen.getByRole('heading', { level: 1, name: 'Photography Stats' })).toBeInTheDocument()
        expect(screen.getByRole('heading', { level: 2, name: 'Capture Stats' })).toBeInTheDocument()
        expect(screen.getByRole('heading', { level: 2, name: 'Album Timeline' })).toBeInTheDocument()
        expect(screen.queryByText(/Public archive · newest first/i)).toBeNull()
        expect(screen.getByLabelText('Public albums, newest to oldest')).toBeInTheDocument()
        expect(screen.getAllByRole('link').map((link) => link.textContent))
            .toEqual(expect.arrayContaining([
                expect.stringContaining('Newer Video Album'),
                expect.stringContaining('Same Day Photo Album'),
                expect.stringContaining('Older Photo Album'),
            ]))
        expect(screen.getAllByRole('link')[0]).toHaveAttribute('href', '/video/newer-video')
        expect(screen.getAllByRole('link')[1]).toHaveAttribute('href', '/album/same-day-photo')
        expect(screen.getAllByRole('link')[2]).toHaveAttribute('href', '/album/older-photo')
        expect(screen.getAllByRole('link')[0]).toHaveAttribute('data-timeline-position', 'above')
        expect(screen.getAllByRole('link')[1]).toHaveAttribute('data-timeline-position', 'below')
        expect(screen.getAllByRole('link')[0].closest('li')).toBe(screen.getAllByRole('link')[1].closest('li'))
        expect(screen.getAllByRole('link')[0].closest('li')).toHaveAttribute('data-timeline-album-count', '2')
        expect(screen.getAllByText('Jul 4, 2026')).toHaveLength(1)
        const timelinePoints = view.container.querySelectorAll('.photo-stats-timeline-item')
        expect(timelinePoints[0].style.getPropertyValue('--timeline-x')).toBe('0rem')
        expect(Number.parseFloat(timelinePoints[1].style.getPropertyValue('--timeline-x'))).toBeGreaterThan(1000)
        expect(view.container.querySelector('[data-timeline-month="2026-07"]')).toBeInTheDocument()
        expect(view.container.querySelector('[data-timeline-year="2026"]')).toBeInTheDocument()
        expect(view.container.querySelector('[data-timeline-year="2025"]')).toBeInTheDocument()
        expect(view.container.querySelector('[data-timeline-year="2026"]')).toHaveTextContent('2026')
        expect(view.container.querySelector('[data-timeline-month="2026-07"]')).toHaveTextContent('Jul')
        expect(view.container.querySelector('[data-active-timeline-year]')).toBeNull()
        expect(view.container.querySelectorAll('.photo-stats-timeline-progressive-image')).toHaveLength(3)
        const firstTimelineCard = screen.getAllByRole('link')[0]
        expect(firstTimelineCard).not.toHaveClass('photo-stats-motion-item')
        expect(firstTimelineCard.closest('.photo-stats-timeline-section')).toHaveClass('photo-stats-motion-section')
        expect(view.container.querySelectorAll('.photo-stats-motion-section')).toHaveLength(6)
        expect(view.container.querySelector('.photo-stats-motion-item')).toBeNull()
        fireEvent.error(firstTimelineCard.querySelector('img'))
        await waitFor(() => expect(firstTimelineCard.querySelector('.photo-stats-timeline-image-fallback')).toBeInTheDocument())
        expect(api.fetchAlbums).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }))
        expect(screen.getByRole('heading', { level: 2, name: 'Total Storage Used' })).toBeInTheDocument()
        expect(screen.getByRole('heading', { level: 2, name: 'Gear' })).toBeInTheDocument()
        expect(screen.getByText('Photos taken')).toBeInTheDocument()
        expect(screen.getByText('Videos taken')).toBeInTheDocument()
        expect(screen.getByRole('progressbar', { name: 'Photos kept: 4.5 percent' })).toHaveAttribute('aria-valuenow', '4.5')
        expect(screen.getByRole('progressbar', { name: 'Videos kept: 2.9 percent' })).toBeInTheDocument()
        expect(screen.getByText('1.03 TB')).toBeInTheDocument()
        expect(screen.getByRole('columnheader', { name: 'Videos' })).toBeInTheDocument()
        expect(screen.queryByRole('columnheader', { name: /total published media/i })).toBeNull()
        expect(screen.getAllByText('Hikes')).toHaveLength(2)
        expect(screen.getByText('Canon EOS R7')).toBeInTheDocument()
        expect(screen.getByText('Sirui Nightwalker 75mm T1.2')).toBeInTheDocument()
        expect(screen.queryByText(/Image files in the raw archive/)).toBeNull()
        expect(screen.queryByText(/A living record of photographs/)).toBeNull()
        expect(screen.queryByText(/Field notes · The numbers behind the photographs/)).toBeNull()
        expect(screen.queryByText(/All photo and video files across the raw archive/)).toBeNull()
        expect(screen.queryByText(/Public photographic series/)).toBeNull()
        expect(screen.queryByText(/Public moving-image collections/)).toBeNull()
        expect(screen.queryByText(/Photos without lens metadata are attributed/)).toBeNull()
    })

    it('moves the album timeline with its visible navigation controls', async () => {
        api.fetchPhotographyStats.mockResolvedValue(report)
        renderStats()

        const scroller = await screen.findByLabelText('Public albums, newest to oldest')
        Object.defineProperties(scroller, {
            clientWidth: { configurable: true, value: 500 },
            scrollLeft: { configurable: true, value: 0, writable: true },
        })
        scroller.scrollTo = vi.fn()

        fireEvent.click(screen.getByRole('button', { name: 'Scroll timeline toward older albums' }))

        expect(scroller.scrollTo).toHaveBeenCalledWith({ left: 390, behavior: 'smooth' })
    })

    it('shows a safe failure and retries successfully', async () => {
        api.fetchPhotographyStats
            .mockRejectedValueOnce(new Error('Service unavailable'))
            .mockResolvedValueOnce(report)
        renderStats()

        expect(await screen.findByRole('alert')).toHaveTextContent('Service unavailable')
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
        expect(await screen.findByText('63,900')).toBeInTheDocument()
        expect(api.fetchPhotographyStats).toHaveBeenCalledTimes(2)
    })

    it('aborts its request on unmount without showing an error', async () => {
        let rejectRequest
        api.fetchPhotographyStats.mockImplementation(({ signal }) => new Promise((_resolve, reject) => {
            rejectRequest = () => reject(new DOMException('Aborted', 'AbortError'))
            signal.addEventListener('abort', rejectRequest, { once: true })
        }))
        const view = renderStats()
        view.unmount()
        await act(async () => rejectRequest())
        expect(screen.queryByRole('alert')).toBeNull()
        await waitFor(() => expect(api.fetchPhotographyStats).toHaveBeenCalledOnce())
    })

    it('keeps aggregate statistics available when the album timeline cannot load', async () => {
        api.fetchPhotographyStats.mockResolvedValue(report)
        api.fetchAlbums.mockRejectedValue(new Error('Timeline unavailable'))
        renderStats()

        expect(await screen.findByText('63,900')).toBeInTheDocument()
        expect(screen.getByRole('alert')).toHaveTextContent('The album timeline could not be loaded.')
        expect(screen.getByRole('heading', { level: 2, name: 'Capture Stats' })).toBeInTheDocument()
    })
})
