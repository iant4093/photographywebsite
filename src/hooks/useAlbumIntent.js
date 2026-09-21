import { useCallback, useEffect, useRef } from 'react'
import { prefetchPublicAlbum } from '../utils/api'
import { preloadAlbumRoute } from '../utils/routePreload'

export default function useAlbumIntent(album) {
    const timer = useRef(null)
    const cancel = useCallback(() => {
        window.clearTimeout(timer.current)
        timer.current = null
    }, [])
    const warm = useCallback(() => {
        cancel()
        if (album?.visibility !== 'public') return
        void preloadAlbumRoute(album).catch(() => {})
        void prefetchPublicAlbum(album.albumId)
    }, [album, cancel])
    const schedule = useCallback(() => {
        if (timer.current !== null || navigator.connection?.saveData) return
        timer.current = window.setTimeout(warm, 250)
    }, [warm])
    useEffect(() => cancel, [cancel, album])
    return { onMouseEnter: schedule, onMouseLeave: cancel, onFocus: warm, onBlur: cancel, onPointerDown: warm }
}
