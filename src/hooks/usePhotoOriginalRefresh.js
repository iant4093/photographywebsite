import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { requestAlbumOriginalComparison, requestSharedOriginalComparison } from '../utils/api'
import { mediaId } from '../utils/mediaUrls'
import { reuseOriginalPreview } from '../utils/originalPreviewReuse'

// Fetch just the selected original, retaining the owning view's deck and access
// scope. Every request rechecks album or share access on the server.
export default function usePhotoOriginalRefresh(images, { albumId, shareCode, getIdToken } = {}) {
    const [originals, setOriginals] = useState(() => new Map())
    const requestsRef = useRef(new Map())
    const photoKey = useCallback(image => JSON.stringify([
        shareCode || '', image?.albumId || albumId, mediaId(image),
    ]), [albumId, shareCode])

    useEffect(() => {
        const requests = requestsRef.current
        return () => {
            requests.forEach(({ controller }) => controller.abort())
            requests.clear()
        }
    }, [])

    const refreshOriginal = useCallback(async (event, image, context) => {
        const id = mediaId(image)
        const targetAlbumId = image?.albumId || albumId
        if ((!targetAlbumId && !shareCode) || !id) return
        const key = photoKey(image)
        const source = images.find(candidate => photoKey(candidate) === key)
        if (!source) return

        let request = requestsRef.current.get(key)
        if (!request) {
            const controller = new AbortController()
            request = { controller, source, failed: false, promise: null }
            const record = request
            request.promise = (async () => {
                if (shareCode) return requestSharedOriginalComparison(shareCode, id, { signal: controller.signal })
                let token = null
                try { token = getIdToken ? await getIdToken() : null } catch {
                    // Logged-out visitors can compare public photos. The server
                    // still checks current album access before issuing a URL.
                }
                if (controller.signal.aborted) return null
                return requestAlbumOriginalComparison(targetAlbumId, id, token, { signal: controller.signal })
            })().finally(() => {
                if (requestsRef.current.get(key) === record) requestsRef.current.delete(key)
            })
            requestsRef.current.set(key, request)
        }
        if (event?.type === 'error' || context?.reason === 'media-error') request.failed = true

        const updateOriginal = before => {
            if (request.controller.signal.aborted) return
            setOriginals(current => {
                const prior = current.get(key)
                const previous = prior?.source === request.source
                    ? { ...request.source, before: prior.before } : request.source
                const next = { ...request.source, before }
                const reused = request.failed ? next : reuseOriginalPreview(previous, next, { albumId: targetAlbumId })
                return new Map(current).set(key, { source: request.source, before: reused.before })
            })
        }
        try {
            const result = await request.promise
            updateOriginal(result?.before ?? undefined)
        } catch (error) {
            if (request.controller.signal.aborted || error?.name === 'AbortError') return
            updateOriginal({ status: 'failed' })
            throw error
        }
    }, [albumId, getIdToken, images, photoKey, shareCode])

    const refreshedImages = useMemo(() => images.map(image => {
        const original = originals.get(photoKey(image))
        // New owning-view data takes precedence, including late responses after
        // changing albums or filters.
        return original && original.source === image ? { ...image, before: original.before } : image
    }), [images, originals, photoKey])

    return { images: refreshedImages, refreshOriginal }
}
