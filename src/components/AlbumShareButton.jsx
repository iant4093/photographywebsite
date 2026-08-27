import { useEffect, useRef, useState } from 'react'
import { sharePage } from '../utils/share'

export default function AlbumShareButton({ albumTitle, className = '' }) {
    const [label, setLabel] = useState('Share Album')
    const resetRef = useRef(null)

    useEffect(() => () => window.clearTimeout(resetRef.current), [])

    const handleShare = async () => {
        window.clearTimeout(resetRef.current)
        try {
            const result = await sharePage({
                title: albumTitle ? `${albumTitle} — Ian Truong Photography` : 'Ian Truong Photography',
                text: albumTitle ? `View ${albumTitle} on Ian Truong Photography.` : '',
            })
            if (result === 'copied') {
                setLabel('Link Copied')
                resetRef.current = window.setTimeout(() => setLabel('Share Album'), 2200)
            }
        } catch (error) {
            console.error('Album share failed:', error)
            setLabel('Could Not Share')
            resetRef.current = window.setTimeout(() => setLabel('Share Album'), 2200)
        }
    }

    return (
        <button
            type="button"
            onClick={handleShare}
            className={`inline-flex cursor-pointer items-center justify-center gap-2 px-6 py-3 rounded-xl font-medium transition-all duration-300 shadow-warm-sm border border-warm-border bg-cream text-charcoal hover:border-charcoal hover:scale-[1.02] active:scale-[0.98] ${className}`}
            aria-label={`Share ${albumTitle || 'album'}`}
        >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M8.7 11.2l6.6-3.8M8.7 12.8l6.6 3.8M7 15.5a3 3 0 100 6 3 3 0 000-6zm10-13a3 3 0 100 6 3 3 0 000-6zm0 13a3 3 0 100 6 3 3 0 000-6z" />
            </svg>
            <span>{label}</span>
        </button>
    )
}
