const MANIFEST_CACHE_LIMIT = 32
const MANIFEST_MAX_BYTES = 32 * 1024
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const VERSION_PATTERN = '[0-9a-f]{24}'
const MANIFEST_PATH_PATTERN = new RegExp(`^/public-previews/(${UUID_PATTERN})/v3/hover-(${VERSION_PATTERN})\\.json$`)
const IMAGE_PATH_PATTERN = new RegExp(`^/public-previews/(${UUID_PATTERN})/v3/[0-9a-f]{24}-w640\\.webp$`)
const manifestCache = new Map()
const pendingRequests = new Map()

function withAbort(promise, signal) {
    if (!signal) return promise
    if (signal.aborted) return Promise.reject(new DOMException('Request aborted', 'AbortError'))
    return new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException('Request aborted', 'AbortError'))
        signal.addEventListener('abort', abort, { once: true })
        promise.then(
            value => {
                signal.removeEventListener('abort', abort)
                resolve(value)
            },
            error => {
                signal.removeEventListener('abort', abort)
                reject(error)
            },
        )
    })
}

function validatedManifestIdentity(album) {
    const value = album?.hoverPreviewManifestUrl
    if (album?.hoverPreviewStatus !== 'ready' || typeof value !== 'string') return null
    let manifest
    try {
        manifest = new URL(value)
    } catch {
        throw new Error('Album hover manifest URL was invalid')
    }
    const match = MANIFEST_PATH_PATTERN.exec(manifest.pathname)
    if (
        manifest.protocol !== 'https:'
        || manifest.username
        || manifest.password
        || manifest.search
        || manifest.hash
        || !match
        || match[1] !== album?.albumId
        || match[2] !== album?.hoverPreviewVersion
    ) {
        throw new Error('Album hover manifest URL was invalid')
    }
    const cover = album?.coverImageUrl || album?.coverThumbnailUrl
    if (cover) {
        try {
            if (new URL(cover).origin !== manifest.origin) {
                throw new Error('Album hover manifest origin was invalid')
            }
        } catch (error) {
            if (error?.message === 'Album hover manifest origin was invalid') throw error
        }
    }
    return { url: manifest.href, albumId: match[1], version: match[2], origin: manifest.origin }
}

function validateManifest(payload, identity) {
    if (
        !payload
        || Array.isArray(payload)
        || payload.schemaVersion !== 1
        || payload.albumId !== identity.albumId
        || payload.version !== identity.version
        || !Array.isArray(payload.images)
        || payload.images.length < 2
        || payload.images.length > 12
    ) {
        throw new Error('Album hover manifest did not match its contract')
    }
    const seen = new Set()
    const images = payload.images.map(item => {
        let url
        try {
            url = new URL(item?.url)
        } catch {
            throw new Error('Album hover manifest contained an invalid image')
        }
        const match = IMAGE_PATH_PATTERN.exec(url.pathname)
        const width = Number(item?.width)
        const height = Number(item?.height)
        if (
            url.protocol !== 'https:'
            || url.origin !== identity.origin
            || url.search
            || url.hash
            || !match
            || match[1] !== identity.albumId
            || !Number.isInteger(width)
            || !Number.isInteger(height)
            || width !== 640
            || height < 1
            || height >= width
            || seen.has(url.href)
        ) {
            throw new Error('Album hover manifest contained an invalid image')
        }
        seen.add(url.href)
        return { url: url.href, width, height }
    })
    return {
        schemaVersion: 1,
        albumId: identity.albumId,
        version: identity.version,
        images,
    }
}

async function requestManifest(identity) {
    const response = await fetch(identity.url, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'cors',
        cache: 'force-cache',
    })
    if (!response.ok) throw new Error('Album hover manifest was unavailable')
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.toLowerCase().includes('application/json')) {
        throw new Error('Album hover manifest content type was invalid')
    }
    const text = await response.text()
    if (!text || text.length > MANIFEST_MAX_BYTES) {
        throw new Error('Album hover manifest size was invalid')
    }
    return validateManifest(JSON.parse(text), identity)
}

export function fetchAlbumHoverManifest(album, options = {}) {
    if (album?.hoverPreviewStatus === 'unavailable') {
        return Promise.resolve({ schemaVersion: 1, images: [] })
    }
    let identity
    try {
        identity = validatedManifestIdentity(album)
    } catch (error) {
        return Promise.reject(error)
    }
    if (!identity) return Promise.resolve(null)

    const cached = manifestCache.get(identity.url)
    if (cached) {
        manifestCache.delete(identity.url)
        manifestCache.set(identity.url, cached)
        return withAbort(Promise.resolve(cached), options.signal)
    }
    let request = pendingRequests.get(identity.url)
    if (!request) {
        request = requestManifest(identity).then(value => {
            manifestCache.set(identity.url, value)
            while (manifestCache.size > MANIFEST_CACHE_LIMIT) {
                manifestCache.delete(manifestCache.keys().next().value)
            }
            return value
        }).finally(() => pendingRequests.delete(identity.url))
        request.catch(() => {})
        pendingRequests.set(identity.url, request)
    }
    return withAbort(request, options.signal)
}

export function clearAlbumHoverManifestCache() {
    manifestCache.clear()
    pendingRequests.clear()
}
