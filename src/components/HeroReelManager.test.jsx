import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
    fetchHeroReelStatus: vi.fn(),
    requestHeroReelDraft: vi.fn(),
    publishHeroReel: vi.fn(),
}))
const auth = vi.hoisted(() => ({ getIdToken: vi.fn() }))
vi.mock('../utils/videoHeroApi', () => api)
vi.mock('../context/auth', () => ({ useAuth: () => auth }))

import HeroReelManager, { HERO_REEL_POLL_MS } from './HeroReelManager'

const record = (version, extra = {}) => ({
    version,
    mode: 'auto',
    createdAt: '2026-10-01T10:00:00Z',
    publishedAt: '2026-10-01T10:05:00Z',
    duration: 59.6,
    clipCount: 14,
    sourceCount: 9,
    cuts: [0, 1].map((cut) => ({
        posterUrl: `https://media.example/${version}/poster-${cut}.jpg`,
        renditions: [
            { url: `https://media.example/${version}/reel-${cut}-1920x1080.mp4`, width: 1920, height: 1080 },
            { url: `https://media.example/${version}/reel-${cut}-1280x720.mp4`, width: 1280, height: 720 },
            { url: `https://media.example/${version}/reel-${cut}-608x1080.mp4`, width: 608, height: 1080 },
        ],
    })),
    ...extra,
})
const LIVE = 'a'.repeat(24)
const DRAFT = 'b'.repeat(24)

async function flush() {
    await act(async () => {})
}

describe('hero reel manager', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.clearAllMocks()
        auth.getIdToken.mockResolvedValue('admin-token')
        vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
        vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
        vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    })
    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it('shows every live cut with desktop and phone previews', async () => {
        api.fetchHeroReelStatus.mockResolvedValue({ job: null, draft: null, published: record(LIVE), auto: null })
        render(<HeroReelManager />)
        await flush()
        const live = screen.getByLabelText('Live hero video cut 1 (desktop version)')
        expect(live).toHaveAttribute('src', expect.stringContaining('reel-0-1920x1080.mp4'))
        expect(live).toHaveAttribute('poster', expect.stringContaining('poster-0.jpg'))
        expect(screen.getByText(/built automatically · 2 cuts · about 60 seconds each · ~14 clips per cut from 9 videos/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Cut 2' }))
        fireEvent.click(screen.getByRole('button', { name: 'Phone' }))
        expect(screen.getByLabelText('Live hero video cut 2 (phone version)')).toHaveAttribute('src', expect.stringContaining('reel-1-608x1080.mp4'))
        expect(screen.getByRole('button', { name: 'Cut 2' })).toHaveAttribute('aria-pressed', 'true')
        expect(screen.queryByText('New draft')).not.toBeInTheDocument()
    })

    it('shows a single older reel without cut buttons', async () => {
        const single = { ...record(LIVE), cuts: [record(LIVE).cuts[0]] }
        api.fetchHeroReelStatus.mockResolvedValue({ job: null, draft: null, published: single, auto: null })
        render(<HeroReelManager />)
        await flush()
        expect(screen.getByLabelText('Live hero video (desktop version)')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Cut 1' })).not.toBeInTheDocument()
    })

    it('regenerates a draft, polls until it is ready, then publishes it', async () => {
        api.fetchHeroReelStatus.mockResolvedValueOnce({ job: null, draft: null, published: record(LIVE), auto: { status: 'failed', reason: 'no_ready_videos' } })
        render(<HeroReelManager />)
        await flush()
        expect(screen.getByText(/last automatic rebuild did not finish: None of your public videos/)).toBeInTheDocument()

        api.requestHeroReelDraft.mockResolvedValue({ job: { requestId: 'r1', mode: 'draft', status: 'queued' } })
        fireEvent.click(screen.getByRole('button', { name: 'Regenerate videos' }))
        await flush()
        expect(api.requestHeroReelDraft).toHaveBeenCalledWith('admin-token')
        expect(screen.getByRole('button', { name: 'Generating…' })).toBeDisabled()
        expect(screen.getByText(/Generating new reels from your videos/)).toBeInTheDocument()

        api.fetchHeroReelStatus.mockResolvedValueOnce({ job: { requestId: 'r1', mode: 'draft', status: 'running', progress: 2, total: 5 }, draft: null, published: record(LIVE) })
        await act(async () => { await vi.advanceTimersByTimeAsync(HERO_REEL_POLL_MS) })
        expect(screen.getByText(/\(cut 3 of 5\)/)).toBeInTheDocument()
        api.fetchHeroReelStatus.mockResolvedValueOnce({
            job: { requestId: 'r1', mode: 'draft', status: 'ready', version: DRAFT },
            draft: record(DRAFT, { mode: 'draft' }),
            published: record(LIVE),
        })
        await act(async () => { await vi.advanceTimersByTimeAsync(HERO_REEL_POLL_MS) })
        expect(screen.getByText('Your new reels are ready to preview below.')).toBeInTheDocument()
        expect(screen.getByLabelText('Draft hero video cut 1 (desktop version)')).toHaveAttribute('src', expect.stringContaining(DRAFT))

        api.publishHeroReel.mockResolvedValue({ job: { requestId: 'r2', mode: 'publish', status: 'queued', version: DRAFT } })
        fireEvent.click(screen.getByRole('button', { name: 'Publish these reels' }))
        await flush()
        expect(api.publishHeroReel).toHaveBeenCalledWith('admin-token', DRAFT)
        expect(screen.getByText('Publishing the new reels…')).toBeInTheDocument()

        api.fetchHeroReelStatus.mockResolvedValueOnce({
            job: { requestId: 'r2', mode: 'publish', status: 'published', version: DRAFT },
            draft: null,
            published: record(DRAFT, { mode: 'manual' }),
        })
        await act(async () => { await vi.advanceTimersByTimeAsync(HERO_REEL_POLL_MS) })
        expect(screen.getByText('The new reels are live on the Video page.')).toBeInTheDocument()
        expect(screen.getByLabelText('Live hero video cut 1 (desktop version)')).toHaveAttribute('src', expect.stringContaining(DRAFT))
        expect(screen.getByRole('button', { name: 'Regenerate videos' })).toBeEnabled()
    })

    it('explains failed jobs and request errors', async () => {
        api.fetchHeroReelStatus.mockResolvedValueOnce({ job: { requestId: 'r1', mode: 'draft', status: 'running' }, published: null })
        render(<HeroReelManager />)
        await flush()
        expect(screen.getByText(/No reel is published yet/)).toBeInTheDocument()
        api.fetchHeroReelStatus.mockResolvedValueOnce({ job: { requestId: 'r1', mode: 'draft', status: 'failed', reason: 'not_enough_footage' }, published: null })
        await act(async () => { await vi.advanceTimersByTimeAsync(HERO_REEL_POLL_MS) })
        expect(screen.getByRole('alert')).toHaveTextContent('not enough calm footage')

        api.requestHeroReelDraft.mockRejectedValue(new Error('A hero video job is already in progress'))
        fireEvent.click(screen.getByRole('button', { name: 'Regenerate videos' }))
        await flush()
        expect(screen.getByRole('alert')).toHaveTextContent('already in progress')
        api.requestHeroReelDraft.mockRejectedValue({})
        fireEvent.click(screen.getByRole('button', { name: 'Regenerate videos' }))
        await flush()
        expect(screen.getByRole('alert')).toHaveTextContent('The request could not be sent.')
    })

    it('reports an unknown failure generically and a status outage', async () => {
        api.fetchHeroReelStatus.mockResolvedValueOnce({ job: { requestId: 'r1', mode: 'draft', status: 'queued' } })
        const { unmount } = render(<HeroReelManager />)
        await flush()
        api.fetchHeroReelStatus.mockResolvedValueOnce({ job: { requestId: 'r1', mode: 'draft', status: 'failed', reason: 'ffmpeg_failed' } })
        await act(async () => { await vi.advanceTimersByTimeAsync(HERO_REEL_POLL_MS) })
        expect(screen.getByRole('alert')).toHaveTextContent('could not be generated this time')
        unmount()

        api.fetchHeroReelStatus.mockRejectedValueOnce(new Error('Service unavailable'))
        render(<HeroReelManager />)
        await flush()
        expect(screen.getByRole('alert')).toHaveTextContent('Service unavailable')
    })
})
