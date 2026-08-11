export const loadAlbumGalleryRoute = () => import('../pages/AlbumGallery')
export const loadVideoGalleryRoute = () => import('../pages/VideoGallery')

export function preloadAlbumRoute(album) {
    return album?.type === 'video' ? loadVideoGalleryRoute() : loadAlbumGalleryRoute()
}
