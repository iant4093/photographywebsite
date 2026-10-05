// Album and video URLs. Public albums have a readable slug (/album/prague-2026);
// everything else, and links made before the slug existed, use the album id.

const ALBUM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isAlbumId(value) {
    return typeof value === 'string' && ALBUM_ID_RE.test(value)
}

export function isAlbumSlug(value) {
    return typeof value === 'string' && value.length <= 80 && SLUG_RE.test(value) && !isAlbumId(value)
}

/** The path segment for an album: its slug when it has one, else its id. */
export function albumHandle(album) {
    return isAlbumSlug(album?.slug) ? album.slug : String(album?.albumId || '')
}

/** /album/<handle> or /video/<handle> (single videos open straight into the player). */
export function albumPath(album, { play = true } = {}) {
    const kind = album?.type === 'video' ? 'video' : 'album'
    const path = `/${kind}/${albumHandle(album)}`
    return play && kind === 'video' && album?.imageCount === 1 ? `${path}?play=1` : path
}
