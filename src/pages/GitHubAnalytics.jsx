import { useEffect, useState } from 'react'
import SiteSelect from '../components/SiteSelect'
import DashboardBackLink from '../components/DashboardBackLink'
import { useAuth } from '../context/auth'
import { fetchGitHubAnalytics } from '../utils/api'
import './GitHubAnalytics.css'

const REPOSITORIES = [
    { name: 'photographywebsite', label: 'Photography Website' },
    { name: 'TruongCam', label: 'TruongCam' },
    { name: 'TruongNoiser', label: 'TruongNoiser' },
    { name: 'TruongScaler', label: 'TruongScaler' },
    { name: 'TruongFlix', label: 'TruongFlix' },
    { name: 'TruongCleaner', label: 'TruongCleaner' },
]
const ALL_REPOS = 'all'
const REPO_OPTIONS = [
    { value: ALL_REPOS, label: 'All repos' },
    ...REPOSITORIES.map((repo) => ({ value: repo.name, label: `${repo.label} · ${repo.name}` })),
]

const number = (value) => Number(value || 0).toLocaleString()

function dateLabel(value, includeTime = true) {
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return 'Unknown'
    return new Intl.DateTimeFormat('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        ...(includeTime ? { hour: 'numeric', minute: '2-digit' } : {}),
    }).format(parsed)
}

function durationLabel(seconds) {
    if (seconds == null || seconds === '' || !Number.isFinite(Number(seconds))) return '—'
    const minutes = Math.floor(Number(seconds) / 60)
    const remaining = Number(seconds) % 60
    return minutes ? `${minutes}m ${remaining}s` : `${remaining}s`
}

function Metric({ label, value, note }) {
    return (
        <article className="github-metric">
            <p className="github-eyebrow">{label}</p>
            <p className="github-metric-value">{value}</p>
            <p className="github-muted">{note}</p>
        </article>
    )
}

function Breakdown({ items = [], valueKey = 'lines' }) {
    const max = Math.max(1, ...items.map((item) => Number(item[valueKey] || 0)))
    return (
        <div className="github-breakdown">
            {items.map((item) => (
                <div className="github-breakdown-row" key={item.name}>
                    <div className="github-breakdown-copy">
                        <span>{item.name}</span>
                        <span>{number(item[valueKey])}{valueKey === 'bytes' ? ' bytes' : ''}</span>
                    </div>
                    <div className="github-track" aria-hidden="true">
                        <span style={{ width: `${Math.max(1.5, Number(item[valueKey] || 0) / max * 100)}%` }} />
                    </div>
                </div>
            ))}
        </div>
    )
}

function ActivityChart({ weeks = [] }) {
    const visible = weeks.slice(-16)
    const max = Math.max(1, ...visible.map((week) => Number(week.additions || 0) + Number(week.deletions || 0)))
    return (
        <div className="github-activity" aria-label="Weekly additions and deletions for the latest sixteen weeks">
            {visible.map((week) => {
                const additions = Number(week.additions || 0)
                const deletions = Number(week.deletions || 0)
                return (
                    <div className="github-activity-week" key={week.week} title={`${dateLabel(week.week * 1000, false)}: +${number(additions)} / −${number(deletions)}`}>
                        <span className="github-additions" style={{ height: `${Math.max(2, additions / max * 100)}%` }} />
                        <span className="github-deletions" style={{ height: `${Math.max(2, deletions / max * 100)}%` }} />
                    </div>
                )
            })}
        </div>
    )
}

function Status({ conclusion, status }) {
    const value = conclusion || status || 'unknown'
    return <span className={`github-status github-status-${value}`}>{value.replaceAll('_', ' ')}</span>
}

function mergeBreakdown(items, valueKey) {
    const totals = new Map()
    for (const { name, [valueKey]: value } of items) {
        totals.set(name, (totals.get(name) || 0) + value)
    }
    return [...totals].filter(([, value]) => value > 0)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name, value]) => ({ name, [valueKey]: value }))
}

function recentAcrossRepos(entries, field, dateKey, limit) {
    return entries.flatMap(({ name, label, snapshot }) =>
        (snapshot[field] || []).map((item) => ({ ...item, repoName: name, repoLabel: label })))
        .sort((a, b) => (Date.parse(b[dateKey]) || 0) - (Date.parse(a[dateKey]) || 0))
        .slice(0, limit)
}

function buildOverview({ reports, repositories, nextRefreshAt }) {
    const entries = repositories.map((repo) => ({ ...repo, snapshot: reports[repo.name] }))
    const available = entries.filter(({ snapshot }) => snapshot)
    const snapshots = available.map(({ snapshot }) => snapshot)
    const sum = (items, key) => items.reduce((total, item) => total + (item?.[key] || 0), 0)
    const workflows = snapshots.map((snapshot) => snapshot.workflow)
    const successfulRuns = sum(workflows, 'successfulRuns')
    const completedRuns = sum(workflows, 'completedRuns')
    const activity = snapshots.map((snapshot) => snapshot.activity)
        .filter((item) => item?.status === 'ready' && item.weeks?.length)
    const weeks = new Map()
    for (const { week, additions, deletions } of activity.flatMap((item) => item.weeks)) {
        const total = weeks.get(week) || { week, additions: 0, deletions: 0 }
        total.additions += additions
        total.deletions += deletions
        weeks.set(week, total)
    }
    const code = snapshots.map((snapshot) => snapshot.loc)
    return {
        entries,
        availableCount: available.length,
        staleCount: snapshots.filter((snapshot) => snapshot.cacheStatus === 'stale').length,
        activityCount: activity.length,
        summary: {
            nextRefreshAt,
            totalCommits: sum(snapshots, 'totalCommits'),
            commits30d: sum(snapshots, 'commits30d'),
            loc: {
                total: sum(code, 'total'),
                files: sum(code, 'files'),
                areas: mergeBreakdown(code.flatMap((loc) => loc?.areas || []), 'lines'),
                method: 'Nonblank source lines across available snapshots. Generated, dependency, lock, build, and media files are excluded.',
            },
            languages: mergeBreakdown(snapshots.flatMap((snapshot) => snapshot.languages || []), 'bytes'),
            workflow: {
                successfulRuns,
                completedRuns,
                successRate: completedRuns ? Number((successfulRuns / completedRuns * 100).toFixed(1)) : null,
            },
            activity: { status: activity.length ? 'ready' : 'preparing', weeks: [...weeks.values()].sort((a, b) => a.week - b.week) },
            recentRuns: recentAcrossRepos(available, 'recentRuns', 'createdAt', 15),
            recentCommits: recentAcrossRepos(available, 'recentCommits', 'date', 10),
        },
    }
}

function successLabel(workflow) {
    return workflow?.successRate == null ? '—' : `${workflow.successRate}%`
}

function testMetrics(loc) {
    const testLines = loc?.areas?.find((item) => item.name === 'Tests')?.lines || 0
    const applicationLines = Number(loc?.total || 0) - testLines
    return { testLines, testRatio: applicationLines > 0 ? `${Math.round(testLines / applicationLines * 100)}%` : '—' }
}

function RepositoryComparison({ entries, onSelect }) {
    return (
        <section className="github-panel" aria-labelledby="github-repositories-heading">
            <div className="github-panel-heading"><p className="github-eyebrow">Comparison</p><h2 id="github-repositories-heading">By repository</h2></div>
            <ul className="github-list github-repository-list">
                {entries.map(({ name, label, snapshot }) => (
                    <li className="github-list-row github-overview-row" key={name}>
                        <div>
                            <button type="button" className="github-repo-detail" onClick={() => onSelect(name)}>{label} <span aria-hidden="true">→</span></button>
                            <p>{snapshot ? `${snapshot.cacheStatus === 'stale' ? 'Stale snapshot' : 'Snapshot'} · ${dateLabel(snapshot.generatedAt)}` : 'Snapshot pending'}</p>
                        </div>
                        {snapshot && (
                            <dl className="github-repo-stats">
                                <div><dt>Lines of code</dt><dd>{number(snapshot.loc?.total)}</dd></div>
                                <div><dt>Total commits</dt><dd>{number(snapshot.totalCommits)}</dd></div>
                                <div><dt>Commits in 30 days</dt><dd>{number(snapshot.commits30d)}</dd></div>
                                <div><dt>CI success</dt><dd>{successLabel(snapshot.workflow)}</dd></div>
                                <div><dt>Median workflow</dt><dd>{durationLabel(snapshot.workflow?.medianDurationSeconds)}</dd></div>
                                <div><dt>Test-to-code ratio</dt><dd>{testMetrics(snapshot.loc).testRatio}</dd></div>
                            </dl>
                        )}
                    </li>
                ))}
            </ul>
        </section>
    )
}

export default function GitHubAnalytics() {
    const { getIdToken } = useAuth()
    const [selectedRepo, setSelectedRepo] = useState('photographywebsite')
    const [snapshot, setSnapshot] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [requestVersion, setRequestVersion] = useState(0)

    useEffect(() => {
        const controller = new AbortController()
        Promise.resolve(getIdToken())
            .then((token) => {
                if (controller.signal.aborted) return null
                return fetchGitHubAnalytics(token, { signal: controller.signal, repo: selectedRepo })
            })
            .then((data) => { if (!controller.signal.aborted) setSnapshot(data) })
            .catch((requestError) => {
                if (!controller.signal.aborted && requestError?.name !== 'AbortError') setError(requestError?.message || 'GitHub analytics could not be loaded.')
            })
            .finally(() => { if (!controller.signal.aborted) setLoading(false) })
        return () => controller.abort()
    }, [getIdToken, requestVersion, selectedRepo])

    const selectRepository = (value) => {
        if (value === selectedRepo) return
        setLoading(true)
        setError('')
        setSnapshot(null)
        setSelectedRepo(value)
    }

    const overview = snapshot && selectedRepo === ALL_REPOS ? buildOverview(snapshot) : null
    const report = overview?.summary || snapshot
    const loc = report?.loc || {}
    const workflow = report?.workflow || {}
    const repository = report?.repository || {}
    const { testLines, testRatio } = testMetrics(loc)

    return (
        <div className="github-page">
            <div className="github-repo-picker">
                <label htmlFor="github-repository">Repository</label>
                <SiteSelect id="github-repository" value={selectedRepo} onChange={selectRepository} options={REPO_OPTIONS} />
            </div>
            <DashboardBackLink className="github-back">← <span>Back to Dashboard</span></DashboardBackLink>
            <header className="linen-admin-heading github-heading">
                <span>Repository intelligence</span>
                <h1>GitHub Analytics</h1>
                <p>Codebase growth, development activity, recent commits, and deployment health.</p>
            </header>

            {loading && <div className="github-loading" role="status"><span className="sr-only">Loading GitHub analytics</span><span /></div>}
            {!loading && error && (
                <div className="github-error" role="alert">
                    <h2>GitHub analytics could not be loaded.</h2><p>{error}</p>
                    <button type="button" onClick={() => { setLoading(true); setError(''); setRequestVersion((value) => value + 1) }}>Try again</button>
                </div>
            )}

            {!loading && !error && report && (
                <div className="github-content">
                    {report.cacheStatus === 'stale' && <div className="github-stale">GitHub is temporarily unavailable. Showing the last successful snapshot.</div>}
                    {overview?.staleCount > 0 && <div className="github-stale">Combined totals include stale snapshots from {number(overview.staleCount)} {overview.staleCount === 1 ? 'repository' : 'repositories'}.</div>}
                    <div className="github-generated">
                        <span>{overview ? `${overview.availableCount} of ${overview.entries.length} repository snapshots included` : `Generated ${dateLabel(report.generatedAt)}`}</span>
                        <span>Refreshes hourly · Next refresh {dateLabel(report.nextRefreshAt)}</span>
                    </div>

                    <section className="github-metrics" aria-label={overview ? 'All repositories summary' : 'Repository summary'}>
                        <Metric label="Total code" value={number(loc.total)} note={`${number(loc.files)} counted source files`} />
                        <Metric label="Total commits" value={number(report.totalCommits)} note={`${number(report.commits30d)} in the last 30 days`} />
                        <Metric label="CI success" value={successLabel(workflow)} note={`${number(workflow.successfulRuns)} of ${number(workflow.completedRuns)} recent completed runs`} />
                        {overview ? <Metric label="Repositories" value={number(overview.entries.length)} note={`${number(overview.availableCount)} with a snapshot`} />
                            : <Metric label="Median workflow" value={durationLabel(workflow.medianDurationSeconds)} note={`Latest · ${workflow.latestConclusion || 'unknown'}`} />}
                        <Metric label="Test-to-code ratio" value={testRatio} note={`${number(testLines)} nonblank test lines`} />
                    </section>

                    {overview && <RepositoryComparison entries={overview.entries} onSelect={(value) => {
                        selectRepository(value)
                        document.getElementById('github-repository')?.focus()
                    }} />}

                    <div className="github-two-column">
                        <section className="github-panel" aria-labelledby="github-loc-heading">
                            <div className="github-panel-heading"><p className="github-eyebrow">Codebase</p><h2 id="github-loc-heading">Lines by area</h2></div>
                            <Breakdown items={loc.areas} />
                            <p className="github-method">{loc.method}</p>
                        </section>
                        <section className="github-panel" aria-labelledby="github-language-heading">
                            <div className="github-panel-heading"><p className="github-eyebrow">Composition</p><h2 id="github-language-heading">GitHub languages</h2></div>
                            <Breakdown items={report.languages} valueKey="bytes" />
                            <p className="github-method">Language share uses GitHub’s repository byte analysis.</p>
                        </section>
                    </div>

                    <section className="github-panel" aria-labelledby="github-activity-heading">
                        <div className="github-panel-heading github-panel-heading-inline">
                            <div><p className="github-eyebrow">Development activity</p><h2 id="github-activity-heading">Weekly code movement</h2></div>
                            <div className="github-legend"><span><i className="github-additions-dot" /> Additions</span><span><i className="github-deletions-dot" /> Deletions</span></div>
                        </div>
                        {report.activity?.status === 'ready' && report.activity.weeks?.length ? <ActivityChart weeks={report.activity.weeks} /> : <p className="github-empty">GitHub is preparing repository activity statistics. The next hourly refresh will check again.</p>}
                        {overview?.activityCount > 0 && overview.activityCount < overview.entries.length && (
                            <p className="github-method">Weekly activity is available for {overview.activityCount} of {overview.entries.length} repositories.</p>
                        )}
                    </section>

                    <section className="github-panel" aria-labelledby="github-runs-heading">
                        <div className="github-panel-heading"><p className="github-eyebrow">Automation</p><h2 id="github-runs-heading">Recent Actions runs</h2></div>
                        <div className="github-list">
                            {!report.recentRuns?.length && <p className="github-empty">{overview ? 'No recent Actions runs in the available snapshots.' : 'No recent Actions runs for this repository.'}</p>}
                            {(report.recentRuns || []).map((run) => (
                                <a className="github-list-row" href={run.url} target="_blank" rel="noreferrer" key={run.repoName ? `${run.repoName}/${run.id}` : run.id}>
                                    <div><strong>{run.title || run.name}</strong><p>{run.repoLabel && `${run.repoLabel} · `}{run.name} · {run.branch || 'detached'} · {dateLabel(run.createdAt)}</p></div>
                                    <div className="github-list-meta"><Status conclusion={run.conclusion} status={run.status} /><span>{durationLabel(run.durationSeconds)}</span></div>
                                </a>
                            ))}
                        </div>
                    </section>

                    <section className="github-panel" aria-labelledby="github-commits-heading">
                        <div className="github-panel-heading"><p className="github-eyebrow">History</p><h2 id="github-commits-heading">Recent commits</h2></div>
                        <div className="github-list">
                            {(report.recentCommits || []).map((commit) => (
                                <a className="github-list-row" href={commit.url} target="_blank" rel="noreferrer" key={commit.repoName ? `${commit.repoName}/${commit.sha}` : commit.sha}>
                                    <div><strong>{commit.message}</strong><p>{commit.repoLabel && `${commit.repoLabel} · `}{commit.author} · {dateLabel(commit.date)}</p></div>
                                    <code>{commit.shortSha}</code>
                                </a>
                            ))}
                        </div>
                    </section>

                    {!overview && <section className="github-repository">
                        <div><p className="github-eyebrow">Repository</p><a href={repository.url} target="_blank" rel="noreferrer">{repository.fullName}</a></div>
                        <div><span>Branch</span><strong>{repository.defaultBranch}</strong></div>
                        <div><span>Last push</span><strong>{dateLabel(repository.pushedAt)}</strong></div>
                        <div><span>Open issues</span><strong>{number(repository.openIssues)}</strong></div>
                    </section>}
                </div>
            )}
        </div>
    )
}
