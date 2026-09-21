import { prefetchPublicAlbum } from './api'

// Start public data while React and the route chunk initialize. The viewer
// joins the existing request/cache and retains its normal private fallback.
export function warmDirectAlbum(pathname) {
    const match = /^\/(?:album|video)\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/i.exec(pathname)
    if (match) void prefetchPublicAlbum(match[1])
}
