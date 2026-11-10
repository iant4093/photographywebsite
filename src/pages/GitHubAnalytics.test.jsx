import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ getIdToken: vi.fn() }))
const api = vi.hoisted(() => ({ fetchGitHubAnalytics: vi.fn() }))
vi.mock('../context/auth', () => ({ useAuth: () => auth }))
vi.mock('../utils/api', () => ({ fetchGitHubAnalytics: api.fetchGitHubAnalytics }))

import GitHubAnalytics from './GitHubAnalytics'
import { selectChoice } from '../test/selectChoice'

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
    expect(api.fetchGitHubAnalytics).toHaveBeenCalledWith('admin-token', { signal: expect.any(AbortSignal), repo: 'photographywebsite' })
  })

  it.each(['TruongCam', 'TruongNoiser', 'TruongScaler', 'TruongFlix', 'TruongCleaner'])('switches to %s and defaults to the website on every fresh visit', async (repository) => {
    const first = render(<MemoryRouter><GitHubAnalytics /></MemoryRouter>)
    await screen.findByText('24,000')
    api.fetchGitHubAnalytics.mockResolvedValueOnce({ ...REPORT, repository: { ...REPORT.repository, fullName: `iant4093/${repository}` }, loc: { ...REPORT.loc, total: 8000 } })
    selectChoice(screen.getByRole('combobox', { name: 'Repository' }), repository)
    expect(screen.queryByText('24,000')).not.toBeInTheDocument()
    expect(await screen.findByText('8,000')).toBeInTheDocument()
    expect(screen.getByText(`iant4093/${repository}`)).toBeInTheDocument()
    expect(api.fetchGitHubAnalytics).toHaveBeenLastCalledWith('admin-token', { signal: expect.any(AbortSignal), repo: repository })
    first.unmount()
    render(<MemoryRouter><GitHubAnalytics /></MemoryRouter>)
    expect(screen.getByRole('combobox', { name: 'Repository' })).toHaveValue('photographywebsite')
    await screen.findByText('24,000')
  })

  it('combines available snapshots and lets admins open individual repositories', async () => {
    const cleaner = {
      ...REPORT,
      cacheStatus: 'stale',
      repository: { ...REPORT.repository, fullName: 'iant4093/TruongCleaner' },
      totalCommits: 68, commits30d: 5,
      loc: { total: 8000, files: 50, areas: [{ name: 'macOS App', lines: 7000 }, { name: 'Tests', lines: 1000 }] },
      workflow: { successRate: 25, successfulRuns: 1, completedRuns: 4, medianDurationSeconds: 90 },
      languages: [{ name: 'JavaScript', bytes: 200 }, { name: 'Swift', bytes: 700 }],
      activity: { status: 'ready', weeks: [{ week: REPORT.activity.weeks[0].week, additions: 25, deletions: 5 }] },
      recentRuns: [{ ...REPORT.recentRuns[0], title: 'Build Cleaner', createdAt: '2026-08-26T11:00:00Z' }],
      recentCommits: [{ ...REPORT.recentCommits[0], message: 'Ship Cleaner', date: '2026-08-26T11:00:00Z' }],
    }
    const names = ['photographywebsite', 'TruongCam', 'TruongNoiser', 'TruongScaler', 'TruongFlix', 'TruongCleaner']
    render(<MemoryRouter><GitHubAnalytics /></MemoryRouter>)
    await screen.findByText('24,000')
    api.fetchGitHubAnalytics.mockResolvedValueOnce({
      repositories: names.map(name => ({ name, label: name === 'photographywebsite' ? 'Photography Website' : name })),
      reports: { photographywebsite: REPORT, TruongCleaner: cleaner },
      nextRefreshAt: REPORT.nextRefreshAt,
    }).mockResolvedValueOnce(cleaner)
    const picker = screen.getByRole('combobox', { name: 'Repository' })
    selectChoice(picker, 'all')

    const summary = within(await screen.findByRole('region', { name: 'All repositories summary' }))
    expect(summary.getByText('32,000')).toBeInTheDocument()
    expect(summary.getByText('500')).toBeInTheDocument()
    expect(summary.getByText('87.9%')).toBeInTheDocument()
    expect(summary.getByText('29 of 33 recent completed runs')).toBeInTheDocument()
    expect(summary.getByText('28%')).toBeInTheDocument()
    expect(screen.getByText('2 of 6 repository snapshots included')).toBeInTheDocument()
    expect(screen.getByText(/stale snapshots from 1 repository/)).toBeInTheDocument()
    expect(screen.getByText('1,200 bytes')).toBeInTheDocument()
    expect(screen.getByText('Weekly activity is available for 2 of 6 repositories.')).toBeInTheDocument()
    expect(screen.getByTitle(/\+145 \/ −40/)).toBeInTheDocument()
    const recentRuns = within(screen.getByRole('region', { name: 'Recent Actions runs' })).getAllByRole('link')
    expect(recentRuns[0]).toHaveTextContent('Build Cleaner')
    expect(recentRuns[0]).toHaveTextContent('TruongCleaner')
    const recentCommits = within(screen.getByRole('region', { name: 'Recent commits' })).getAllByRole('link')
    expect(recentCommits[0]).toHaveTextContent('Ship Cleaner')
    const comparison = within(screen.getByRole('region', { name: 'By repository' }))
    expect(comparison.getAllByRole('listitem')).toHaveLength(6)
    expect(comparison.getByRole('button', { name: 'TruongFlix' }).closest('li')).toHaveTextContent('Snapshot pending')
    expect(comparison.getByRole('button', { name: 'TruongCleaner' }).closest('li')).toHaveTextContent('1m 30s')
    expect(api.fetchGitHubAnalytics).toHaveBeenLastCalledWith('admin-token', { signal: expect.any(AbortSignal), repo: 'all' })
    selectChoice(picker, 'all')
    expect(api.fetchGitHubAnalytics).toHaveBeenCalledTimes(2)
    expect(comparison.getByRole('button', { name: 'TruongCleaner' })).toBeInTheDocument()

    fireEvent.click(comparison.getByRole('button', { name: 'TruongCleaner' }))
    expect(await screen.findByText('iant4093/TruongCleaner')).toBeInTheDocument()
    expect(picker).toHaveValue('TruongCleaner')
    expect(picker).toHaveFocus()
    expect(api.fetchGitHubAnalytics).toHaveBeenLastCalledWith('admin-token', { signal: expect.any(AbortSignal), repo: 'TruongCleaner' })
  })

  it('ignores a late response from the previously selected repository', async () => {
    let resolveWebsite
    api.fetchGitHubAnalytics.mockImplementationOnce(() => new Promise(resolve => { resolveWebsite = resolve }))
    render(<MemoryRouter><GitHubAnalytics /></MemoryRouter>)
    await waitFor(() => expect(api.fetchGitHubAnalytics).toHaveBeenCalledOnce())
    api.fetchGitHubAnalytics.mockResolvedValueOnce({ ...REPORT, loc: { ...REPORT.loc, total: 8000 } })
    selectChoice(screen.getByRole('combobox'), 'TruongCam')
    await screen.findByText('8,000')
    resolveWebsite(REPORT)
    await waitFor(() => expect(screen.queryByText('24,000')).not.toBeInTheDocument())
    expect(screen.getByText('8,000')).toBeInTheDocument()
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
