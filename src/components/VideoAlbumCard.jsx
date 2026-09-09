import { useCallback, useEffect, useRef } from 'react'
import AlbumCard from './AlbumCard'
import { prefetchPublicAlbum } from '../utils/api'
import { start as startVideoHoverPreview } from '../utils/albumVideoHoverPreview'
import { registerMobileAlbumPreview } from '../utils/mobileAlbumPreview'
import { canRunAlbumPreview } from '../utils/albumPreviewPolicy'

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

    const startPreview = useCallback((trigger = 'hover') => {
        if (!canRunAlbumPreview(trigger)) return
        stopPreview()
        hoverController.current = startVideoHoverPreview({
            container: wrapperRef.current?.querySelector('.album-card-image'),
            album,
            trigger,
            loadDetail: () => prefetchPublicAlbum(album.albumId),
            onPlaybackStart: () => setPlayOverlayVisible(false),
            onPlaybackEnd: () => setPlayOverlayVisible(true),
        })
    }, [album, setPlayOverlayVisible, stopPreview])

    useEffect(() => stopPreview, [stopPreview])

    useEffect(() => registerMobileAlbumPreview(wrapperRef.current?.querySelector('.album-card-image'), {
        start: () => startPreview('focus'),
        stop: stopPreview,
    }), [startPreview, stopPreview])

    return (
        <div ref={wrapperRef} className="h-full" onMouseEnter={() => startPreview()}
            onMouseLeave={() => { if (canRunAlbumPreview()) stopPreview() }}>
            <AlbumCard album={album} />
        </div>
    )
}
