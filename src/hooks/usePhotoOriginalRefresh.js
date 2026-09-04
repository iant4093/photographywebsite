import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchAlbum } from '../utils/api'
import { mediaId } from '../utils/mediaUrls'

function photoKey(image) {
    return JSON.stringify([image?.albumId, mediaId(image)])
}

// Public discovery views retain their deck and selection while refreshing only
// the original descriptor through the album's current access check.
export default function usePhotoOriginalRefresh(images) {
    const [originals, setOriginals] = useState(() => new Map())
    const requestsRef = useRef(new Map())

    useEffect(() => {
        const requests = requestsRef.current
        return () => {
            requests.forEach(({ controller }) => controller.abort())
            requests.clear()
        }
    }, [])

    const refreshOriginal = useCallback(async (_event, image) => {
        const id = mediaId(image)
        if (!image?.albumId || !id) return
        const key = photoKey(image)
        const source = images.find(candidate => photoKey(candidate) === key)
        if (!source) return

        let request = requestsRef.current.get(image.albumId)
        if (!request) {
            const controller = new AbortController()
            request = { controller, promise: null }
            const record = request
            request.promise = fetchAlbum(image.albumId, null, { force: true, signal: controller.signal })
                .finally(() => {
                    if (requestsRef.current.get(image.albumId) === record) requestsRef.current.delete(image.albumId)
                })
            requestsRef.current.set(image.albumId, request)
        }

        const updateOriginal = (before) => {
            if (request.controller.signal.aborted) return
            setOriginals(current => new Map(current).set(key, { source: source.before, before }))
        }
        try {
            const album = await request.promise
            const refreshed = album?.images?.find(candidate => mediaId(candidate) === id)
            updateOriginal(refreshed ? refreshed.before : { status: 'unavailable' })
        } catch (error) {
            if (request.controller.signal.aborted || error?.name === 'AbortError') return
            updateOriginal({ status: 'failed' })
            throw error
        }
    }, [images])

    const refreshedImages = useMemo(() => images.map(image => {
        const original = originals.get(photoKey(image))
        // New data supplied by the owning view takes precedence over an older
        // refresh, including when a request finishes after changing filters.
        return original && original.source === image.before ? { ...image, before: original.before } : image
    }), [images, originals])

    return { images: refreshedImages, refreshOriginal }
}
