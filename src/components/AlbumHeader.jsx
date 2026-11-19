import useMediaQuery from '../hooks/useMediaQuery'
import './DisclosureMotion.css'
import './AlbumHeader.css'

export default function AlbumHeader({ title, details, actions, className, titleClassName, compact = true }) {
    const narrow = useMediaQuery('(max-width: 767.98px)')

    if (narrow && compact) {
        return (
            <div className="linen-gallery-header linen-gallery-header--compact">
                {title}
                <details className="linen-album-details linen-disclosure">
                    <summary>
                        Album details
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="m6 9 6 6 6-6" />
                        </svg>
                    </summary>
                    <div className="linen-album-details-content">
                        <div>{details}</div>
                        {actions}
                    </div>
                </details>
            </div>
        )
    }

    return (
        <div className={`linen-gallery-header ${className}`}>
            <div className={titleClassName}>{title}{details}</div>
            {actions}
        </div>
    )
}
