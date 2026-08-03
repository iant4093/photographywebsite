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
        fireEvent.change(screen.getByLabelText('Report month'), { target: { value: '2026-07' } })
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
