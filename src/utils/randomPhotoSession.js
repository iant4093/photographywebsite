const RANDOM_SESSION_TTL_MS = 5 * 60_000
const randomSessionCache = new Map()

function sessionKey(category) {
    return category ? `category:${category}` : 'all'
}

export function readRandomPhotoSession(category) {
    const key = sessionKey(category)
    const cached = randomSessionCache.get(key)
    if (!cached || cached.expiresAt <= Date.now()) {
        randomSessionCache.delete(key)
        return null
    }
    return cached.images
}

export function cacheRandomPhotoSession(category, images) {
    randomSessionCache.set(sessionKey(category), {
        images,
        expiresAt: Date.now() + RANDOM_SESSION_TTL_MS,
    })
}

export function clearRandomPhotoSessionCache() {
    randomSessionCache.clear()
}
