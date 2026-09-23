const MANIFEST_CACHE_LIMIT = 32
const MANIFEST_MAX_BYTES = 32 * 1024
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const VERSION_PATTERN = '[0-9a-f]{24}'
const MANIFEST_PATH_PATTERN = new RegExp(`^/public-previews/(${UUID_PATTERN})/v3/hover-(${VERSION_PATTERN})\\.json$`)
const IMAGE_PATH_PATTERN = new RegExp(`^/public-previews/(${UUID_PATTERN})/v3/[0-9a-f]{24}-w640\\.webp$`)
const manifestCache = new Map()
const pendingRequests = new Map()

const MANIFEST_TIMEOUT_MS = 10_000

function subscribe(entry, signal) {
    if (signal?.aborted) return Promise.reject(new DOMException('Request aborted', 'AbortError'))
    entry.consumers += 1
    return new Promise((resolve, reject) => {
        let finished = false
        const finish = (callback, value) => {
            if (finished) return
            finished = true
            signal?.removeEventListener('abort', abort)
            entry.consumers -= 1
            if (!entry.settled && entry.consumers === 0) entry.cancel()
            callback(value)
        }
        const abort = () => finish(reject, new DOMException('Request aborted', 'AbortError'))
        signal?.addEventListener('abort', abort, { once: true })
        entry.promise.then(value => finish(resolve, value), error => finish(reject, error))
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
        // Ready V3 metadata requires all four deterministic siblings. Derive
        // these only after checking the origin, album, media ID, and 640px URL.
        return { url: url.href, width, height, previewSrcSet: [640, 960, 1440, 1920].map(width => ({
            width,
            url: url.href.replace(/-w640\.webp$/, `-w${width}.webp`),
        })) }
    })
    return {
        schemaVersion: 1,
        albumId: identity.albumId,
        version: identity.version,
        images,
    }
}

async function requestManifest(identity, signal) {
    const response = await fetch(identity.url, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'cors',
        cache: 'force-cache',
        signal,
    })
    if (!response.ok) throw new Error('Album hover manifest was unavailable')
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.toLowerCase().includes('application/json')) {
        throw new Error('Album hover manifest content type was invalid')
    }
    if (Number(response.headers.get('content-length')) > MANIFEST_MAX_BYTES) {
        void response.body?.cancel().catch(() => {})
        throw new Error('Album hover manifest size was invalid')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Album hover manifest body was unavailable')
    const chunks = []
    let length = 0
    try {
        while (true) {
            signal.throwIfAborted()
            const { done, value } = await reader.read()
            if (done) break
            length += value.byteLength
            if (length > MANIFEST_MAX_BYTES) throw new Error('Album hover manifest size was invalid')
            chunks.push(value)
        }
    } catch (error) {
        void reader.cancel().catch(() => {})
        throw error
    } finally { reader.releaseLock() }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!text || text.length > MANIFEST_MAX_BYTES) {
        throw new Error('Album hover manifest size was invalid')
    }
    return validateManifest(JSON.parse(text), identity)
}

export function fetchAlbumHoverManifest(album, options = {}) {
    if (options.signal?.aborted) return Promise.reject(new DOMException('Request aborted', 'AbortError'))
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
        return Promise.resolve(cached)
    }
    let entry = pendingRequests.get(identity.url)
    if (!entry) {
        const controller = new AbortController()
        entry = { consumers: 0, settled: false }
        const evict = () => {
            if (pendingRequests.get(identity.url) === entry) pendingRequests.delete(identity.url)
        }
        entry.cancel = () => { evict(); controller.abort() }
        const timer = setTimeout(entry.cancel, MANIFEST_TIMEOUT_MS)
        // Reject independently of fetch's cooperation, and never cache a late
        // result from an abandoned request over a newer request for this URL.
        const interrupted = new Promise((_, reject) => {
            controller.signal.addEventListener('abort', () => reject(new DOMException('Hover request interrupted', 'AbortError')), { once: true })
        })
        entry.promise = Promise.race([requestManifest(identity, controller.signal), interrupted]).then(value => {
            controller.signal.throwIfAborted()
            manifestCache.set(identity.url, value)
            while (manifestCache.size > MANIFEST_CACHE_LIMIT) manifestCache.delete(manifestCache.keys().next().value)
            return value
        }).finally(() => {
            entry.settled = true
            // Header/parse failures can finish before the response body. Stop
            // that transfer as well as explicitly abandoned consumer requests.
            controller.abort()
            clearTimeout(timer)
            evict()
        })
        entry.promise.catch(() => {})
        pendingRequests.set(identity.url, entry)
    }
    return subscribe(entry, options.signal)
}

export function clearAlbumHoverManifestCache() {
    manifestCache.clear()
    for (const entry of pendingRequests.values()) entry.cancel()
    pendingRequests.clear()
}
