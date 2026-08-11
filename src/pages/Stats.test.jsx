import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ fetchPhotographyStats: vi.fn() }))
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

describe('photography statistics page', () => {
    beforeEach(() => vi.clearAllMocks())
    afterEach(() => vi.restoreAllMocks())

    it('renders the available aggregate archive, timeline, category, and EXIF data', async () => {
        api.fetchPhotographyStats.mockResolvedValue(report)
        render(<Stats />)

        expect(screen.getByRole('status', { name: 'Loading photography statistics' })).toBeInTheDocument()
        expect(await screen.findByText('63,900')).toBeInTheDocument()
        expect(screen.getByRole('heading', { level: 1, name: 'Photography Stats' })).toBeInTheDocument()
        expect(screen.getByRole('heading', { level: 2, name: 'Capture Stats' })).toBeInTheDocument()
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

    it('shows a safe failure and retries successfully', async () => {
        api.fetchPhotographyStats
            .mockRejectedValueOnce(new Error('Service unavailable'))
            .mockResolvedValueOnce(report)
        render(<Stats />)

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
        const view = render(<Stats />)
        view.unmount()
        await act(async () => rejectRequest())
        expect(screen.queryByRole('alert')).toBeNull()
        await waitFor(() => expect(api.fetchPhotographyStats).toHaveBeenCalledOnce())
    })
})
