import { PREVIEW_WIDTHS } from './mediaUrls'
import { warmViewerImage } from './viewerImageWarmup'

export const RAW_PHOTO_VIEWER_PATH = '/admin/raw-photos'
// Drive thumbnail links stay valid for hours; reuse a listing briefly so
// returning to a folder is instant and its images come from the browser cache.
const CACHE_MILLISECONDS = 20 * 60 * 1000
const folderCache = new Map()

export function clearRawPhotoFolderCache() {
    folderCache.clear()
}

export function cachedRawPhotoFolder(folderId) {
    const entry = folderCache.get(folderId)
    if (!entry) return null
    if (Date.now() - entry.storedAt > CACHE_MILLISECONDS) {
        folderCache.delete(folderId)
        return null
    }
    return entry.data
}

export function storeRawPhotoFolder(folderId, data) {
    folderCache.set(folderId, { data, storedAt: Date.now() })
}

export function rawPhotoFolderHref(folder, isRoot) {
    return isRoot ? RAW_PHOTO_VIEWER_PATH : `${RAW_PHOTO_VIEWER_PATH}?folder=${encodeURIComponent(folder.id)}`
}

let measuredStage = null

// The lightbox's photo area. Measure it while open; before the first open,
// estimate it from the viewer's padding so the same srcSet candidate is chosen.
export function lightboxStageBounds() {
    const stage = document.querySelector('.linen-photo-lightbox .linen-lightbox-media')
    const rect = stage?.getBoundingClientRect()
    if (rect?.width > 0 && rect?.height > 0) {
        measuredStage = { width: Math.ceil(rect.width), height: Math.ceil(rect.height) }
    }
    if (measuredStage) return measuredStage
    const padding = window.innerWidth >= 768 ? 96 : 32
    return { width: Math.max(1, window.innerWidth - padding), height: Math.max(1, window.innerHeight - padding - 72) }
}

// Mirrors useContainedImageSizes: the contain-fit CSS width of one photo.
export function lightboxCssWidth(photo, bounds) {
    return Math.min(bounds.width, bounds.height * photo.width / photo.height)
}

// Google renders each size on request, unlike the CDN-cached public previews.
// Keep the viewer-size images the visitor is about to see in the browser cache.
export function createLightboxPrefetchPool() {
    const active = new Map()
    return {
        keep(photos) {
            // Keyed by URL: refreshed Drive links replace their expired prefetch.
            const wanted = new Map(photos.filter(photo => photo?.width && photo?.height).map(photo => [photo.url, photo]))
            for (const [url, release] of active) {
                if (!wanted.has(url)) {
                    release()
                    active.delete(url)
                }
            }
            if (!wanted.size) return
            const bounds = lightboxStageBounds()
            for (const [url, photo] of wanted) {
                if (!active.has(url)) active.set(url, warmViewerImage(photo, lightboxCssWidth(photo, bounds)))
            }
        },
        clear() {
            for (const release of active.values()) release()
            active.clear()
        },
    }
}

// Google resizes the camera JPG on request; widths match the site's srcSet.
export function toViewerPhoto(photo) {
    const base = photo.thumbnail
    return {
        id: photo.id,
        altText: photo.name,
        thumbnailUrl: `${base}=w640`,
        url: `${base}=w2560`,
        previewSrcSet: PREVIEW_WIDTHS.map((width) => ({ width, url: `${base}=w${width}` })),
        ...(photo.width && photo.height ? { width: photo.width, height: photo.height } : {}),
    }
}
