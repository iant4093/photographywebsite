import { useEffect, useState } from 'react'
import DashboardBackLink from '../components/DashboardBackLink'
import { useAuth } from '../context/auth'
import { fetchGitHubAnalytics } from '../utils/api'
import './GitHubAnalytics.css'

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

export default function GitHubAnalytics() {
    const { getIdToken } = useAuth()
    const [report, setReport] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [requestVersion, setRequestVersion] = useState(0)

    useEffect(() => {
        const controller = new AbortController()
        Promise.resolve(getIdToken())
            .then((token) => fetchGitHubAnalytics(token, { signal: controller.signal }))
            .then(setReport)
            .catch((requestError) => {
                if (requestError?.name !== 'AbortError') setError(requestError?.message || 'GitHub analytics could not be loaded.')
            })
            .finally(() => { if (!controller.signal.aborted) setLoading(false) })
        return () => controller.abort()
    }, [getIdToken, requestVersion])

    const loc = report?.loc || {}
    const workflow = report?.workflow || {}
    const repository = report?.repository || {}
    const testLines = loc.areas?.find((item) => item.name === 'Tests')?.lines || 0
    const applicationLines = Math.max(0, Number(loc.total || 0) - Number(testLines))
    const testRatio = applicationLines ? `${Math.round(testLines / applicationLines * 100)}%` : '—'

    return (
        <div className="github-page">
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
                    <div className="github-generated">
                        <span>Generated {dateLabel(report.generatedAt)}</span>
                        <span>Refreshes hourly · Next refresh {dateLabel(report.nextRefreshAt)}</span>
                    </div>

                    <section className="github-metrics" aria-label="Repository summary">
                        <Metric label="Total code" value={number(loc.total)} note={`${number(loc.files)} counted source files`} />
                        <Metric label="Total commits" value={number(report.totalCommits)} note={`${number(report.commits30d)} in the last 30 days`} />
                        <Metric label="CI success" value={workflow.successRate == null ? '—' : `${workflow.successRate}%`} note={`${number(workflow.successfulRuns)} of ${number(workflow.completedRuns)} recent completed runs`} />
                        <Metric label="Median workflow" value={durationLabel(workflow.medianDurationSeconds)} note={`Latest: ${workflow.latestConclusion || 'unknown'}`} />
                        <Metric label="Test-to-code ratio" value={testRatio} note={`${number(testLines)} nonblank test lines`} />
                    </section>

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
                    </section>

                    <section className="github-panel" aria-labelledby="github-runs-heading">
                        <div className="github-panel-heading"><p className="github-eyebrow">Automation</p><h2 id="github-runs-heading">Recent Actions runs</h2></div>
                        <div className="github-list">
                            {(report.recentRuns || []).map((run) => (
                                <a className="github-list-row" href={run.url} target="_blank" rel="noreferrer" key={run.id}>
                                    <div><strong>{run.title || run.name}</strong><p>{run.name} · {run.branch || 'detached'} · {dateLabel(run.createdAt)}</p></div>
                                    <div className="github-list-meta"><Status conclusion={run.conclusion} status={run.status} /><span>{durationLabel(run.durationSeconds)}</span></div>
                                </a>
                            ))}
                        </div>
                    </section>

                    <section className="github-panel" aria-labelledby="github-commits-heading">
                        <div className="github-panel-heading"><p className="github-eyebrow">History</p><h2 id="github-commits-heading">Recent commits</h2></div>
                        <div className="github-list">
                            {(report.recentCommits || []).map((commit) => (
                                <a className="github-list-row" href={commit.url} target="_blank" rel="noreferrer" key={commit.sha}>
                                    <div><strong>{commit.message}</strong><p>{commit.author} · {dateLabel(commit.date)}</p></div>
                                    <code>{commit.shortSha}</code>
                                </a>
                            ))}
                        </div>
                    </section>

                    <section className="github-repository">
                        <div><p className="github-eyebrow">Repository</p><a href={repository.url} target="_blank" rel="noreferrer">{repository.fullName}</a></div>
                        <div><span>Branch</span><strong>{repository.defaultBranch}</strong></div>
                        <div><span>Last push</span><strong>{dateLabel(repository.pushedAt)}</strong></div>
                        <div><span>Open issues</span><strong>{number(repository.openIssues)}</strong></div>
                    </section>
                </div>
            )}
        </div>
    )
}
