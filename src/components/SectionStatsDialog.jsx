import { useEffect, useState } from 'react'
import AccessibleLightbox from './AccessibleLightbox'
import { fetchSectionStats } from '../utils/sectionStats'
import './SectionStats.css'

function dateLabel(value) {
    return new Date(`${value}T00:00:00Z`).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    })
}

export default function StatsDialog({ category, label, localCounts, motionOrigin, onClose }) {
    const [stats, setStats] = useState(null)
    const [error, setError] = useState(false)
    const [attempt, setAttempt] = useState(0)
    const [opened, setOpened] = useState(false)

    useEffect(() => {
        if (localCounts) return undefined
        const controller = new AbortController()
        let loading = false
        async function refresh() {
            if (loading || document.visibilityState === 'hidden') return
            loading = true
            try {
                const current = await fetchSectionStats(category, { signal: controller.signal })
                if (!controller.signal.aborted) {
                    setStats(current)
                    setError(false)
                }
            } catch (requestError) {
                if (!controller.signal.aborted && requestError.name !== 'AbortError') {
                    setError(true)
                }
            } finally {
                loading = false
            }
        }
        void refresh()
        const interval = window.setInterval(refresh, 60_000)
        window.addEventListener('focus', refresh)
        document.addEventListener('visibilitychange', refresh)
        return () => {
            controller.abort()
            window.clearInterval(interval)
            window.removeEventListener('focus', refresh)
            document.removeEventListener('visibilitychange', refresh)
        }
    }, [category, attempt, localCounts])

    const dateRange = stats?.firstDate
        ? `${dateLabel(stats.firstDate)}${stats.firstDate === stats.lastDate ? '' : ` – ${dateLabel(stats.lastDate)}`}`
        : 'Not recorded'

    return (
        <AccessibleLightbox ariaLabel={label} onClose={onClose}
            motion={{ kind: 'panel', origin: motionOrigin, onOpened: () => setOpened(true) }} className="section-stats-lightbox">
            <section data-lightbox-panel className="linen-site section-stats-panel" data-theme={document.documentElement.dataset.theme}>
                <div data-lightbox-copy>
                    <header className="section-stats-heading">
                        <div>
                            <p className="section-stats-eyebrow"><span data-lightbox-label>Section statistics</span> · All years</p>
                            <h2>{category}</h2>
                        </div>
                        <button type="button" className="section-stats-close" aria-label="Close section statistics" onClick={onClose}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
                        </button>
                    </header>
                    {opened && error && <div role="alert" className="section-stats-message">
                        <p>{stats ? 'Stats could not be refreshed. Showing the last loaded counts.' : 'Stats could not be loaded.'}</p>
                        <button type="button" onClick={() => setAttempt(value => value + 1)}>Try again</button>
                    </div>}
                    {(!opened || stats || !error) && <div className="section-stats-body">
                        {opened && (localCounts || stats) ? <div className="section-stats-results">
                            {localCounts ? <dl className="section-stats-list">
                                <dt>Albums</dt><dd>{localCounts.albumCount.toLocaleString()}</dd>
                                <dt className="capitalize">{localCounts.mediaLabel}</dt><dd>{localCounts.mediaCount.toLocaleString()}</dd>
                            </dl> : <dl className="section-stats-list">
                                <dt>Date range</dt><dd>{dateRange}</dd>
                                <dt>Albums</dt><dd>{stats.albumCount.toLocaleString()}</dd>
                                <dt>Photos</dt><dd>{stats.photoCount.toLocaleString()}</dd>
                                <dt>{stats.cameras.length > 1 ? 'Cameras used' : 'Camera used'}</dt>
                                <dd>{stats.cameras.join(' · ') || 'Not recorded'}</dd>
                                <dt>Lenses used</dt>
                                <dd>{stats.lenses.length ? <ul>{stats.lenses.map(([name, count]) => <li key={name}>{name} ({count})</li>)}</ul> : 'Not recorded'}</dd>
                            </dl>}
                        </div> : <p role="status" className="section-stats-loading">Loading statistics…</p>}
                    </div>}
                </div>
            </section>
        </AccessibleLightbox>
    )
}

