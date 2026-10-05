import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { fetchAlbum } from '../utils/api'
import { isAlbumId, isAlbumSlug } from '../utils/albumRoutes'

/**
 * The album id behind an /album/:handle or /video/:handle route.
 *
 * A slug is resolved through the public album API (its response is cached, so
 * the page's own load reuses it). An id link to a public album that has a slug
 * is replaced with the readable URL, keeping ?photo= and the like. Returns ''
 * while a slug is still resolving, and the handle itself if it cannot be
 * resolved, so the page shows its usual not-found state.
 */
export default function useAlbumRouteId(handle, kind) {
    const navigate = useNavigate()
    const { search, hash } = useLocation()
    const [resolved, setResolved] = useState({ handle: '', albumId: '' })

    useEffect(() => {
        if (!handle) return undefined
        if (!isAlbumId(handle) && !isAlbumSlug(handle)) return undefined
        let active = true
        Promise.resolve(fetchAlbum(handle)).then((data) => {
            if (!active) return
            const album = data?.album || {}
            if (!isAlbumId(handle)) setResolved({ handle, albumId: isAlbumId(album.albumId) ? album.albumId : handle })
            if (isAlbumSlug(album.slug) && album.slug !== handle) {
                // Known before the URL changes, so the page stays mounted through the swap.
                if (isAlbumId(album.albumId)) setResolved({ handle: album.slug, albumId: album.albumId })
                navigate({ pathname: `/${kind}/${album.slug}`, search, hash }, { replace: true, preventScrollReset: true })
            }
        }, () => {
            if (active && !isAlbumId(handle)) setResolved({ handle, albumId: handle })
        })
        return () => { active = false }
    }, [handle, hash, kind, navigate, search])

    if (isAlbumId(handle) || !isAlbumSlug(handle)) return handle || ''
    return resolved.handle === handle ? resolved.albumId : ''
}
