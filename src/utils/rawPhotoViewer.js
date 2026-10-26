import { PREVIEW_WIDTHS } from './mediaUrls'

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
