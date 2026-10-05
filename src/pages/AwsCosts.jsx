import SiteSelect from '../components/SiteSelect'
import { useEffect, useMemo, useState } from 'react'
import DashboardBackLink from '../components/DashboardBackLink'
import { useAuth } from '../context/auth'
import { fetchCostReport } from '../utils/api'
import './AwsCosts.css'

function currencyFormatter(currency) {
    try {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: currency || 'USD',
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        })
    } catch {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        })
    }
}

function monthLabel(month, format = 'long') {
    if (!/^\d{4}-\d{2}$/.test(month || '')) return month || 'Unknown month'
    return new Intl.DateTimeFormat('en-US', {
        month: format,
        year: 'numeric',
        timeZone: 'UTC',
    }).format(new Date(`${month}-01T00:00:00Z`))
}

function dateLabel(value) {
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return 'Unknown'
    return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
    }).format(parsed)
}

function CostTrend({ months, formatCurrency }) {
    const maximum = Math.max(0.01, ...months.map((month) => Math.max(0, Number(month.total) || 0)))

    return (
        <div className="aws-cost-panel" aria-labelledby="cost-trend-heading">
            <div className="aws-cost-panel-heading">
                <div>
                    <p className="aws-cost-eyebrow">Account history</p>
                    <h2 id="cost-trend-heading" className="aws-cost-panel-title">Monthly cost trend</h2>
                </div>
                <p className="aws-cost-detail">Unblended cost</p>
            </div>
            <div className="aws-cost-chart" role="img" aria-label="Monthly AWS cost chart">
                {months.map((month) => {
                    const value = Number(month.total) || 0
                    const height = Math.max(2, Math.min(100, (Math.max(0, value) / maximum) * 100))
                    return (
                        <div key={month.month} className="aws-cost-chart-column">
                            <div
                                className="aws-cost-chart-bar"
                                style={{ height: `${height}%` }}
                            />
                            <span className="aws-cost-chart-tooltip">
                                {monthLabel(month.month, 'short')} · {formatCurrency(value)}
                            </span>
                        </div>
                    )
                })}
            </div>
            <div className="aws-cost-chart-axis">
                <span>{monthLabel(months[0]?.month, 'short')}</span>
                <span>{monthLabel(months.at(-1)?.month, 'short')}</span>
            </div>
            <ul className="sr-only">
                {months.map((month) => <li key={month.month}>{monthLabel(month.month)}: {formatCurrency(month.total)}</li>)}
            </ul>
        </div>
    )
}

// List prices used only to give a rough sense of scale per album.
const STORAGE_PRICE_PER_GB_MONTH = 0.023
const TRANSFER_PRICE_PER_GB = 0.085
const PLACES = { public: 'Main Gallery', unlisted: 'Link only', private: 'Client' }

function byteLabel(bytes) {
    const value = Math.max(0, Number(bytes) || 0)
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    const power = value > 0 ? Math.min(units.length - 1, Math.floor(Math.log10(value) / 3)) : 0
    const scaled = value / 1000 ** power
    return `${scaled >= 100 || power === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${units[power]}`
}

function AlbumUsage({ usage, formatCurrency }) {
    const [view, setView] = useState('storage')
    const storage = view === 'storage'
    const rows = (storage ? usage?.byStorage : usage?.byBandwidth) || []
    const field = storage ? 'storageBytes' : 'bandwidthBytes'
    const largest = Math.max(1, ...rows.map((row) => Number(row[field]) || 0))
    const span = usage?.bandwidthWindow
    const estimate = (bytes) => (Number(bytes) || 0) / 1e9 * (storage ? STORAGE_PRICE_PER_GB_MONTH : TRANSFER_PRICE_PER_GB)

    return (
        <div className="aws-cost-panel" aria-labelledby="album-usage-heading">
            <div className="aws-cost-panel-heading">
                <div>
                    <p className="aws-cost-eyebrow">Storage and bandwidth</p>
                    <h2 id="album-usage-heading" className="aws-cost-panel-title">Biggest albums</h2>
                </div>
                {usage && (
                    <div className="aws-cost-tabs" role="group" aria-label="Rank albums by">
                        <button type="button" aria-pressed={storage} className={storage ? 'is-active' : ''} onClick={() => setView('storage')}>Storage</button>
                        <button type="button" aria-pressed={!storage} className={storage ? '' : 'is-active'} onClick={() => setView('bandwidth')}>Bandwidth · 30 days</button>
                    </div>
                )}
            </div>
            {!usage && <p className="aws-cost-empty">Album sizes and bandwidth appear after the first daily usage run.</p>}
            {usage && (
                <>
                    <p className="aws-cost-detail aws-cost-usage-total">
                        {storage
                            ? `${byteLabel(usage.storageBytes)} across ${usage.albumCount} album${usage.albumCount === 1 ? '' : 's'} · about ${formatCurrency(estimate(usage.storageBytes))}/month`
                            : `${byteLabel(usage.bandwidthBytes)} served${span?.days ? ` from ${dateLabel(span.from)} to ${dateLabel(span.to)}` : ''} · about ${formatCurrency(estimate(usage.bandwidthBytes))}`}
                    </p>
                    {rows.length ? (
                        <ol className="aws-cost-services aws-cost-usage-list">
                            {rows.map((row) => (
                                <li key={row.albumId}>
                                    <div className="aws-cost-service-heading">
                                        <span className="aws-cost-service-name" title={row.title}>
                                            {row.title}
                                            <span className="aws-cost-usage-tags">
                                                {row.type === 'video' ? 'Video' : 'Photos'} · {row.deleted ? 'Recently deleted' : PLACES[row.visibility] || 'Link only'}
                                            </span>
                                        </span>
                                        <span className="aws-cost-service-amount">{byteLabel(row[field])}</span>
                                    </div>
                                    <div className="aws-cost-service-track" aria-hidden="true">
                                        <div className="aws-cost-service-bar" style={{ width: `${Math.max(1, (Number(row[field]) || 0) / largest * 100)}%` }} />
                                    </div>
                                    <p className="aws-cost-service-share">
                                        ≈ {formatCurrency(estimate(row[field]))}{storage ? '/month' : ' over 30 days'}
                                        {storage && row.objectCount ? ` · ${row.objectCount} file${row.objectCount === 1 ? '' : 's'}` : ''}
                                    </p>
                                </li>
                            ))}
                        </ol>
                    ) : (
                        <p className="aws-cost-empty">{storage ? 'No album files were found.' : 'No album bandwidth was recorded in this window yet.'}</p>
                    )}
                    <p className="aws-cost-usage-note">
                        Estimates use S3 Standard (${STORAGE_PRICE_PER_GB_MONTH}/GB-month) and CloudFront (${TRANSFER_PRICE_PER_GB}/GB) list prices, so free tiers and discounts make real costs lower. Bandwidth counts the media CDN; client galleries opened through the site&apos;s signed links aren&apos;t included. Updated daily.
                    </p>
                </>
            )}
        </div>
    )
}

function SummaryCard({ label, value, note }) {
    return (
        <div className="aws-cost-summary-card">
            <p className="aws-cost-eyebrow">{label}</p>
            <p className="aws-cost-summary-value">{value}</p>
            <p className="aws-cost-summary-note">{note}</p>
        </div>
    )
}

export default function AwsCosts() {
    const { getIdToken } = useAuth()
    const [report, setReport] = useState(null)
    const [selectedMonth, setSelectedMonth] = useState('')
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [requestVersion, setRequestVersion] = useState(0)

    useEffect(() => {
        const controller = new AbortController()
        Promise.resolve()
            .then(() => getIdToken())
            .then((token) => fetchCostReport(token, { signal: controller.signal }))
            .then((result) => {
                setReport(result)
                setSelectedMonth((current) => (
                    result.months?.some((month) => month.month === current)
                        ? current
                        : result.currentMonth || result.months?.at(-1)?.month || ''
                ))
            })
            .catch((requestError) => {
                if (requestError?.name !== 'AbortError') {
                    setError(requestError?.message || 'The AWS cost report could not be loaded.')
                }
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false)
            })
        return () => controller.abort()
    }, [getIdToken, requestVersion])

    const formatter = useMemo(() => currencyFormatter(report?.currency), [report?.currency])
    const formatCurrency = (value) => formatter.format(Number(value) || 0)
    const months = Array.isArray(report?.months) ? report.months : []
    const selectedIndex = months.findIndex((month) => month.month === selectedMonth)
    const selected = selectedIndex >= 0 ? months[selectedIndex] : months.at(-1)
    const previous = selectedIndex > 0 ? months[selectedIndex - 1] : null
    const change = previous && Number(previous.total) !== 0
        ? ((Number(selected?.total) - Number(previous.total)) / Math.abs(Number(previous.total))) * 100
        : null
    const isCurrent = selected?.month === report?.currentMonth
    const forecast = isCurrent && report?.forecastTotal !== null && report?.forecastTotal !== undefined
        ? formatCurrency(report.forecastTotal)
        : 'Not available'

    return (
        <div className="aws-cost-page">
            <DashboardBackLink className="aws-cost-back-link">
                <svg className="aws-cost-back-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                Back to Dashboard
            </DashboardBackLink>

            <div className="linen-admin-heading aws-cost-page-heading">
                <span>Account overview</span>
                <h1>AWS Costs</h1>
                <p>A daily view of account-wide estimated AWS spending.</p>
            </div>

            {loading && (
                <div className="aws-cost-loading" role="status" aria-label="Loading AWS cost report" aria-live="polite">
                    <span className="sr-only">Loading AWS cost report</span>
                    <div className="aws-cost-spinner" />
                </div>
            )}

            {!loading && error && (
                <div className="aws-cost-error" role="alert">
                    <p className="aws-cost-error-title">The AWS cost report could not be loaded.</p>
                    <p className="aws-cost-error-message">{error}</p>
                    <button
                        type="button"
                        className="aws-cost-retry"
                        onClick={() => {
                            setLoading(true)
                            setError('')
                            setRequestVersion((version) => version + 1)
                        }}
                    >
                        Try again
                    </button>
                </div>
            )}

            {!loading && !error && report && selected && (
                <div className="aws-cost-content">
                    {report.cacheStatus === 'stale' && (
                        <div className="aws-cost-stale" role="status">
                            AWS could not refresh today’s report, so this page is showing the last successful daily snapshot.
                        </div>
                    )}

                    <div className="aws-cost-controls">
                        <div>
                            <p className="aws-cost-generated">
                                Generated {dateLabel(report.generatedAt)} · Cost data through {dateLabel(report.dataThrough)}
                            </p>
                            <p className="aws-cost-refresh-note">Updates once per UTC day. Current figures may be estimated and can lag AWS usage.</p>
                        </div>
                        <label className="aws-cost-month-label">
                            Report month
                            <SiteSelect
                                className="aws-cost-month-select"
                                value={selected.month}
                                onChange={(value) => setSelectedMonth(value)}
                                aria-label="Report month" options={[...months].reverse().map(month => ({ value: month.month, label: monthLabel(month.month) }))}
                            />
                        </label>
                    </div>

                    <div className="aws-cost-summary-grid">
                        <SummaryCard
                            label={isCurrent ? 'Month to date' : 'Selected month'}
                            value={formatCurrency(selected.total)}
                            note={`${monthLabel(selected.month)}${selected.estimated ? ' · Estimated' : ''}`}
                        />
                        <SummaryCard
                            label="Forecast month end"
                            value={forecast}
                            note={isCurrent ? 'AWS forecast plus month-to-date cost' : 'Forecast shown only for the current month'}
                        />
                        <SummaryCard
                            label="Next month forecast"
                            value={report.nextMonth ? formatCurrency(report.nextMonth.forecastTotal) : 'Not available'}
                            note={report.nextMonth
                                ? `${monthLabel(report.nextMonth.month)} · trend ${Number(report.nextMonth.trendPerMonth) >= 0 ? '+' : '−'}${formatCurrency(Math.abs(Number(report.nextMonth.trendPerMonth) || 0))}/month`
                                : 'Available after the next daily refresh'}
                        />
                        <SummaryCard
                            label="Previous month"
                            value={previous ? formatCurrency(previous.total) : 'Not available'}
                            note={previous ? monthLabel(previous.month) : 'No earlier month in this report'}
                        />
                        <SummaryCard
                            label="Month-over-month"
                            value={change === null ? 'Not available' : `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`}
                            note={change === null ? 'A non-zero previous month is required' : `${formatCurrency(Math.abs(Number(selected.total) - Number(previous.total)))} ${change >= 0 ? 'higher' : 'lower'}`}
                        />
                    </div>

                    <CostTrend months={months} formatCurrency={formatCurrency} />

                    <AlbumUsage usage={report.albumUsage} formatCurrency={formatCurrency} />

                    <div className="aws-cost-panel">
                        <div className="aws-cost-panel-heading">
                            <div>
                                <p className="aws-cost-eyebrow">Service categories</p>
                                <h2 className="aws-cost-panel-title">Highest costs in {monthLabel(selected.month, 'short')}</h2>
                            </div>
                            <p className="aws-cost-detail">Top services plus Other</p>
                        </div>
                        {selected.services?.length ? (
                            <div className="aws-cost-services">
                                {selected.services.map((service) => (
                                    <div key={service.name}>
                                        <div className="aws-cost-service-heading">
                                            <span className="aws-cost-service-name" title={service.name}>{service.name}</span>
                                            <span className="aws-cost-service-amount">{formatCurrency(service.amount)}</span>
                                        </div>
                                        <div className="aws-cost-service-track" aria-hidden="true">
                                            <div
                                                className="aws-cost-service-bar"
                                                style={{ width: `${Math.max(0, Math.min(100, Number(service.share) || 0))}%` }}
                                            />
                                        </div>
                                        <p className="aws-cost-service-share">{Number(service.share || 0).toFixed(1)}%</p>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <p className="aws-cost-empty">No AWS service costs were recorded for this month.</p>
                        )}
                    </div>

                    <p className="aws-cost-disclaimer">
                        This report uses Cost Explorer unblended costs and is not a final invoice. Credits, refunds, taxes, and recently reported usage can change the amount shown in AWS Billing.
                    </p>
                </div>
            )}
        </div>
    )
}
