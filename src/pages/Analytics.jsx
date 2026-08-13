import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../context/auth'
import { fetchAnalyticsReport } from '../utils/api'
import './Analytics.css'

const RANGE_OPTIONS = [7, 30, 90, 365]
const INTERVALS = ['daily', 'weekly', 'monthly']
const INTERVAL_LABELS = { daily: 'Day', weekly: 'Week', monthly: 'Month' }
const MEASURES = { visits: 'Website visits', albumViews: 'Album views' }
const number = new Intl.NumberFormat('en-US')

function countryName(code) {
    if (code === 'XX') return 'Unknown country'
    try {
        return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code
    } catch {
        return code
    }
}

function titleCase(value) {
    return String(value || '').replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function Stat({ label, value, note }) {
    return (
        <article className="analytics-stat">
            <span>{label}</span>
            <strong>{number.format(value || 0)}</strong>
            {note && <small>{note}</small>}
        </article>
    )
}

function BarList({ items, labelKey, valueKey = 'count', empty = 'No data recorded yet.', label = (item) => item[labelKey] }) {
    const maximum = Math.max(1, ...items.map((item) => Number(item[valueKey]) || 0))
    if (!items.length) return <p className="analytics-empty">{empty}</p>
    return (
        <ol className="analytics-bar-list">
            {items.map((item) => (
                <li key={`${item[labelKey]}-${item.albumId || ''}`}>
                    <div><span>{label(item)}</span><strong>{number.format(item[valueKey] || 0)}</strong></div>
                    <span className="analytics-bar-track" aria-hidden="true">
                        <span style={{ width: `${Math.max(2, ((item[valueKey] || 0) / maximum) * 100)}%` }} />
                    </span>
                </li>
            ))}
        </ol>
    )
}

function Trend({ report, interval, setInterval, measure, setMeasure }) {
    const points = report.trends?.[interval] || []
    const maximum = Math.max(1, ...points.map((item) => Number(item[measure]) || 0))
    const selectedTotal = measure === 'visits'
        ? report.visits?.selectedRange
        : report.totals?.albumViews
    return (
        <section className="analytics-panel analytics-trend-panel">
            <div className="analytics-panel-heading">
                <div><span>Activity over time</span><h2>{MEASURES[measure]}</h2></div>
                <div className="analytics-chart-controls">
                    <div className="analytics-segmented" aria-label="Chart measure">
                        {Object.entries(MEASURES).map(([value, label]) => (
                            <button key={value} type="button" className={measure === value ? 'active' : ''} onClick={() => setMeasure(value)}>{label}</button>
                        ))}
                    </div>
                    <div className="analytics-segmented" aria-label="Chart interval">
                        {INTERVALS.map((value) => (
                            <button key={value} type="button" className={interval === value ? 'active' : ''} onClick={() => setInterval(value)}>
                                {INTERVAL_LABELS[value]}
                            </button>
                        ))}
                    </div>
                </div>
            </div>
            {points.length ? (
                <div className="analytics-chart" role="img" aria-label={`${titleCase(interval)} ${MEASURES[measure].toLowerCase()} chart`}>
                    {points.map((point) => {
                        const key = point.date || point.period
                        return (
                            <div className="analytics-chart-column" key={key} title={`${key}: ${point[measure]} ${MEASURES[measure].toLowerCase()}`}>
                                <span style={{ height: `${Math.max(3, (point[measure] / maximum) * 100)}%` }} />
                                <small>{key.slice(interval === 'daily' ? 5 : interval === 'monthly' ? 5 : 6)}</small>
                            </div>
                        )
                    })}
                </div>
            ) : <p className="analytics-empty">No activity recorded for this range.</p>}
            <div className="analytics-chart-legend">
                <span>{measure === 'visits' ? 'Visits are full public-site page loads, not unique people.' : 'Album views count opened public photo and video albums.'}</span>
                <span>{number.format(selectedTotal || 0)} in selected range</span>
            </div>
        </section>
    )
}

function Vital({ item }) {
    const unit = item.metric === 'CLS' ? '' : ' ms'
    const good = item.ratings?.good || 0
    const share = item.samples ? Math.round((good / item.samples) * 100) : 0
    return (
        <article className="analytics-vital">
            <div><strong>{item.metric}</strong><span>{item.average === null ? 'No samples' : `${number.format(item.average)}${unit}`}</span></div>
            <div className="analytics-vital-meter"><span style={{ width: `${share}%` }} /></div>
            <small>{item.samples ? `${share}% good · ${number.format(item.samples)} samples` : 'Awaiting real visitor measurements'}</small>
        </article>
    )
}

export default function Analytics() {
    const { getIdToken } = useAuth()
    const [range, setRange] = useState(30)
    const [interval, setInterval] = useState('daily')
    const [measure, setMeasure] = useState('visits')
    const [report, setReport] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [attempt, setAttempt] = useState(0)

    const retry = useCallback(() => {
        setLoading(true)
        setError('')
        setAttempt((value) => value + 1)
    }, [])

    useEffect(() => {
        const controller = new AbortController()
        getIdToken()
            .then((token) => fetchAnalyticsReport(token, range, { signal: controller.signal }))
            .then(setReport)
            .catch((requestError) => {
                if (requestError?.name !== 'AbortError') setError(requestError?.message || 'Analytics could not be loaded.')
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false)
            })
        return () => controller.abort()
    }, [attempt, getIdToken, range])

    const changeRange = useCallback((event) => {
        const next = Number(event.target.value)
        setLoading(true)
        setError('')
        setRange(next)
        setInterval(next <= 30 ? 'daily' : next <= 90 ? 'weekly' : 'monthly')
    }, [])

    const sources = useMemo(() => (report?.sources || []).map((item) => ({ ...item, display: titleCase(item.name) })), [report])
    const devices = useMemo(() => (report?.devices || []).map((item) => ({ ...item, display: titleCase(item.name) })), [report])
    const countries = useMemo(() => (report?.countries || []).map((item) => ({ ...item, display: countryName(item.countryCode) })), [report])

    return (
        <div className="analytics-page linen-admin-page">
            <header className="analytics-header">
                <div>
                    <Link to="/admin">← Dashboard</Link>
                    <h1>Website Analytics</h1>
                    <p>Visits, portfolio engagement, audience shape, and frontend health in one view.</p>
                </div>
                <label>Report range
                    <select value={range} onChange={changeRange}>
                        {RANGE_OPTIONS.map((days) => <option key={days} value={days}>Last {days} days</option>)}
                    </select>
                </label>
            </header>

            {loading && !report && <div className="analytics-state" role="status" aria-label="Loading website analytics">Loading analytics…</div>}
            {error && !report && (
                <div className="analytics-state" role="alert">
                    <p>{error}</p><button type="button" onClick={retry}>Try again</button>
                </div>
            )}

            {report && (
                <>
                    {error && <div className="analytics-inline-error" role="alert">The latest refresh failed. Showing the previous report.</div>}
                    <section className="analytics-stats" aria-label="Traffic summary">
                        <Stat label="Visits today" value={report.visits?.today} />
                        <Stat label="Visits this week" value={report.visits?.last7Days} note="Rolling seven days" />
                        <Stat label="Visits this month" value={report.visits?.currentMonth} note="Calendar month" />
                        <Stat label="Total page views" value={report.totals?.pageViews} note={`Last ${range} days`} />
                    </section>

                    <Trend report={report} interval={interval} setInterval={setInterval} measure={measure} setMeasure={setMeasure} />

                    <div className="analytics-two-column">
                        <section className="analytics-panel">
                            <div className="analytics-panel-heading"><div><span>Photography</span><h2>Most-viewed photo albums</h2></div></div>
                            <BarList items={report.albums?.photo || []} labelKey="title" valueKey="views" empty="No photo album views recorded yet." />
                        </section>
                        <section className="analytics-panel">
                            <div className="analytics-panel-heading"><div><span>Moving image</span><h2>Most-viewed video albums</h2></div></div>
                            <BarList items={report.albums?.video || []} labelKey="title" valueKey="views" empty="No video album views recorded yet." />
                        </section>
                    </div>

                    <section className="analytics-engagement analytics-panel">
                        <div className="analytics-panel-heading"><div><span>Actions</span><h2>Portfolio engagement</h2></div></div>
                        <div className="analytics-engagement-grid">
                            <Stat label="Individual photo downloads" value={report.totals?.photoDownloads} />
                            <Stat label="Download-all requests" value={report.totals?.zipRequests} />
                            <Stat label="Contact submissions" value={report.totals?.contactSubmissions} />
                            <Stat label="Explore Photos clicks" value={report.totals?.explorePhotosClicks} />
                            <Stat label="Explore Videos clicks" value={report.totals?.exploreVideosClicks} />
                            <Stat label="Album views" value={report.totals?.albumViews} />
                        </div>
                    </section>

                    <div className="analytics-three-column">
                        <section className="analytics-panel"><div className="analytics-panel-heading"><div><span>Content</span><h2>Views by category</h2></div></div><BarList items={report.categories || []} labelKey="category" valueKey="views" /></section>
                        <section className="analytics-panel"><div className="analytics-panel-heading"><div><span>Acquisition</span><h2>Traffic sources</h2></div></div><BarList items={sources} labelKey="name" label={(item) => item.display} /></section>
                        <section className="analytics-panel"><div className="analytics-panel-heading"><div><span>Audience</span><h2>Device class</h2></div></div><BarList items={devices} labelKey="name" label={(item) => item.display} /></section>
                    </div>

                    <div className="analytics-two-column">
                        <section className="analytics-panel"><div className="analytics-panel-heading"><div><span>Coarse location</span><h2>Country traffic</h2></div></div><BarList items={countries} labelKey="countryCode" label={(item) => item.display} /></section>
                        <section className="analytics-panel">
                            <div className="analytics-panel-heading"><div><span>Field performance</span><h2>Core Web Vitals</h2></div></div>
                            <div className="analytics-vitals">{(report.webVitals || []).map((item) => <Vital key={item.metric} item={item} />)}</div>
                        </section>
                    </div>

                    <section className="analytics-panel">
                        <div className="analytics-panel-heading"><div><span>Reliability</span><h2>Frontend loading errors</h2></div><strong>{number.format(report.totals?.frontendErrors || 0)} total</strong></div>
                        <BarList items={report.frontendErrors || []} labelKey="kind" label={(item) => titleCase(item.kind)} empty="No frontend errors recorded in this range." />
                    </section>

                    <footer className="analytics-note">
                        <p>Analytics aggregates contain no cookies, visitor IDs, raw IP addresses, precise locations, full referrer URLs, or user-agent strings. AWS security and operational logs are separate. Daily aggregates expire after 400 days.</p>
                        <span>Updated {new Date(report.generatedAt).toLocaleString()}</span>
                    </footer>
                </>
            )}
        </div>
    )
}
