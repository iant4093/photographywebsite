import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ getIdToken: vi.fn() }))
const api = vi.hoisted(() => ({ fetchGoogleDriveUsage: vi.fn() }))

vi.mock('../context/auth', () => ({ useAuth: () => auth }))
vi.mock('../utils/api', () => ({ fetchGoogleDriveUsage: api.fetchGoogleDriveUsage }))

import GoogleDriveUsage from './GoogleDriveUsage'
import { formatBytes } from '../utils/formatBytes'

const REPORT = {
    schemaVersion: 2,
    generatedAt: '2026-08-03T12:00:00Z',
    nextRefreshAt: '2026-08-04T00:00:00Z',
    cacheStatus: 'fresh',
    quotaAvailable: true,
    limitBytes: 100 * (1024 ** 3),
    usageBytes: 40 * (1024 ** 3),
    driveBytes: 30 * (1024 ** 3),
    trashBytes: 2 * (1024 ** 3),
    otherGoogleBytes: 10 * (1024 ** 3),
    remainingBytes: 60 * (1024 ** 3),
    percentUsed: 40,
    maxUploadBytes: 5 * (1024 ** 4),
    websiteBackup: {
        totalBytes: 15 * (1024 ** 3), fileCount: 12, folderCount: 4,
        categories: {
            photos: { bytes: 5 * (1024 ** 3), fileCount: 8 },
            videos: { bytes: 10 * (1024 ** 3), fileCount: 3 },
            other: { bytes: 0, fileCount: 1 },
        },
    },
    rawPhotoBackup: {
        totalBytes: 20 * (1024 ** 3), fileCount: 25, folderCount: 6,
        categories: {
            images: { bytes: 18 * (1024 ** 3), fileCount: 20 },
            videos: { bytes: 2 * (1024 ** 3), fileCount: 2 },
            other: { bytes: 0, fileCount: 3 },
        },
    },
}

function renderPage() {
    return render(<MemoryRouter><GoogleDriveUsage /></MemoryRouter>)
}

describe('Google Drive usage admin page', () => {
    beforeEach(() => {
        auth.getIdToken.mockReset().mockResolvedValue('admin-token')
        api.fetchGoogleDriveUsage.mockReset().mockResolvedValue(REPORT)
    })

    it('renders account capacity and aggregate website and raw backup categories', async () => {
        renderPage()
        expect(screen.getByRole('status', { name: 'Loading Google Drive usage report' })).toBeInTheDocument()
        expect(await screen.findByRole('heading', { name: 'Google Drive Usage' })).toBeInTheDocument()
        await waitFor(() => expect(screen.getByText('40 GB')).toBeInTheDocument())
        expect(screen.getByText('60 GB')).toBeInTheDocument()
        expect(screen.getByText('15 GB')).toBeInTheDocument()
        expect(screen.getByText('12 files in 4 folders')).toBeInTheDocument()
        expect(screen.getByText('20 GB')).toBeInTheDocument()
        expect(screen.getByText('25 files in 6 folders')).toBeInTheDocument()
        expect(screen.getByRole('progressbar', { name: 'Google account storage used' })).toHaveAttribute('aria-valuenow', '40')
        expect(screen.getByText('Photos')).toBeInTheDocument()
        expect(screen.getByText('Images')).toBeInTheDocument()
        expect(screen.getAllByText('Videos')).toHaveLength(2)
        expect(screen.getByText(/metadata-only and limited by its shared-folder permission/i)).toBeInTheDocument()
        expect(api.fetchGoogleDriveUsage).toHaveBeenCalledWith('admin-token', { signal: expect.any(AbortSignal) })
    })

    it('explains unavailable quotas and displays stale snapshots', async () => {
        api.fetchGoogleDriveUsage.mockResolvedValue({
            ...REPORT,
            cacheStatus: 'stale',
            quotaAvailable: false,
            limitBytes: null,
            remainingBytes: null,
            percentUsed: null,
        })
        renderPage()
        expect(await screen.findByText(/last successful daily snapshot/i)).toBeInTheDocument()
        expect(screen.getByText(/service accounts and pooled Google Workspace storage/i)).toBeInTheDocument()
        expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    })

    it('shows a safe error, retries, and aborts when unmounted', async () => {
        api.fetchGoogleDriveUsage.mockRejectedValueOnce(new Error('The service is temporarily unavailable.'))
            .mockResolvedValueOnce(REPORT)
        const page = renderPage()
        expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable')
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
        await waitFor(() => expect(api.fetchGoogleDriveUsage).toHaveBeenCalledTimes(2))
        expect(await screen.findByText('40 GB')).toBeInTheDocument()
        const signal = api.fetchGoogleDriveUsage.mock.calls[1][1].signal
        page.unmount()
        expect(signal.aborted).toBe(true)
    })

    it('formats bounded byte values without exposing invalid values', () => {
        expect(formatBytes(0)).toBe('0 B')
        expect(formatBytes(1536)).toBe('1.5 KB')
        expect(formatBytes(null)).toBe('Not available')
        expect(formatBytes(-1)).toBe('Not available')
    })
})
