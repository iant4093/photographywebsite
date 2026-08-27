import { useEffect, useState } from 'react'
import DashboardBackLink from '../components/DashboardBackLink'
import { useAuth } from '../context/auth'
import { fetchGoogleDriveUsage } from '../utils/api'
import { formatBytes } from '../utils/formatBytes'
import './GoogleDriveUsage.css'

function dateTimeLabel(value) {
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return 'Unknown'
    return new Intl.DateTimeFormat('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(parsed)
}

function SummaryCard({ label, value, note }) {
    return (
        <div className="drive-usage-summary-card">
            <p className="drive-usage-eyebrow">{label}</p>
            <p className="drive-usage-summary-value">{value}</p>
            <p className="drive-usage-summary-note">{note}</p>
        </div>
    )
}

function BreakdownRow({ label, value, note }) {
    return (
        <div className="drive-usage-breakdown-row">
            <div>
                <p className="drive-usage-breakdown-label">{label}</p>
                {note && <p className="drive-usage-breakdown-note">{note}</p>}
            </div>
            <p className="drive-usage-breakdown-value">{formatBytes(value)}</p>
        </div>
    )
}

export default function GoogleDriveUsage() {
    const { getIdToken } = useAuth()
    const [report, setReport] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [requestVersion, setRequestVersion] = useState(0)

    useEffect(() => {
        const controller = new AbortController()
        Promise.resolve()
            .then(() => getIdToken())
            .then((token) => fetchGoogleDriveUsage(token, { signal: controller.signal }))
            .then(setReport)
            .catch((requestError) => {
                if (requestError?.name !== 'AbortError') {
                    setError(requestError?.message || 'The Google Drive usage report could not be loaded.')
                }
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false)
            })
        return () => controller.abort()
    }, [getIdToken, requestVersion])

    const backup = report?.websiteBackup
    const rawBackup = report?.rawPhotoBackup
    const categories = backup?.categories || {}
    const rawCategories = rawBackup?.categories || {}
    const percentUsed = Number(report?.percentUsed)
    const hasPercent = Number.isFinite(percentUsed) && report?.percentUsed !== null
    const boundedPercent = hasPercent ? Math.max(0, Math.min(100, percentUsed)) : 0

    return (
        <div className="drive-usage-page">
            <DashboardBackLink className="drive-usage-back-link">
                <svg className="drive-usage-back-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                Back to Dashboard
            </DashboardBackLink>

            <div className="linen-admin-heading drive-usage-page-heading">
                <span>Storage overview</span>
                <h1>Google Drive Usage</h1>
                <p>A daily, aggregate view of account storage, website backups, and raw photo backups.</p>
            </div>

            {loading && (
                <div className="drive-usage-loading" role="status" aria-label="Loading Google Drive usage report" aria-live="polite">
                    <span className="sr-only">Loading Google Drive usage report</span>
                    <div className="drive-usage-spinner" />
                </div>
            )}

            {!loading && error && (
                <div className="drive-usage-error" role="alert">
                    <p className="drive-usage-error-title">The Google Drive usage report could not be loaded.</p>
                    <p className="drive-usage-error-message">{error}</p>
                    <button
                        type="button"
                        className="drive-usage-retry"
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

            {!loading && !error && report && backup && rawBackup && (
                <div className="drive-usage-content">
                    {report.cacheStatus === 'stale' && (
                        <div className="drive-usage-stale" role="status">
                            Google Drive could not refresh today’s report, so this page is showing the last successful daily snapshot.
                        </div>
                    )}

                    <div className="drive-usage-generated">
                        <p>Generated {dateTimeLabel(report.generatedAt)}</p>
                        <p>Updates once per UTC day. Next scheduled refresh: {dateTimeLabel(report.nextRefreshAt)}.</p>
                    </div>

                    <div className="drive-usage-summary-grid">
                        <SummaryCard label="Account used" value={formatBytes(report.usageBytes)} note="Storage used across the Google account" />
                        <SummaryCard label="Account limit" value={formatBytes(report.limitBytes)} note="The quota reported by Google Drive" />
                        <SummaryCard label="Remaining" value={formatBytes(report.remainingBytes)} note="Available space based on the reported quota" />
                        <SummaryCard label="Website backups" value={formatBytes(backup.totalBytes)} note={`${backup.fileCount.toLocaleString()} files in ${backup.folderCount.toLocaleString()} folders`} />
                        <SummaryCard label="Raw photo backups" value={formatBytes(rawBackup.totalBytes)} note={`${rawBackup.fileCount.toLocaleString()} files in ${rawBackup.folderCount.toLocaleString()} folders`} />
                    </div>

                    <section className="drive-usage-panel" aria-labelledby="drive-capacity-heading">
                        <div className="drive-usage-panel-heading">
                            <div>
                                <p className="drive-usage-eyebrow">Account capacity</p>
                                <h2 id="drive-capacity-heading" className="drive-usage-panel-title">Storage allocation</h2>
                            </div>
                            <p className="drive-usage-capacity-value">{hasPercent ? `${percentUsed.toFixed(1)}% used` : 'Limit unavailable'}</p>
                        </div>
                        {hasPercent ? (
                            <div
                                className="drive-usage-capacity-track"
                                role="progressbar"
                                aria-label="Google account storage used"
                                aria-valuemin="0"
                                aria-valuemax="100"
                                aria-valuenow={boundedPercent}
                            >
                                <div className="drive-usage-capacity-bar" style={{ width: `${boundedPercent}%` }} />
                            </div>
                        ) : (
                            <p className="drive-usage-unavailable">
                                Google did not return an account storage limit. This is normal for some service accounts and pooled Google Workspace storage.
                            </p>
                        )}
                    </section>

                    <div className="drive-usage-panel-grid">
                        <section className="drive-usage-panel" aria-labelledby="drive-breakdown-heading">
                            <div className="drive-usage-panel-heading">
                                <div>
                                    <p className="drive-usage-eyebrow">Account breakdown</p>
                                    <h2 id="drive-breakdown-heading" className="drive-usage-panel-title">Where storage is used</h2>
                                </div>
                            </div>
                            <div className="drive-usage-breakdown">
                                <BreakdownRow label="Google Drive" value={report.driveBytes} note="Files stored in Drive, including trash" />
                                <BreakdownRow label="Drive trash" value={report.trashBytes} note="Items that can still count toward Drive usage" />
                                <BreakdownRow label="Other Google services" value={report.otherGoogleBytes} note="Account usage outside Drive, such as Gmail or Google Photos" />
                            </div>
                        </section>

                        <section className="drive-usage-panel" aria-labelledby="website-backup-heading">
                            <div className="drive-usage-panel-heading">
                                <div>
                                    <p className="drive-usage-eyebrow">Website backup</p>
                                    <h2 id="website-backup-heading" className="drive-usage-panel-title">Backup categories</h2>
                                </div>
                            </div>
                            <div className="drive-usage-breakdown">
                                <BreakdownRow label="Photos" value={categories.photos?.bytes} note={`${(categories.photos?.fileCount || 0).toLocaleString()} files`} />
                                <BreakdownRow label="Videos" value={categories.videos?.bytes} note={`${(categories.videos?.fileCount || 0).toLocaleString()} files`} />
                                <BreakdownRow label="Other" value={categories.other?.bytes} note={`${(categories.other?.fileCount || 0).toLocaleString()} files`} />
                            </div>
                        </section>

                        <section className="drive-usage-panel" aria-labelledby="raw-photo-backup-heading">
                            <div className="drive-usage-panel-heading">
                                <div>
                                    <p className="drive-usage-eyebrow">Raw photo backup</p>
                                    <h2 id="raw-photo-backup-heading" className="drive-usage-panel-title">Backup categories</h2>
                                </div>
                            </div>
                            <div className="drive-usage-breakdown">
                                <BreakdownRow label="Images" value={rawCategories.images?.bytes} note={`${(rawCategories.images?.fileCount || 0).toLocaleString()} files`} />
                                <BreakdownRow label="Videos" value={rawCategories.videos?.bytes} note={`${(rawCategories.videos?.fileCount || 0).toLocaleString()} files`} />
                                <BreakdownRow label="Other" value={rawCategories.other?.bytes} note={`${(rawCategories.other?.fileCount || 0).toLocaleString()} files`} />
                            </div>
                        </section>
                    </div>

                    <div className="drive-usage-footnotes">
                        <p>Maximum single-file upload reported by Google: {formatBytes(report.maxUploadBytes)}.</p>
                        <p>Google Workspace may report pooled limits differently. This dashboard intentionally shows totals only and never exposes backup file names or Google Drive identifiers. Raw Photo Backup access is metadata-only and limited by its shared-folder permission.</p>
                    </div>
                </div>
            )}
        </div>
    )
}
