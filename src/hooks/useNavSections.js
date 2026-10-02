import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchAlbumsPage } from '../utils/api'
import {
    CatalogPaginationError,
    deleteCatalogSnapshot,
    getCatalogSnapshot,
    loadCompleteCatalog,
    reconcilePublicCatalogItems,
    setCatalogSnapshot,
} from '../utils/catalogState'
import { sortGalleryCategories } from '../utils/galleryOrder'

const CATALOG_KEYS = { photo: 'public-photos', video: 'public-videos' }

// Group the public catalog the same way the Photographs and Videos pages do,
// in their curated section order.
export function catalogSections(items, mediaType) {
    const grouped = {}
    for (const album of items || []) {
        if (mediaType === 'video' ? album?.type !== 'video' : album?.type === 'video') continue
        if (album.visibility !== undefined && album.visibility !== 'public') continue
        const category = album.category || 'Uncategorized'
        ;(grouped[category] ||= []).push(album)
    }
    return sortGalleryCategories(Object.keys(grouped), grouped)
        .map(category => ({ category, count: grouped[category].length }))
}

// Sections for the desktop navigation dropdown. Nothing is fetched until the
// visitor shows interest; each refresh reuses the shared catalog snapshot and
// reloads it once it is stale, so newly published sections appear on their own.
export default function useNavSections(mediaType) {
    const catalogKey = CATALOG_KEYS[mediaType]
    const [state, setState] = useState({ sections: null, failed: false })
    const requestRef = useRef(null)

    useEffect(() => () => requestRef.current?.abort(), [])

    const refresh = useCallback(() => {
        const snapshot = getCatalogSnapshot(catalogKey)
        if (snapshot) setState({ sections: catalogSections(snapshot.items, mediaType), failed: false })
        if (requestRef.current || (snapshot && !snapshot.stale && !snapshot.nextCursor)) return

        const controller = new AbortController()
        const fresh = Boolean(snapshot && !snapshot.stale)
        requestRef.current = controller
        loadCompleteCatalog({
            fetchPage: cursor => fetchAlbumsPage(
                { visibility: 'public', type: mediaType, limit: 100, cursor },
                { signal: controller.signal },
            ),
            initialItems: fresh ? snapshot.items : [],
            initialCursor: fresh ? snapshot.nextCursor : null,
            hasInitialPage: fresh,
            signal: controller.signal,
            onPage: ({ items, nextCursor }) => {
                const reconciled = reconcilePublicCatalogItems(items, mediaType)
                setCatalogSnapshot(catalogKey, { items: reconciled, nextCursor })
                setState({ sections: catalogSections(reconciled, mediaType), failed: false })
            },
        }).catch(error => {
            if (controller.signal.aborted || error.name === 'AbortError') return
            if (error instanceof CatalogPaginationError || ['BAD_CURSOR', 'REPEATED_CURSOR'].includes(error.code)) {
                deleteCatalogSnapshot(catalogKey)
            }
            setState(current => ({ sections: current.sections, failed: !current.sections }))
        }).finally(() => {
            if (requestRef.current === controller) requestRef.current = null
        })
    }, [catalogKey, mediaType])

    return { ...state, refresh }
}
