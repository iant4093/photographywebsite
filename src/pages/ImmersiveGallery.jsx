import { lazy, Suspense, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { supportsImmersiveGallery } from '../utils/museumSupport'
import './ImmersiveGallery.css'

const ImmersiveGalleryDesktop = lazy(() => import('./ImmersiveGalleryDesktop'))

function GalleryLoading() {
    return (
        <div className="museum-loading" role="status">
            <span className="museum-loading-mark">IT</span>
            <p>Preparing the gallery…</p>
        </div>
    )
}

function WebGlRequired() {
    return (
        <section className="museum-device-gate" aria-labelledby="museum-device-title">
            <span className="museum-device-gate-mark">IT</span>
            <p className="museum-kicker">Immersive gallery</p>
            <h1 id="museum-device-title">This browser cannot open the gallery</h1>
            <p>
                The walk-through needs WebGL graphics support. Try an up-to-date browser or another
                device to explore the collection.
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

    if (!supported) return <WebGlRequired />
    return (
        <Suspense fallback={<GalleryLoading />}>
            <ImmersiveGalleryDesktop />
        </Suspense>
    )
}
