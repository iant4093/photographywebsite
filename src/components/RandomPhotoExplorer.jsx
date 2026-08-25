import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PhotoLightbox from './PhotoLightbox'
import { fetchRandomPhotos, requestAlbumMediaDownload } from '../utils/api'
import {
    mediaFileName,
    mediaId,
    mediaPreviewSrcSet,
    mediaThumbnailUrl,
    resolveMediaDownloadUrl,
    startBrowserDownload,
} from '../utils/mediaUrls'
import { trackPhotoDownload } from '../utils/analytics'

const LIGHTBOX_SIZES = '(min-width: 768px) calc(100vw - 12rem), calc(100vw - 2rem)'

function warmFirstPhoto(images) {
    const first = images[0]
    if (!first || typeof Image === 'undefined') return
    const preload = new Image()
    preload.decoding = 'async'
    preload.sizes = LIGHTBOX_SIZES
    preload.srcset = mediaPreviewSrcSet(first)
    preload.src = mediaThumbnailUrl(first)
}

function RandomPhotoExplorer({ albums = [] }) {
    const controllerRef = useRef(null)
    const requestRef = useRef(null)
    const photosRef = useRef([])
    const seedIndexRef = useRef(0)
    const openRef = useRef(false)
    const [photos, setPhotos] = useState([])
    const [index, setIndex] = useState(null)
    const [open, setOpen] = useState(false)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const seedPhotos = useMemo(() => albums.flatMap((album) => {
        const url = album?.coverImageUrl || album?.coverThumbnailUrl
        if (!url || !album?.albumId) return []
        return [{
            id: url,
            url,
            thumbnailUrl: album.coverThumbnailUrl || url,
            downloadUrl: url,
            albumId: album.albumId,
            albumTitle: album.title || '',
            albumCategory: album.category || 'Uncategorized',
            randomSeed: true,
        }]
    }), [albums])

    useEffect(() => {
        if (!seedPhotos.length) return
        seedIndexRef.current = Math.floor(Math.random() * seedPhotos.length)
        warmFirstPhoto([seedPhotos[seedIndexRef.current]])
    }, [seedPhotos])

    const loadSession = useCallback(() => {
        if (photosRef.current.length) return Promise.resolve(photosRef.current)
        if (requestRef.current) return requestRef.current

        const controller = new AbortController()
        controllerRef.current = controller
        const request = fetchRandomPhotos({ signal: controller.signal })
            .then((payload) => {
                const images = payload.images || []
                if (!images.length) throw new Error('No public photos are available yet.')
                photosRef.current = images
                warmFirstPhoto(images)
                return images
            })
            .finally(() => {
                if (controllerRef.current === controller) controllerRef.current = null
                if (requestRef.current === request) requestRef.current = null
            })
        request.catch(() => {})
        requestRef.current = request
        return request
    }, [])

    useEffect(() => {
        // Begin assembling the random session as soon as the hero is mounted.
        // This request is lower priority than the browser's critical assets by
        // virtue of starting in an effect, but it no longer waits for an idle
        // callback that may not run before a visitor clicks the button.
        void loadSession().catch(() => {})
    }, [loadSession])

    useEffect(() => () => controllerRef.current?.abort(), [])

    const handleOpen = useCallback(async () => {
        openRef.current = true
        setOpen(true)
        setError('')
        if (photosRef.current.length) {
            setPhotos(photosRef.current)
            setIndex(Math.floor(Math.random() * photosRef.current.length))
            setLoading(false)
            return
        }

        const hasSeed = seedPhotos.length > 0
        if (hasSeed) {
            setPhotos(seedPhotos)
            setIndex(seedIndexRef.current)
            setLoading(false)
        } else {
            setLoading(true)
        }
        try {
            const images = await loadSession()
            if (!openRef.current) return
            if (hasSeed) {
                setPhotos((current) => {
                    const seen = new Set(current.map((image) => image.url))
                    return current.concat(images.filter((image) => !seen.has(image.url)))
                })
            } else {
                setPhotos(images)
                setIndex(0)
            }
        } catch (requestError) {
            if (requestError?.name !== 'AbortError' && openRef.current) {
                setError(requestError?.message || 'Random photos could not be loaded.')
            }
        } finally {
            if (openRef.current) setLoading(false)
        }
    }, [loadSession, seedPhotos])

    const handleClose = useCallback(() => {
        openRef.current = false
        setOpen(false)
        setIndex(null)
        setLoading(false)
    }, [])

    const handleDownload = useCallback(async (event, image) => {
        event.stopPropagation()
        try {
            if (image.randomSeed && image.downloadUrl) {
                startBrowserDownload(image.downloadUrl, mediaFileName(image, 'photo.jpg'))
                trackPhotoDownload(image.albumId)
                return
            }
            const downloadUrl = await resolveMediaDownloadUrl(
                () => requestAlbumMediaDownload(image.albumId, mediaId(image)),
                image,
            )
            startBrowserDownload(downloadUrl, mediaFileName(image, 'photo.jpg'))
            trackPhotoDownload(image.albumId)
        } catch (downloadError) {
            console.error('Random photo download failed:', downloadError)
            alert('The photo could not be downloaded. Please try again.')
        }
    }, [])

    return (
        <>
            <button
                type="button"
                onClick={handleOpen}
                className="linen-text-link inline-flex cursor-pointer items-center gap-2 px-1 py-2 text-white font-medium transition-all duration-300"
            >
                Explore Random Photos
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4h3l10 16h3M20 4h-3l-3.5 5.6M4 20h3l3.5-5.6" />
                </svg>
            </button>
            {open && (
                <PhotoLightbox
                    images={photos}
                    index={index ?? 0}
                    ariaLabel="Random photos from Ian Truong Photography"
                    loading={loading}
                    emptyMessage={error}
                    onClose={handleClose}
                    onNext={() => setIndex((current) => (current + 1) % photos.length)}
                    onPrevious={() => setIndex((current) => (current - 1 + photos.length) % photos.length)}
                    onDownload={handleDownload}
                />
            )}
        </>
    )
}

export default RandomPhotoExplorer
