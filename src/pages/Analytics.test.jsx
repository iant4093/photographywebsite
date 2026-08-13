import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ getIdToken: vi.fn() }))
const api = vi.hoisted(() => ({ fetchAnalyticsReport: vi.fn() }))
vi.mock('../context/auth', () => ({ useAuth: () => auth }))
vi.mock('../utils/api', () => ({ fetchAnalyticsReport: api.fetchAnalyticsReport }))

import Analytics from './Analytics'

const REPORT = {
    generatedAt: '2026-08-13T19:00:00Z',
    range: { days: 30, start: '2026-07-15', end: '2026-08-13' },
    visits: { today: 3, last7Days: 17, currentMonth: 21, selectedRange: 35 },
    totals: { pageViews: 88, albumViews: 41, photoDownloads: 6, zipRequests: 2, contactSubmissions: 1, explorePhotosClicks: 9, exploreVideosClicks: 4, frontendErrors: 1 },
    trends: {
        daily: [{ date: '2026-08-12', visits: 2, pageViews: 4, albumViews: 1 }, { date: '2026-08-13', visits: 3, pageViews: 6, albumViews: 2 }],
        weekly: [{ period: '2026-W33', visits: 5, pageViews: 10, albumViews: 3 }],
        monthly: [{ period: '2026-08', visits: 21, pageViews: 44, albumViews: 18 }],
    },
    albums: { photo: [{ albumId: 'a', title: 'Mountain Day', category: 'Hikes', views: 12 }], video: [{ albumId: 'v', title: 'Trail Film', category: 'Hikes', views: 5 }] },
    categories: [{ category: 'Hikes', views: 17 }],
    sources: [{ name: 'search', count: 14 }],
    devices: [{ name: 'mobile', count: 20 }],
    countries: [{ countryCode: 'US', count: 22 }],
    webVitals: [{ metric: 'LCP', average: 1900, samples: 10, ratings: { good: 8, 'needs-improvement': 2, poor: 0 } }],
    frontendErrors: [{ kind: 'resource', count: 1 }],
}

describe('Website Analytics admin page', () => {
    beforeEach(() => {
        auth.getIdToken.mockReset().mockResolvedValue('admin-token')
        api.fetchAnalyticsReport.mockReset().mockResolvedValue(REPORT)
    })

    it('renders all requested traffic, engagement, audience, and health sections', async () => {
        render(<MemoryRouter><Analytics /></MemoryRouter>)
        expect(screen.getByRole('status', { name: 'Loading website analytics' })).toBeInTheDocument()
        expect(await screen.findByRole('heading', { name: 'Website Analytics' })).toBeInTheDocument()
        expect(screen.queryByText('Anonymous aggregate telemetry')).not.toBeInTheDocument()
        expect(screen.getByText('Mountain Day')).toBeInTheDocument()
        expect(screen.getByText('Trail Film')).toBeInTheDocument()
        expect(screen.getByText('Individual photo downloads')).toBeInTheDocument()
        expect(screen.getByText('Search')).toBeInTheDocument()
        expect(screen.getByText('Mobile')).toBeInTheDocument()
        expect(screen.getByText('United States')).toBeInTheDocument()
        expect(screen.getByText('1,900 ms')).toBeInTheDocument()
        expect(screen.getByText('Resource')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Album views' }))
        expect(screen.getByRole('img', { name: 'Daily album views chart' })).toBeInTheDocument()
        expect(api.fetchAnalyticsReport).toHaveBeenCalledWith('admin-token', 30, { signal: expect.any(AbortSignal) })
    })

    it('changes range and interval, then safely retries an error', async () => {
        const page = render(<MemoryRouter><Analytics /></MemoryRouter>)
        await screen.findByText('Mountain Day')
        fireEvent.change(screen.getByLabelText('Report range'), { target: { value: '90' } })
        await waitFor(() => expect(api.fetchAnalyticsReport).toHaveBeenLastCalledWith('admin-token', 90, { signal: expect.any(AbortSignal) }))
        expect(screen.getByRole('button', { name: 'Week' })).toHaveClass('active')
        page.unmount()

        api.fetchAnalyticsReport.mockRejectedValueOnce(new Error('Analytics unavailable')).mockResolvedValueOnce(REPORT)
        render(<MemoryRouter><Analytics /></MemoryRouter>)
        expect(await screen.findByRole('alert')).toHaveTextContent('Analytics unavailable')
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
        expect(await screen.findByText('Mountain Day')).toBeInTheDocument()
    })
})
