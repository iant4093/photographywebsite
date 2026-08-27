import { lazy, Suspense, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { supportsImmersiveGallery } from '../utils/museumSupport'
import './ImmersiveGallery.css'

const ImmersiveGalleryDesktop = lazy(() => import('./ImmersiveGalleryDesktop'))

function DesktopLoading() {
    return (
        <div className="museum-loading" role="status">
            <span className="museum-loading-mark">IT</span>
            <p>Preparing the gallery…</p>
        </div>
    )
}

function DesktopRequired() {
    return (
        <section className="museum-device-gate" aria-labelledby="museum-device-title">
            <span className="museum-device-gate-mark">IT</span>
            <p className="museum-kicker">Immersive gallery</p>
            <h1 id="museum-device-title">Visit from a desktop</h1>
            <p>
                This walk-through gallery uses a keyboard and mouse. Open it on a desktop or laptop
                to explore the collection with WASD and your cursor.
            </p>
            <Link to="/explore" state={{ restoreExploreScroll: true }}>← Back to Explore</Link>
        </section>
    )
}

export default function ImmersiveGallery() {
    const [supported, setSupported] = useState(supportsImmersiveGallery)

    useEffect(() => {
        const pointer = window.matchMedia?.('(any-pointer: fine)')
        const update = () => setSupported(supportsImmersiveGallery())
        window.addEventListener('resize', update)
        pointer?.addEventListener?.('change', update)
        return () => {
            window.removeEventListener('resize', update)
            pointer?.removeEventListener?.('change', update)
        }
    }, [])

    if (!supported) return <DesktopRequired />
    return (
        <Suspense fallback={<DesktopLoading />}>
            <ImmersiveGalleryDesktop />
        </Suspense>
    )
}
