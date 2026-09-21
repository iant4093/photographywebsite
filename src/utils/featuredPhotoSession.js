const FEATURED_SESSION_TTL_MS = 5 * 60_000
const featuredSessionCache = new Map()

function sessionKey(category) {
    return category ? `category:${category}` : 'all'
}

export function readFeaturedPhotoSession(category) {
    const key = sessionKey(category)
    const cached = featuredSessionCache.get(key)
    if (!cached || cached.expiresAt <= Date.now()) {
        featuredSessionCache.delete(key)
        return null
    }
    return cached.images
}

export function cacheFeaturedPhotoSession(category, images) {
    featuredSessionCache.set(sessionKey(category), {
        images,
        expiresAt: Date.now() + FEATURED_SESSION_TTL_MS,
    })
}

export function clearFeaturedPhotoSessionCache() {
    featuredSessionCache.clear()
}
