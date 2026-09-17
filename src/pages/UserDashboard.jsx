import usePhotoSections from '../hooks/usePhotoSections'
import AlbumPhotoSections from '../components/AlbumPhotoSections'
import usePhotoOriginalRefresh from '../hooks/usePhotoOriginalRefresh'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useLocation, useNavigate, useNavigationType } from 'react-router'
import { useAuth } from '../context/auth'
import { fetchAlbumsFiltered, fetchAlbum, requestAlbumMediaDownload, requestAlbumPrintSession, requestAlbumZip } from '../utils/api'
import { motion } from 'framer-motion'
import PrivateAlbumCatalog from '../components/PrivateAlbumCatalog'
import SkeletonGrid from '../components/SkeletonGrid'
import { useScrollRestoration, saveVerticalScroll, getSavedScroll } from '../utils/scroll'
import {
    mediaFileName,
    mediaId,
    resolveMediaDownloadUrl,
    startBrowserDownload,
} from '../utils/mediaUrls'
import { useMediaExpiryRefresh } from '../utils/useMediaExpiryRefresh'
import { reuseOriginalPreviews } from '../utils/originalPreviewReuse'
import { pollZipJob } from '../utils/zipDownload'
import AlbumStats from '../components/AlbumStats'
import PhotoLightbox from '../components/PhotoLightbox'
import { openPrintOrder } from '../utils/printOrders'

// User dashboard — shows only their private albums with download capability
function UserDashboard() {
    const { userEmail, getIdToken } = useAuth()
    const location = useLocation()
    const navigate = useNavigate()
    const navType = useNavigationType()

    // Manage scroll memory for this page
    useScrollRestoration(location.pathname, navType === 'POP')
    const [albums, setAlbums] = useState([])
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState('')
    const [mediaError, setMediaError] = useState('')

    // Selected album for viewing images
    const [selectedAlbum, setSelectedAlbum] = useState(null)
    const [images, setImages] = useState([])
    const [loadingImages, setLoadingImages] = useState(false)
    const [downloading, setDownloading] = useState(false)
    const [zipError, setZipError] = useState('')
    const [zipStatus, setZipStatus] = useState('')
    const zipControllerRef = useRef(null)
    const selectedImageScopeRef = useRef(null)

    // Each photo section owns its lightbox navigation.
    const { sections, activeImages, lightboxIndex, openPhoto, resetLightbox, goNext, goPrev } = usePhotoSections(images)

    // Save scroll position before entering an album detail view
    const savedScrollY = useRef(0)

    const loadAlbums = useCallback(async ({ signal, background = false } = {}) => {
        if (!userEmail) return []
        await Promise.resolve()
        if (!background) setLoading(true)
        try {
            const token = await getIdToken()
            const data = await fetchAlbumsFiltered(
                { visibility: 'private' },
                token,
                { signal }
            )
            const owner = userEmail.trim().toLowerCase()
            const ownedAlbums = data.filter(
                album => !album.ownerEmail
                    || String(album.ownerEmail).trim().toLowerCase() === owner,
            )
            setAlbums(ownedAlbums)
            setLoadError('')
            setMediaError('')
            return ownedAlbums
        } catch (error) {
            if (error?.name !== 'AbortError') {
                if (background) setMediaError('Album covers expired and could not be refreshed. Check your connection and try again.')
                else {
                    setAlbums([])
                    setLoadError('Your albums could not be loaded. Please try again.')
                }
            }
            throw error
        } finally {
            if (!background && !signal?.aborted) setLoading(false)
        }
    }, [getIdToken, userEmail])

    // Fetch user's albums on mount.
    useEffect(() => {
        if (!userEmail) return undefined
        const controller = new AbortController()
        Promise.resolve()
            .then(() => loadAlbums({ signal: controller.signal }))
            .catch(() => {})
        return () => controller.abort()
    }, [loadAlbums, userEmail])

    useEffect(() => () => zipControllerRef.current?.abort(), [])

    const refreshAlbumCovers = useCallback(
        () => loadAlbums({ background: true }),
        [loadAlbums],
    )
    const requestCoverRefresh = useMediaExpiryRefresh(albums, refreshAlbumCovers)

    // Restore scroll position after data loads on POP navigation
    useEffect(() => {
        if (!loading && navType === 'POP') {
            const saved = getSavedScroll(location.pathname)
            if (saved !== undefined) {
                requestAnimationFrame(() => {
                    window.scrollTo({ top: saved, behavior: 'instant' })
                })
            }
        }
    }, [loading, location.pathname, navType])

    // Reset to albums list when navigating to this page (e.g. clicking Dashboard in nav)
    useEffect(() => {
        selectedImageScopeRef.current?.controller.abort()
        selectedImageScopeRef.current = null
        const frame = requestAnimationFrame(() => {
            setSelectedAlbum(null)
            setImages([])
            resetLightbox()
            setLoadingImages(false)
        })
        return () => {
            cancelAnimationFrame(frame)
            selectedImageScopeRef.current?.controller.abort()
            selectedImageScopeRef.current = null
        }
    }, [location.key, userEmail, resetLightbox])

    const loadSelectedImages = useCallback(async (album, { background = false, reuseOriginals = true } = {}) => {
        if (!album) return []
        const scope = selectedImageScopeRef.current
        if (!scope || scope.albumId !== album.albumId || scope.controller.signal.aborted) return []
        const { signal } = scope.controller
        if (!background) setLoadingImages(true)
        try {
            const token = await getIdToken()
            if (signal.aborted) return []
            const data = await fetchAlbum(album.albumId, token, { signal, force: background })
            if (signal.aborted) return []
            const nextImages = data.images || []
            setImages(current => background && reuseOriginals
                ? reuseOriginalPreviews(current, nextImages, { albumId: album.albumId }) : nextImages)
            setMediaError('')
            return data.images || []
        } catch (err) {
            if (signal.aborted) return []
            if (err?.name !== 'AbortError') {
                console.error('Failed to load images:', err)
                setMediaError(background
                    ? 'Some photo links expired and could not be refreshed. Check your connection and try again.'
                    : 'The photos in this album could not be loaded. Please try again.')
            }
            throw err
        } finally {
            if (!background && !signal.aborted) setLoadingImages(false)
        }
    }, [getIdToken])

    const refreshSelectedMedia = useCallback(
        reason => selectedAlbum ? loadSelectedImages(selectedAlbum, { background: true, reuseOriginals: reason !== 'media-error' }) : Promise.resolve(),
        [loadSelectedImages, selectedAlbum],
    )
    const requestSelectedRefresh = useMediaExpiryRefresh(images, refreshSelectedMedia)
    const { images: lightboxImages, refreshOriginal } = usePhotoOriginalRefresh(activeImages, { albumId: selectedAlbum?.albumId, getIdToken })

    // Open photo album to view images inline
    async function openAlbum(album) {
        savedScrollY.current = window.scrollY
        selectedImageScopeRef.current?.controller.abort()
        selectedImageScopeRef.current = null

        if (album.type === 'video') {
            const isSingleVideo = album.imageCount === 1
            saveVerticalScroll(location.pathname)
            navigate(`/video/${album.albumId}${isSingleVideo ? '?play=1' : ''}`)
            return
        }

        selectedImageScopeRef.current = { albumId: album.albumId, controller: new AbortController() }
        setSelectedAlbum(album)
        setImages([])
        resetLightbox()
        setMediaError('')
        await loadSelectedImages(album).catch(() => {})
    }

    // Download all photos in the album as a ZIP file (Using Backend Generator)
    async function downloadAll() {
        if (!images.length || !selectedAlbum) return
        zipControllerRef.current?.abort()
        const controller = new AbortController()
        zipControllerRef.current = controller
        setDownloading(true)
        setZipError('')
        setZipStatus('starting')
        try {
            const token = await getIdToken()
            const url = await pollZipJob({
                jobKey: `album:${selectedAlbum.albumId}`,
                request: ({ signal }) => requestAlbumZip(selectedAlbum.albumId, token, { signal }),
                signal: controller.signal,
                onStatus: setZipStatus,
            })
            startBrowserDownload(url, `${selectedAlbum.title || 'album'}.zip`)
        } catch (err) {
            if (err?.name !== 'AbortError') {
                console.error('ZIP Download failed:', err)
                setZipError(err?.message || 'The ZIP could not be generated. Please try again later.')
            }
        } finally {
            if (zipControllerRef.current === controller) {
                zipControllerRef.current = null
                setDownloading(false)
                setZipStatus('')
            }
        }
    }

    const closeLightbox = resetLightbox

    // Download current lightbox image
    const downloadImage = async (e) => {
        e.stopPropagation()
        const img = activeImages[lightboxIndex]
        if (!img) return

        try {
            const token = await getIdToken()
            const downloadUrl = await resolveMediaDownloadUrl(
                () => requestAlbumMediaDownload(
                    selectedAlbum.albumId,
                    mediaId(img),
                    token,
                ),
                img,
            )
            startBrowserDownload(downloadUrl, mediaFileName(img, 'photo.jpg'))
        } catch (err) {
            console.error('Download failed:', err)
            alert('The photo could not be downloaded. Please try again.')
        }
    }

    const printImage = async (event, image) => {
        event.stopPropagation()
        if (!image || !selectedAlbum?.albumId) return
        try {
            const token = await getIdToken()
            await openPrintOrder(() => requestAlbumPrintSession(
                selectedAlbum.albumId,
                mediaId(image),
                token,
            ))
        } catch (error) {
            console.error('Print order failed:', error)
            alert(error?.message || 'The print store could not be opened. Please try again.')
        }
    }

    const photoAlbums = useMemo(() => albums.filter(a => a.type !== 'video'), [albums]);
    const videoAlbums = useMemo(() => albums.filter(a => a.type === 'video'), [albums]);

    const pageVariants = {
        initial: { opacity: 0, y: 15 },
        animate: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } },
        exit: { opacity: 0, y: -15, transition: { duration: 0.3, ease: "easeIn" } }
    }


    return (
        <motion.div
            variants={pageVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="linen-user-dashboard flex-1 bg-cream animate-fade-in"
        >
            {/* Header section with User Info */}
            <div className="max-w-5xl mx-auto px-6 py-12 pt-[88px] md:pt-[104px]">
                {/* Albums grid or selected album view */}
                {selectedAlbum ? (
                    /* Album detail view */
                    <div className="linen-gallery-page linen-gallery-page-embedded animate-fade-in">
                        <button
                            onClick={() => {
                                selectedImageScopeRef.current?.controller.abort()
                                selectedImageScopeRef.current = null
                                setSelectedAlbum(null)
                                setImages([])
                                resetLightbox()
                                setLoadingImages(false)
                                requestAnimationFrame(() => window.scrollTo({ top: savedScrollY.current, behavior: 'instant' }))
                            }}
                            className="linen-gallery-back inline-flex items-center gap-2 text-sm font-medium text-warm-gray hover:text-amber transition-colors duration-200 mb-8 cursor-pointer"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                            </svg>
                            Back to Albums
                        </button>

                        <div className="linen-gallery-header flex flex-col sm:flex-row gap-6 items-start justify-between mb-8 pb-6 border-b border-warm-border">
                            <div>
                                <h2 className="font-serif text-3xl font-semibold text-charcoal">{selectedAlbum.title}</h2>
                                {selectedAlbum.description && <p className="mt-2 text-warm-gray whitespace-pre-wrap">{selectedAlbum.description}</p>}
                                {!loadingImages && <AlbumStats images={images} />}
                            </div>
                            <button
                                onClick={downloadAll}
                                disabled={downloading || !images.length}
                                className="shrink-0 inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-amber to-amber-dark text-white font-medium hover:from-amber-dark hover:to-amber-dark transition-all shadow-warm hover:shadow-warm-lg disabled:opacity-50 cursor-pointer"
                            >
                                {downloading ? (
                                    <>
                                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                        {zipStatus === 'rate_limited' ? 'Waiting…' : 'Preparing…'}
                                    </>
                                ) : (
                                    <>
                                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                        </svg>
                                        Download All
                                    </>
                                )}
                            </button>
                        </div>

                        {(mediaError || zipError) && (
                            <div role="alert" className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                                {mediaError || zipError}
                            </div>
                        )}

                        {/* Images */}
                        {loadingImages ? (
                            <div className="flex justify-center py-20">
                                <div className="w-10 h-10 border-3 border-amber border-t-transparent rounded-full animate-spin" />
                            </div>
                        ) : (
                            <AlbumPhotoSections sections={sections} albumTitle={selectedAlbum.title} onOpen={openPhoto} itemLabel="Photo"
                                onMediaError={() => requestSelectedRefresh('media-error')} />
                        )}
                    </div>
                ) : (
                    /* Albums grid */
                    <>
                        {loading ? (
                            <div className="py-20">
                                <SkeletonGrid count={6} type="photo" />
                            </div>
                        ) : albums.length === 0 ? (
                            <div className="text-center py-20">
                                <svg className="w-16 h-16 mx-auto text-warm-gray/30 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                </svg>
                                <p className="text-warm-gray text-lg">{loadError || 'No photos or videos available yet.'}</p>
                                {!loadError && <p className="text-warm-gray/70 text-sm mt-1">Check back soon!</p>}
                            </div>
                        ) : (
                            <div className="flex flex-col gap-16">
                                {/* Photos Section */}
                                {photoAlbums.length > 0 && (
                                    <div>
                                        <div className="mb-8">
                                            <h1 className="font-serif text-4xl font-semibold text-charcoal">Your Photos</h1>
                                            <p className="mt-2 text-warm-gray">
                                                Browse and download your photo albums.
                                            </p>
                                        </div>
                                        <div className="flex flex-col gap-8">
                                            <PrivateAlbumCatalog albums={photoAlbums} mediaType="photo" onOpen={openAlbum} onMediaError={() => requestCoverRefresh('media-error')} />
                                        </div>
                                    </div>
                                )}

                                {/* Videos Section */}
                                {videoAlbums.length > 0 && (
                                    <div>
                                        <div className="mb-8">
                                            <h1 className="font-serif text-4xl font-semibold text-charcoal border-t border-warm-border pt-12 md:pt-0 md:border-none">Your Videos</h1>
                                            <p className="mt-2 text-warm-gray">
                                                Watch your private video galleries.
                                            </p>
                                        </div>
                                        <div className="flex flex-col gap-8">
                                            <PrivateAlbumCatalog albums={videoAlbums} mediaType="video" onOpen={openAlbum} onMediaError={() => requestCoverRefresh('media-error')} />
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </>
                )}
            </div>

            {lightboxIndex !== null && activeImages[lightboxIndex] && (
                <PhotoLightbox
                    images={lightboxImages}
                    index={lightboxIndex}
                    ariaLabel={`Photo viewer for ${selectedAlbum?.title || 'private album'}`}
                    onClose={closeLightbox}
                    onNext={goNext}
                    onPrevious={goPrev}
                    onDownload={downloadImage}
                    onPrint={printImage}
                    canShare={false}
                    onBeforeRefresh={refreshOriginal}
                    onMediaError={() => requestSelectedRefresh('media-error')}
                />
            )}
        </motion.div >
    )
}

export default UserDashboard
