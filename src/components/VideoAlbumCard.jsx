import { useCallback, useEffect, useRef } from 'react'
import AlbumCard from './AlbumCard'
import { prefetchPublicAlbum } from '../utils/api'
import { start as startVideoHoverPreview } from '../utils/albumVideoHoverPreview'

export default function VideoAlbumCard({ album }) {
    const wrapperRef = useRef(null)
    const hoverController = useRef(null)

    const setPlayOverlayVisible = useCallback((visible) => {
        const overlay = wrapperRef.current?.querySelector('.album-play')?.parentElement
        if (!overlay) return
        overlay.style.transition = 'opacity 200ms ease'
        overlay.style.opacity = visible ? '' : '0'
    }, [])

    const stopPreview = useCallback(() => {
        hoverController.current?.stop?.()
        hoverController.current = null
        setPlayOverlayVisible(true)
    }, [setPlayOverlayVisible])

    const startPreview = useCallback(() => {
        stopPreview()
        hoverController.current = startVideoHoverPreview({
            container: wrapperRef.current?.querySelector('.album-card-image'),
            album,
            loadDetail: () => prefetchPublicAlbum(album.albumId),
            onPlaybackStart: () => setPlayOverlayVisible(false),
            onPlaybackEnd: () => setPlayOverlayVisible(true),
        })
    }, [album, setPlayOverlayVisible, stopPreview])

    useEffect(() => stopPreview, [stopPreview])

    return (
        <div ref={wrapperRef} className="h-full" onMouseEnter={startPreview} onMouseLeave={stopPreview}>
            <AlbumCard album={album} />
        </div>
    )
}
