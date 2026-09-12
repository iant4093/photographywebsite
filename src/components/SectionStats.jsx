import { lazy, Suspense, useState } from 'react'

const StatsDialog = lazy(() => import('./SectionStatsDialog'))

export default function SectionStats({ category }) {
    const [open, setOpen] = useState(false)
    return <>
        <button type="button" className="linen-theme-toggle" aria-label={`Show ${category} statistics`}
            title={`${category} statistics`} aria-haspopup="dialog" onClick={() => setOpen(true)}>
            <svg className="linen-theme-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7v1" />
            </svg>
        </button>
        {open && <Suspense fallback={null}><StatsDialog key={category} category={category} onClose={() => setOpen(false)} /></Suspense>}
    </>
}
