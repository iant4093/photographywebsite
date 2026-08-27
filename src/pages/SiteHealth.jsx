import { useEffect, useState } from 'react'
import DashboardBackLink from '../components/DashboardBackLink'
import { useAuth } from '../context/auth'
import { fetchSiteHealth } from '../utils/api'
import './AdminObservability.css'

const titleCase = (value) => String(value || 'unknown').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())

function formatDate(value) {
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return 'Unknown'
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(parsed)
}

function SiteHealth() {
    const { getIdToken } = useAuth()
    const [report, setReport] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [requestVersion, setRequestVersion] = useState(0)

    useEffect(() => {
        const controller = new AbortController()
        getIdToken()
            .then((token) => fetchSiteHealth(token, { signal: controller.signal }))
            .then(setReport)
            .catch((requestError) => {
                if (requestError?.name !== 'AbortError') setError(requestError?.message || 'Site health could not be loaded.')
            })
            .finally(() => { if (!controller.signal.aborted) setLoading(false) })
        return () => controller.abort()
    }, [getIdToken, requestVersion])

    const refresh = () => {
        setLoading(true)
        setError('')
        setRequestVersion((value) => value + 1)
    }

    return (
        <div className="observability-page linen-admin-page">
            <DashboardBackLink className="observability-back">← <span>Back to Dashboard</span></DashboardBackLink>
            <header className="linen-admin-heading observability-heading">
                <span>Operations</span>
                <div className="observability-title-row">
                    <div><h1>Site Health</h1><p>Live availability, infrastructure state, processing safeguards, and website-only alarms.</p></div>
                    <button type="button" className="observability-refresh" onClick={refresh} disabled={loading}>Refresh</button>
                </div>
            </header>

            {loading && !report && <div className="observability-loading" role="status">Checking website health…</div>}
            {error && !report && <div className="observability-error" role="alert"><p>{error}</p><button type="button" onClick={refresh}>Try again</button></div>}

            {report && (
                <div className="observability-content">
                    {error && <div className="observability-warning" role="alert">The latest refresh failed. Showing the previous health report.</div>}
                    <section className={`health-overview health-overview-${report.overall}`}>
                        <div>
                            <p className="observability-eyebrow">Current status</p>
                            <h2>{report.overall === 'healthy' ? 'All systems operational' : report.overall === 'incident' ? 'Attention required' : 'Some status is unavailable'}</h2>
                            <p>Checked {formatDate(report.generatedAt)}</p>
                        </div>
                        <span className={`observability-status status-${report.overall}`}>{titleCase(report.overall)}</span>
                    </section>

                    <section className="observability-metrics" aria-label="Site health summary">
                        <article><span>Checks passing</span><strong>{report.summary?.checksPassing || 0} / {report.summary?.checksTotal || 0}</strong></article>
                        <article><span>Active alarms</span><strong>{report.summary?.activeAlarms || 0}</strong></article>
                        <article><span>Monitored alarms</span><strong>{report.summary?.monitoredAlarms || 0}</strong></article>
                        <article><span>Unknown states</span><strong>{report.summary?.unknownAlarms || 0}</strong></article>
                    </section>

                    <section className="observability-panel">
                        <div className="observability-panel-heading"><span>Live checks</span><h2>Website and infrastructure</h2></div>
                        <div className="health-checks">
                            {(report.checks || []).map((check) => (
                                <article key={check.id} className="health-check">
                                    <div><strong>{check.label}</strong><p>{check.detail}</p></div>
                                    <div className="health-check-meta">
                                        {check.latencyMs != null && <span>{Number(check.latencyMs).toLocaleString()} ms</span>}
                                        <span className={`observability-status status-${check.status}`}>{titleCase(check.status)}</span>
                                    </div>
                                </article>
                            ))}
                        </div>
                    </section>

                    <section className="observability-panel">
                        <div className="observability-panel-heading"><span>Safeguards</span><h2>Operational alarms</h2><p>Only alarms managed by this website stack are included.</p></div>
                        {report.alarmError && <div className="observability-warning">{report.alarmError}</div>}
                        <div className="alarm-list">
                            {(report.alarms || []).map((alarm) => (
                                <article className="alarm-row" key={alarm.name}>
                                    <div><strong>{alarm.name}</strong><p>{alarm.description}</p></div>
                                    <div className="alarm-meta"><span className={`observability-status status-${alarm.state.toLowerCase()}`}>{titleCase(alarm.state)}</span><time>{formatDate(alarm.updatedAt)}</time></div>
                                </article>
                            ))}
                            {!report.alarmError && !report.alarms?.length && <p className="observability-empty">No operational alarms were returned.</p>}
                        </div>
                    </section>
                </div>
            )}
        </div>
    )
}

export default SiteHealth
