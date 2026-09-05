import { useEffect, useId, useState } from 'react'
import AlbumCard from './AlbumCard'
import VideoAlbumCard from './VideoAlbumCard'
import ScrollRow from './ScrollRow'
import { fetchAlbumsPage } from '../utils/api'
import {
    getCatalogSnapshot,
    loadCompleteCatalog,
    reconcilePublicCatalogItems,
    setCatalogSnapshot,
} from '../utils/catalogState'
import { selectExploreMoreAlbums } from '../utils/exploreMoreAlbums'

export default function ExploreMoreAlbums({ album, mediaType = album.type === 'video' ? 'video' : 'photo' }) {
    const headingId = useId()
    const albumId = album.albumId
    const category = album.category || 'Uncategorized'
    const scope = JSON.stringify([albumId, category, mediaType])
    const [result, setResult] = useState(null)

    useEffect(() => {
        const controller = new AbortController()
        const catalogKey = mediaType === 'video' ? 'public-videos' : 'public-photos'
        const snapshot = getCatalogSnapshot(catalogKey)
        const hasFreshSnapshot = Boolean(snapshot && !snapshot.stale)

        loadCompleteCatalog({
            fetchPage: (cursor) => fetchAlbumsPage({
                visibility: 'public',
                type: mediaType,
                limit: 100,
                cursor,
            }, { signal: controller.signal }),
            initialItems: hasFreshSnapshot ? snapshot.items : [],
            initialCursor: hasFreshSnapshot ? snapshot.nextCursor : null,
            hasInitialPage: hasFreshSnapshot,
            signal: controller.signal,
        }).then(({ items }) => {
            if (controller.signal.aborted) return
            const catalog = reconcilePublicCatalogItems(items, mediaType)
            if (!hasFreshSnapshot || snapshot.nextCursor) {
                setCatalogSnapshot(catalogKey, { items: catalog, nextCursor: null })
            }
            setResult({
                scope,
                albums: selectExploreMoreAlbums(catalog, { albumId, category, type: mediaType }),
            })
        }).catch(() => {
            // Recommendations are optional; a catalog failure must not interrupt the gallery.
        })

        return () => controller.abort()
    }, [albumId, category, mediaType, scope])

    if (result?.scope !== scope || !result.albums.length) return null

    return (
        <section aria-labelledby={headingId} className="mt-16 border-t border-warm-border pt-10">
            <div className="mb-8 flex flex-wrap items-baseline gap-x-4 gap-y-2">
                <h2 id={headingId} className="font-serif text-3xl font-normal text-charcoal">Explore more</h2>
                <p className="text-sm text-warm-gray">{category}</p>
            </div>
            <ScrollRow>
                {result.albums.map((relatedAlbum) => (
                    <div key={relatedAlbum.albumId} className="shrink-0 w-[280px] sm:w-[320px] lg:w-[360px] snap-start">
                        {mediaType === 'video' ? (
                            <VideoAlbumCard album={relatedAlbum} />
                        ) : (
                            <AlbumCard album={relatedAlbum} showNewFlag preview />
                        )}
                    </div>
                ))}
            </ScrollRow>
        </section>
    )
}
