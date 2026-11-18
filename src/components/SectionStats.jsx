import { lazy, Suspense, useState } from 'react'
import { rememberLightboxTrigger } from '../utils/lightboxOrigin'
import { preloadLightboxMotion } from '../utils/lightboxMotionControl'

const StatsDialog = lazy(async () => {
    const [dialog] = await Promise.all([import('./SectionStatsDialog'), preloadLightboxMotion()])
    return dialog
})

export default function SectionStats({ category, showLabel = false, localCounts }) {
    const [opening, setOpening] = useState(null)
    const label = `${category}${localCounts ? ` ${localCounts.mediaLabel}` : ''} statistics`
    return <>
        <button type="button" className="linen-theme-toggle" aria-label={`Show ${label}`}
            title={label} aria-haspopup="dialog" onClick={event => setOpening({ origin: rememberLightboxTrigger(event.currentTarget, 'panel') })}>
            <svg className="linen-theme-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7v1" />
            </svg>
            {showLabel && <span data-lightbox-label>Section statistics</span>}
        </button>
        {opening && <Suspense fallback={null}><StatsDialog key={category} category={category} label={label} localCounts={localCounts}
            motionOrigin={opening.origin} onClose={() => setOpening(null)} /></Suspense>}
    </>
}
