import { fetchAlbum, fetchAllAlbums } from './api'
import { sectionStats } from './photoStats'

const inSection = (album, category) => album.type !== 'video'
    && (!album.visibility || album.visibility === 'public')
    && (!album.status || album.status === 'active')
    && (album.category || 'Uncategorized') === category

export async function fetchSectionStats(category, { signal } = {}) {
    // Fetch membership afresh, including every catalog page. Summaries do not
    // contain EXIF; load details only for the section the visitor has opened.
    const catalog = await fetchAllAlbums({ type: 'photo', limit: 100 }, { signal, force: true })
    const pending = [...new Map(catalog.filter(album => inSection(album, category))
        .map(album => [album.albumId, album])).values()]
    const albums = []
    async function worker() {
        while (pending.length) {
            if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError')
            const summary = pending.shift()
            try {
                const detail = await fetchAlbum(summary.albumId, null, { signal, force: true })
                const album = { ...detail.album, images: detail.images }
                // A deletion, visibility change or move can race the catalog.
                if (inSection(album, category)) albums.push(album)
            } catch (error) {
                if ([401, 403, 404, 410].includes(error.status)) continue
                pending.length = 0
                throw error
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker))
    return sectionStats(albums)
}
