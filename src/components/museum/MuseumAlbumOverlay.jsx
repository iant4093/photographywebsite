import { Component, lazy, Suspense } from 'react'
import AccessibleLightbox from '../AccessibleLightbox'
import './MuseumAlbumOverlay.css'

const AlbumContent = lazy(() => import('../../pages/AlbumGallery').then(module => ({ default: module.AlbumGalleryContent })))

class AlbumContentBoundary extends Component {
    state = { failed: false }
    static getDerivedStateFromError() { return { failed: true } }
    render() {
        if (this.state.failed) return <div className="museum-album-status" role="alert">The album viewer could not open. You can return to the gallery and try again.</div>
        return this.props.children
    }
}

export default function MuseumAlbumOverlay({ album, onClose, onReturn }) {
    return (
        <AccessibleLightbox ariaLabel={`${album.title || 'Photography'} album`} className="linen-site museum-album-overlay" onClose={onClose}>
            <section className="museum-album-panel">
                <header className="museum-album-toolbar">
                    <button type="button" data-lightbox-initial-focus onClick={onReturn}>← Return to gallery</button>
                    <span>The virtual archive</span>
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
