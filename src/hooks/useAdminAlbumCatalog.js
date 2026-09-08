import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchAlbumsFilteredPage, readCachedAlbumsPage } from '../utils/api'

// Album summaries are cheap; complete the catalog independently of media paging.
export default function useAdminAlbumCatalog(params, getIdToken, ownerEmail = '') {
    const [albums, setAlbums] = useState([])
    const [loading, setLoading] = useState(true)
    const [loadingMore, setLoadingMore] = useState(false)
    const [catalogError, setCatalogError] = useState('')
    const [revision, setRevision] = useState(0)
    const mutations = useRef(new Map())
    const currentScope = useRef('')
    const retry = useCallback(() => setRevision((value) => value + 1), [])
    const patch = useCallback((id, updates) => {
        mutations.current.set(id, { ...(mutations.current.get(id) || {}), ...updates })
        setAlbums((current) => current.map((album) => album.albumId === id ? { ...album, ...updates } : album))
    }, [])
    const remove = useCallback((id) => {
        mutations.current.set(id, null)
        setAlbums((current) => current.filter((album) => album.albumId !== id))
    }, [])

    useEffect(() => {
        const controller = new AbortController()
        const scopeKey = JSON.stringify(params)
        const changed = currentScope.current !== scopeKey
        currentScope.current = scopeKey
        if (changed) mutations.current = new Map()
        const changes = mutations.current
        const merge = (items) => items.filter((album) => changes.get(album.albumId) !== null).map((album) => ({ ...album, ...changes.get(album.albumId) }))
        const accepts = (album) => (params.type === 'video' ? album.type === 'video' : album.type !== 'video')
            && (!ownerEmail || String(album.ownerEmail || '').toLowerCase() === ownerEmail.toLowerCase())
        const cached = readCachedAlbumsPage(params, { authenticated: true })
        const timer = window.setTimeout(async () => {
            setCatalogError('')
            setLoading(!cached && changed)
            setLoadingMore(true)
            if (changed) setAlbums(cached ? merge(cached.items.filter(accepts)) : [])
            const loaded = new Map()
            const seen = new Set()
            let cursor = null
            try {
                const token = await getIdToken()
                do {
                    let page
                    // A mutation clears shared API requests. Resume this page
                    // without losing successful local edits or deletions.
                    for (let attempt = 0; attempt < 3; attempt += 1) {
                        try {
                            page = await fetchAlbumsFilteredPage(
                                { ...params, ...(cursor ? { cursor } : {}) }, token,
                                { signal: controller.signal, force: Boolean(cached) || revision > 0 || attempt > 0 },
                            )
                            break
                        } catch (error) {
                            if (controller.signal.aborted || error?.name !== 'AbortError' || attempt === 2) throw error
                        }
                    }
                    if (controller.signal.aborted) return
                    for (const album of page.items.filter(accepts)) loaded.set(album.albumId, album)
                    setAlbums(merge([...loaded.values()]))
                    setLoading(false)
                    cursor = page.nextCursor
                    if (cursor && seen.has(cursor)) throw new Error('Album loading could not finish. Please retry.')
                    if (cursor) seen.add(cursor)
                } while (cursor)
            } catch (error) {
                if (!controller.signal.aborted) setCatalogError(error?.name === 'AbortError' ? 'Album loading was interrupted. Please retry.' : error.message)
            } finally {
                if (!controller.signal.aborted) { setLoading(false); setLoadingMore(false) }
            }
        }, 0)
        return () => { window.clearTimeout(timer); controller.abort() }
    }, [params, getIdToken, ownerEmail, revision])
    return { albums, setAlbums, patch, remove, loading, loadingMore, catalogError, retry }
}
