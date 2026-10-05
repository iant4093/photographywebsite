import { selectChoice } from '../test/selectChoice'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ getIdToken: vi.fn() }))
const api = vi.hoisted(() => ({ fetchCostReport: vi.fn() }))

vi.mock('../context/auth', () => ({ useAuth: () => auth }))
vi.mock('../utils/api', () => ({ fetchCostReport: api.fetchCostReport }))

import AwsCosts from './AwsCosts'

const REPORT = {
    schemaVersion: 1,
    generatedAt: '2026-08-03T12:00:00Z',
    dataThrough: '2026-08-02',
    currency: 'USD',
    currentMonth: '2026-08',
    forecastTotal: 18.75,
    cacheStatus: 'fresh',
    months: [
        {
            month: '2026-07', total: 10, estimated: false,
            services: [{ name: 'Amazon S3', amount: 6, share: 60 }, { name: 'CloudFront', amount: 4, share: 40 }],
        },
        {
            month: '2026-08', total: 12, estimated: true,
            services: [{ name: 'Amazon S3', amount: 9, share: 75 }, { name: 'AWS Lambda', amount: 3, share: 25 }],
        },
    ],
}

function renderPage() {
    return render(<MemoryRouter><AwsCosts /></MemoryRouter>)
}

describe('AWS costs admin page', () => {
    beforeEach(() => {
        auth.getIdToken.mockReset().mockResolvedValue('admin-token')
        api.fetchCostReport.mockReset().mockResolvedValue(REPORT)
    })

    it('renders the daily overview, forecast, trend, and service breakdown', async () => {
        const { container } = renderPage()
        expect(screen.getByRole('status', { name: 'Loading AWS cost report' })).toBeInTheDocument()
        expect(await screen.findByRole('heading', { name: 'AWS Costs' })).toBeInTheDocument()
        await waitFor(() => expect(screen.getByText('$12.00')).toBeInTheDocument())
        expect(screen.getByText('$18.75')).toBeInTheDocument()
        expect(screen.getByText('AWS Lambda')).toBeInTheDocument()
        expect(screen.getByText('+20.0%')).toBeInTheDocument()
        expect(screen.getByRole('img', { name: 'Monthly AWS cost chart' })).toBeInTheDocument()
        expect(container.querySelectorAll('[style*="height"]')).toHaveLength(2)
        expect(api.fetchCostReport).toHaveBeenCalledWith('admin-token', { signal: expect.any(AbortSignal) })
    })

    it('switches months and clearly marks a stale report', async () => {
        api.fetchCostReport.mockResolvedValue({ ...REPORT, cacheStatus: 'stale' })
        renderPage()
        expect(await screen.findByText(/last successful daily snapshot/i)).toBeInTheDocument()
        selectChoice(screen.getByLabelText('Report month'), '2026-07')
        expect(screen.getByText('CloudFront')).toBeInTheDocument()
        expect(screen.getAllByText('$10.00').length).toBeGreaterThan(0)
        expect(screen.getByText('Forecast shown only for the current month')).toBeInTheDocument()
    })

    it('shows an empty service state and handles a zero previous month', async () => {
        api.fetchCostReport.mockResolvedValue({
            ...REPORT,
            forecastTotal: null,
            months: [
                { month: '2026-07', total: 0, estimated: false, services: [] },
                { month: '2026-08', total: 0, estimated: true, services: [] },
            ],
        })
        renderPage()
        expect(await screen.findByText('No AWS service costs were recorded for this month.')).toBeInTheDocument()
        expect(screen.getAllByText('Not available').length).toBeGreaterThan(0)
    })

    it('forecasts next month and ranks albums by storage and bandwidth', async () => {
        const row = (albumId, title, extra) => ({ albumId, title, type: 'photo', visibility: 'public', deleted: false, storageBytes: 0, objectCount: 0, bandwidthBytes: 0, ...extra })
        api.fetchCostReport.mockResolvedValue({
            ...REPORT,
            nextMonth: { month: '2026-09', forecastTotal: 14.5, trendPerMonth: 1.25 },
            albumUsage: {
                kind: 'album-usage', schemaVersion: 1, storageBytes: 5_400_000_000, albumCount: 3, bandwidthBytes: 120_000_000_000,
                bandwidthWindow: { from: '2026-07-03', to: '2026-08-01', days: 30 },
                byStorage: [
                    row('a', 'Wedding Film', { type: 'video', visibility: 'private', storageBytes: 4_000_000_000, objectCount: 14 }),
                    row('b', 'Coast', { storageBytes: 900_000_000, objectCount: 1 }),
                    row('c', 'Old Trip', { deleted: true, visibility: 'unlisted', storageBytes: 512 }),
                ],
                byBandwidth: [row('b', 'Coast', { bandwidthBytes: 100_000_000_000 }), row('d', 'Odd', { visibility: 'other', bandwidthBytes: 0 })],
            },
        })
        renderPage()
        expect(await screen.findByText('$14.50')).toBeInTheDocument()
        expect(screen.getByText('September 2026 · trend +$1.25/month')).toBeInTheDocument()
        const panel = screen.getByRole('heading', { name: 'Biggest albums' }).closest('.aws-cost-panel')
        expect(panel).toHaveTextContent('5.4 GB across 3 albums · about $0.12/month')
        expect(panel).toHaveTextContent('Wedding FilmVideo · Client4.0 GB')
        expect(panel).toHaveTextContent('≈ $0.09/month · 14 files')
        expect(panel).toHaveTextContent('Photos · Main Gallery900 MB')
        expect(panel).toHaveTextContent('≈ $0.02/month · 1 file')
        expect(panel).toHaveTextContent('Photos · Recently deleted512 B')
        expect(screen.getByRole('button', { name: 'Storage' })).toHaveAttribute('aria-pressed', 'true')

        fireEvent.click(screen.getByRole('button', { name: 'Bandwidth · 30 days' }))
        expect(screen.getByRole('button', { name: 'Bandwidth · 30 days' })).toHaveAttribute('aria-pressed', 'true')
        expect(panel).toHaveTextContent('120 GB served from Jul 3, 2026 to Aug 1, 2026 · about $10.20')
        expect(panel).toHaveTextContent('Coast')
        expect(panel).toHaveTextContent('≈ $8.50 over 30 days')
        expect(panel).toHaveTextContent('Photos · Link only0 B')
    })

    it('explains when album usage and next month are not ready yet', async () => {
        api.fetchCostReport.mockResolvedValue({
            ...REPORT,
            nextMonth: { month: '2026-09', forecastTotal: 0, trendPerMonth: -2 },
            albumUsage: { kind: 'album-usage', schemaVersion: 1, storageBytes: 0, albumCount: 1, bandwidthBytes: 0, byStorage: [], byBandwidth: [] },
        })
        const view = renderPage()
        expect(await screen.findByText('September 2026 · trend −$2.00/month')).toBeInTheDocument()
        expect(screen.getByText('No album files were found.')).toBeInTheDocument()
        expect(screen.getByText(/0 B across 1 album ·/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Bandwidth · 30 days' }))
        expect(screen.getByText('No album bandwidth was recorded in this window yet.')).toBeInTheDocument()
        expect(screen.getByText(/^0 B served · about/)).toBeInTheDocument()
        view.unmount()

        api.fetchCostReport.mockResolvedValue(REPORT)
        renderPage()
        expect(await screen.findByText('Album sizes and bandwidth appear after the first daily usage run.')).toBeInTheDocument()
        expect(screen.getByText('Available after the next daily refresh')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Storage' })).toBeNull()
    })

    it('shows a safe error and retries the page request', async () => {
        api.fetchCostReport.mockRejectedValueOnce(new Error('The service is temporarily unavailable.'))
            .mockResolvedValueOnce(REPORT)
        renderPage()
        expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable')
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
        await waitFor(() => expect(api.fetchCostReport).toHaveBeenCalledTimes(2))
        expect(await screen.findByText('$12.00')).toBeInTheDocument()
    })

    it('aborts an in-flight request when leaving the page', async () => {
        let signal
        api.fetchCostReport.mockImplementation((_token, options) => {
            signal = options.signal
            return new Promise(() => {})
        })
        const page = renderPage()
        await waitFor(() => expect(signal).toBeInstanceOf(AbortSignal))
        page.unmount()
        expect(signal.aborted).toBe(true)
    })
})
