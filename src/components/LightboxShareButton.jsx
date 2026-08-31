import { useEffect, useRef, useState } from 'react'
import { sharePage } from '../utils/share'

export default function LightboxShareButton({
    media,
    index = 0,
    mediaType = 'photo',
    shareTitle,
    shareUrl,
}) {
    const [label, setLabel] = useState('Share')
    const resetTimerRef = useRef(null)
    const normalizedType = mediaType === 'video' ? 'video' : 'photo'
    const typeLabel = normalizedType[0].toUpperCase() + normalizedType.slice(1)

    useEffect(() => () => window.clearTimeout(resetTimerRef.current), [])

    const handleShare = async (event) => {
        event.stopPropagation()
        window.clearTimeout(resetTimerRef.current)
        try {
            const targetUrl = typeof shareUrl === 'function'
                ? shareUrl(media, index)
                : shareUrl
            const result = await sharePage({
                title: shareTitle || media?.albumTitle || 'Ian Truong Photography',
                text: `View this ${normalizedType} on Ian Truong Photography.`,
                url: targetUrl || undefined,
            })
            if (result === 'copied') {
                setLabel('Link Copied')
                resetTimerRef.current = window.setTimeout(() => setLabel('Share'), 2200)
            }
        } catch (error) {
            console.error(`${typeLabel} share failed:`, error)
            setLabel('Could Not Share')
            resetTimerRef.current = window.setTimeout(() => setLabel('Share'), 2200)
        }
    }

    return (
        <button
            type="button"
            onClick={handleShare}
            className="linen-lightbox-share inline-flex items-center gap-2 rounded-full border border-white/30 px-4 py-2.5 text-sm text-white/80 transition-colors hover:border-white/60 hover:bg-white/10 hover:text-white active:scale-[0.98] cursor-pointer touch-manipulation"
            title={`Share ${typeLabel}`}
            aria-label={`Share ${normalizedType}`}
        >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.7 11.2l6.6-3.8M8.7 12.8l6.6 3.8M7 15.5a3 3 0 100 6 3 3 0 000-6zm10-13a3 3 0 100 6 3 3 0 000-6zm0 13a3 3 0 100 6 3 3 0 000-6z" />
            </svg>
            <span>{label}</span>
        </button>
    )
}
