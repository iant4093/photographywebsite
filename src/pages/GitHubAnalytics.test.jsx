import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ getIdToken: vi.fn() }))
const api = vi.hoisted(() => ({ fetchGitHubAnalytics: vi.fn() }))
vi.mock('../context/auth', () => ({ useAuth: () => auth }))
vi.mock('../utils/api', () => ({ fetchGitHubAnalytics: api.fetchGitHubAnalytics }))

import GitHubAnalytics from './GitHubAnalytics'

const REPORT = {
  schemaVersion: 1, generatedAt: '2026-08-26T12:00:00Z', nextRefreshAt: '2026-08-26T13:20:00Z', cacheStatus: 'fresh',
  repository: { fullName: 'iant4093/photographywebsite', url: 'https://github.com/iant4093/photographywebsite', defaultBranch: 'main', pushedAt: '2026-08-26T11:00:00Z', openIssues: 2 },
  totalCommits: 432, commits30d: 31,
  loc: { total: 24000, files: 190, method: 'Nonblank source lines', areas: [{ name: 'Frontend', lines: 12000 }, { name: 'Tests', lines: 6000 }] },
  languages: [{ name: 'JavaScript', bytes: 1000, percent: 80 }, { name: 'Python', bytes: 250, percent: 20 }],
  workflow: { successRate: 96.5, successfulRuns: 28, completedRuns: 29, medianDurationSeconds: 185, latestConclusion: 'success' },
  activity: { status: 'ready', weeks: [{ week: 1787702400, additions: 120, deletions: 35 }] },
  recentRuns: [{ id: 1, name: 'Deploy', title: 'Add analytics', branch: 'main', status: 'completed', conclusion: 'success', createdAt: '2026-08-26T10:00:00Z', durationSeconds: 180, url: 'https://github.com/run' }],
  recentCommits: [{ sha: 'a'.repeat(40), shortSha: 'aaaaaaa', message: 'Add GitHub analytics', author: 'iant4093', date: '2026-08-26T10:00:00Z', url: 'https://github.com/commit' }],
}

describe('GitHub analytics admin page', () => {
  beforeEach(() => {
    auth.getIdToken.mockReset().mockResolvedValue('admin-token')
    api.fetchGitHubAnalytics.mockReset().mockResolvedValue(REPORT)
  })

  it('renders code, workflow, activity, commits, and repository data', async () => {
    render(<MemoryRouter><GitHubAnalytics /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'GitHub Analytics' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('24,000')).toBeInTheDocument())
    expect(screen.getByText('96.5%')).toBeInTheDocument()
    expect(screen.getByText('Add GitHub analytics')).toBeInTheDocument()
    expect(screen.getByText('Add analytics')).toBeInTheDocument()
    expect(screen.getByText('iant4093/photographywebsite')).toBeInTheDocument()
    expect(api.fetchGitHubAnalytics).toHaveBeenCalledWith('admin-token', { signal: expect.any(AbortSignal) })
  })

  it('shows stale snapshots and retries safe errors', async () => {
    api.fetchGitHubAnalytics.mockResolvedValueOnce({ ...REPORT, cacheStatus: 'stale' })
    const first = render(<MemoryRouter><GitHubAnalytics /></MemoryRouter>)
    expect(await screen.findByText(/showing the last successful snapshot/i)).toBeInTheDocument()
    first.unmount()

    api.fetchGitHubAnalytics.mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce(REPORT)
    render(<MemoryRouter><GitHubAnalytics /></MemoryRouter>)
    expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(api.fetchGitHubAnalytics).toHaveBeenCalledTimes(2))
  })

  it('renders unavailable metrics and in-progress activity without inventing values', async () => {
    api.fetchGitHubAnalytics.mockResolvedValueOnce({
      ...REPORT,
      repository: { ...REPORT.repository, pushedAt: 'not-a-date', openIssues: null },
      loc: { ...REPORT.loc, total: 0, areas: [] },
      workflow: {
        successRate: null,
        successfulRuns: 0,
        completedRuns: 0,
        medianDurationSeconds: null,
        latestConclusion: null,
      },
      activity: { status: 'preparing', weeks: [] },
      recentRuns: [{
        ...REPORT.recentRuns[0],
        title: '',
        branch: '',
        conclusion: null,
        status: 'in_progress',
        durationSeconds: 0,
      }],
      recentCommits: [{ ...REPORT.recentCommits[0], date: 'not-a-date' }],
    })

    render(<MemoryRouter><GitHubAnalytics /></MemoryRouter>)
    expect(await screen.findByText(/preparing repository activity statistics/i)).toBeInTheDocument()
    expect(screen.getByText('in progress')).toBeInTheDocument()
    expect(screen.getByText('detached', { exact: false })).toBeInTheDocument()
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Unknown')).toBeInTheDocument()
    expect(screen.getByText('0s')).toBeInTheDocument()
  })

  it('aborts an unfinished request when the page unmounts', async () => {
    api.fetchGitHubAnalytics.mockImplementationOnce(() => new Promise(() => {}))
    const view = render(<MemoryRouter><GitHubAnalytics /></MemoryRouter>)
    await waitFor(() => expect(api.fetchGitHubAnalytics).toHaveBeenCalledOnce())
    const signal = api.fetchGitHubAnalytics.mock.calls[0][1].signal
    expect(signal.aborted).toBe(false)
    view.unmount()
    expect(signal.aborted).toBe(true)
  })
})
