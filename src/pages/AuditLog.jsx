import { useEffect, useMemo, useState } from 'react'
import DashboardBackLink from '../components/DashboardBackLink'
import { useAuth } from '../context/auth'
import { fetchAuditLog } from '../utils/api'
import './AdminObservability.css'

const titleCase = (value) => String(value || 'unknown').replace(/[._]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())

function formatDate(value) {
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return 'Unknown'
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(parsed)
}

function AuditLog() {
    const { getIdToken } = useAuth()
    const [report, setReport] = useState(null)
    const [days, setDays] = useState(7)
    const [outcome, setOutcome] = useState('all')
    const [resource, setResource] = useState('all')
    const [search, setSearch] = useState('')
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [requestVersion, setRequestVersion] = useState(0)

    useEffect(() => {
        const controller = new AbortController()
        getIdToken()
            .then((token) => fetchAuditLog(token, days, { signal: controller.signal }))
            .then(setReport)
            .catch((requestError) => {
                if (requestError?.name !== 'AbortError') setError(requestError?.message || 'Audit events could not be loaded.')
            })
            .finally(() => { if (!controller.signal.aborted) setLoading(false) })
        return () => controller.abort()
    }, [days, getIdToken, requestVersion])

    const changeDays = (event) => {
        setLoading(true)
        setError('')
        setDays(Number(event.target.value))
    }

    const refresh = () => {
        setLoading(true)
        setError('')
        setRequestVersion((value) => value + 1)
    }

    const resources = useMemo(() => [...new Set((report?.events || []).map((event) => event.resource_type))].sort(), [report])
    const visibleEvents = useMemo(() => {
        const needle = search.trim().toLowerCase()
        return (report?.events || []).filter((event) => {
            if (outcome !== 'all' && event.outcome !== outcome) return false
            if (resource !== 'all' && event.resource_type !== resource) return false
            if (!needle) return true
            return [event.event_name, event.action, event.reason_code, event.actor_type, event.resource_type]
                .some((value) => String(value || '').toLowerCase().includes(needle))
        })
    }, [outcome, report, resource, search])

    return (
        <div className="observability-page linen-admin-page">
            <DashboardBackLink className="observability-back">← <span>Back to Dashboard</span></DashboardBackLink>
            <header className="linen-admin-heading observability-heading">
                <span>Accountability</span>
                <div className="observability-title-row"><div><h1>Audit Log</h1><p>Privacy-safe administrative, authentication, media, provider, and security events.</p></div></div>
            </header>

            <section className="audit-controls" aria-label="Audit log filters">
                <label>Time range<select value={days} onChange={changeDays}><option value={1}>Last 24 hours</option><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option></select></label>
                <label>Outcome<select value={outcome} onChange={(event) => setOutcome(event.target.value)}><option value="all">All outcomes</option><option value="success">Success</option><option value="denied">Denied</option><option value="failure">Failure</option></select></label>
                <label>Resource<select value={resource} onChange={(event) => setResource(event.target.value)}><option value="all">All resources</option>{resources.map((value) => <option value={value} key={value}>{titleCase(value)}</option>)}</select></label>
                <label className="audit-search">Search<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Action, event, or reason" /></label>
                <button type="button" className="observability-refresh" onClick={refresh} disabled={loading}>Refresh</button>
            </section>

            {loading && !report && <div className="observability-loading" role="status">Loading audit events…</div>}
            {error && !report && <div className="observability-error" role="alert"><p>{error}</p><button type="button" onClick={refresh}>Try again</button></div>}

            {report && (
                <div className="observability-content">
                    {error && <div className="observability-warning" role="alert">The latest query failed. Showing the previous result.</div>}
                    <section className="observability-metrics" aria-label="Audit summary">
                        <article><span>Events returned</span><strong>{Number(report.summary?.returned || 0).toLocaleString()}</strong></article>
                        <article><span>Successful</span><strong>{Number(report.summary?.outcomes?.success || 0).toLocaleString()}</strong></article>
                        <article><span>Denied</span><strong>{Number(report.summary?.outcomes?.denied || 0).toLocaleString()}</strong></article>
                        <article><span>Failures</span><strong>{Number(report.summary?.outcomes?.failure || 0).toLocaleString()}</strong></article>
                    </section>
                    <section className="observability-panel audit-panel">
                        <div className="observability-panel-heading observability-panel-heading-inline"><div><span>Event history</span><h2>{visibleEvents.length.toLocaleString()} visible events</h2></div><p>Newest first · identities and request data are not retained</p></div>
                        {report.limited && <div className="observability-warning">Showing the newest 200 events in this period. Use filters or a shorter range to narrow the view.</div>}
                        <div className="audit-table" role="table" aria-label="Privacy-safe audit events">
                            <div className="audit-row audit-header" role="row"><span>Time</span><span>Event</span><span>Outcome</span><span>Actor</span><span>Resource</span><span>Reason</span></div>
                            {visibleEvents.map((event, index) => (
                                <article className="audit-row" role="row" key={`${event.timestamp}-${event.event_name}-${index}`}>
                                    <time data-label="Time">{formatDate(event.timestamp)}</time>
                                    <div data-label="Event"><strong>{titleCase(event.event_name)}</strong><small>{event.action}</small></div>
                                    <div data-label="Outcome"><span className={`observability-status status-${event.outcome}`}>{titleCase(event.outcome)}</span></div>
                                    <span data-label="Actor">{titleCase(event.actor_type)}</span>
                                    <span data-label="Resource">{titleCase(event.resource_type)}</span>
                                    <span data-label="Reason">{titleCase(event.reason_code)}</span>
                                </article>
                            ))}
                        </div>
                        {!visibleEvents.length && <p className="observability-empty">No events match these filters.</p>}
                    </section>
                </div>
            )}
        </div>
    )
}

export default AuditLog
