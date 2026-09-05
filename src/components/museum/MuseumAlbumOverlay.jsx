import { Component, lazy, Suspense, useSyncExternalStore } from 'react'
import AccessibleLightbox from '../AccessibleLightbox'
import { normalizeTheme } from '../../utils/theme'
import './MuseumAlbumOverlay.css'

const AlbumContent = lazy(() => import('../../pages/AlbumGallery').then(module => ({ default: module.AlbumGalleryContent })))

function readDocumentTheme() {
    return normalizeTheme(typeof document === 'undefined' ? null : document.documentElement.dataset.theme)
}

function subscribeToDocumentTheme(onChange) {
    const observer = new MutationObserver(onChange)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
}

class AlbumContentBoundary extends Component {
    state = { failed: false }
    static getDerivedStateFromError() { return { failed: true } }
    render() {
        if (this.state.failed) return <div className="museum-album-status" role="alert">The album viewer could not open. You can return to the gallery and try again.</div>
        return this.props.children
    }
}

export default function MuseumAlbumOverlay({ album, onClose, onReturn }) {
    // The lightbox portal sits outside App's themed container. Follow the
    // document preference so the same palette and photo-frame rules apply here.
    const theme = useSyncExternalStore(subscribeToDocumentTheme, readDocumentTheme, () => 'light')

    return (
        <AccessibleLightbox ariaLabel={`${album.title || 'Photography'} album`} className="museum-album-overlay" onClose={onClose}>
            <section className="linen-site museum-album-panel" data-theme={theme}>
                <header className="museum-album-toolbar">
                    <button type="button" data-lightbox-initial-focus onClick={onReturn}>← Return to gallery</button>
                    <button type="button" aria-label="Close album" onClick={onClose}>×</button>
                </header>
                <div className="museum-album-scroll">
                    <AlbumContentBoundary>
                        <Suspense fallback={<div className="museum-album-status" role="status">Opening the album…</div>}>
                            <AlbumContent key={album.albumId} albumId={album.albumId} embedded />
                        </Suspense>
                    </AlbumContentBoundary>
                </div>
                <footer className="museum-album-footer">Your place in the gallery is saved. <span>Esc to close</span></footer>
            </section>
        </AccessibleLightbox>
    )
}
