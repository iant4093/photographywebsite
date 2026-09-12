import { useEffect, useState } from 'react'
import AccessibleLightbox from './AccessibleLightbox'
import { fetchSectionStats } from '../utils/sectionStats'
import './SectionStats.css'

function dateLabel(value) {
    return new Date(`${value}T00:00:00Z`).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    })
}

export default function StatsDialog({ category, onClose }) {
    const [stats, setStats] = useState(null)
    const [error, setError] = useState(false)
    const [attempt, setAttempt] = useState(0)

    useEffect(() => {
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
    }, [category, attempt])

    const dateRange = stats?.firstDate
        ? `${dateLabel(stats.firstDate)}${stats.firstDate === stats.lastDate ? '' : ` – ${dateLabel(stats.lastDate)}`}`
        : 'Not recorded'

    return (
        <AccessibleLightbox ariaLabel={`${category} statistics`} onClose={onClose} className="section-stats-lightbox">
            <section className="linen-site section-stats-panel" data-theme={document.documentElement.dataset.theme}>
                <header className="section-stats-heading">
                    <div>
                        <p className="section-stats-eyebrow">Section statistics · All years</p>
                        <h2>{category}</h2>
                    </div>
                    <button type="button" className="section-stats-close" aria-label="Close section statistics" onClick={onClose}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
                    </button>
                </header>
                {error && <div role="alert" className="section-stats-message">
                    <p>{stats ? 'Stats could not be refreshed. Showing the last loaded counts.' : 'Stats could not be loaded.'}</p>
                    <button type="button" onClick={() => setAttempt(value => value + 1)}>Try again</button>
                </div>}
                {!stats && !error && <p role="status" className="section-stats-message">Loading statistics…</p>}
                {stats && <dl className="section-stats-list">
                    <dt>Date range</dt><dd>{dateRange}</dd>
                    <dt>Albums</dt><dd>{stats.albumCount.toLocaleString()}</dd>
                    <dt>Photos</dt><dd>{stats.photoCount.toLocaleString()}</dd>
                    <dt>{stats.cameras.length > 1 ? 'Cameras used' : 'Camera used'}</dt>
                    <dd>{stats.cameras.join(' · ') || 'Not recorded'}</dd>
                    <dt>Lenses used</dt>
                    <dd>{stats.lenses.length ? <ul>{stats.lenses.map(([name, count]) => <li key={name}>{name} ({count})</li>)}</ul> : 'Not recorded'}</dd>
                </dl>}
            </section>
        </AccessibleLightbox>
    )
}

