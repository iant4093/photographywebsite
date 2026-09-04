import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useLocation, useNavigate, useNavigationType } from 'react-router'
import { useAuth } from '../context/auth'
import { fetchAlbumsFiltered, fetchAlbum, requestAlbumMediaDownload, requestAlbumPrintSession, requestAlbumZip } from '../utils/api'
import { motion } from 'framer-motion'
import ProgressiveImage from '../components/ProgressiveImage'
import AlbumCard from '../components/AlbumCard'
import ScrollRow from '../components/ScrollRow'
import SkeletonGrid from '../components/SkeletonGrid'
import { useScrollRestoration, saveVerticalScroll, getSavedScroll, markAsRevealed } from '../utils/scroll'
import {
    mediaFileName,
    mediaId,
    mediaPreviewSrcSet,
    mediaThumbnailUrl,
    resolveMediaDownloadUrl,
    startBrowserDownload,
} from '../utils/mediaUrls'
import { useMediaExpiryRefresh } from '../utils/useMediaExpiryRefresh'
import { pollZipJob } from '../utils/zipDownload'
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

    // Lightbox state — store index instead of URL for prev/next navigation
    const [lightboxIndex, setLightboxIndex] = useState(null)

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
        const frame = requestAnimationFrame(() => {
            setSelectedAlbum(null)
            setImages([])
            setLightboxIndex(null)
        })
        return () => cancelAnimationFrame(frame)
    }, [location.key])

    const loadSelectedImages = useCallback(async (album, { background = false } = {}) => {
        if (!album) return []
        if (!background) setLoadingImages(true)
        try {
            const token = await getIdToken()
            const data = await fetchAlbum(album.albumId, token)
            setImages(data.images || [])
            setMediaError('')
            return data.images || []
        } catch (err) {
            if (err?.name !== 'AbortError') {
                console.error('Failed to load images:', err)
                setMediaError(background
                    ? 'Some photo links expired and could not be refreshed. Check your connection and try again.'
                    : 'The photos in this album could not be loaded. Please try again.')
            }
            throw err
        } finally {
            if (!background) setLoadingImages(false)
        }
    }, [getIdToken])

    const refreshSelectedMedia = useCallback(
        () => selectedAlbum ? loadSelectedImages(selectedAlbum, { background: true }) : Promise.resolve(),
        [loadSelectedImages, selectedAlbum],
    )
    const requestSelectedRefresh = useMediaExpiryRefresh(images, refreshSelectedMedia)

    // Open photo album to view images inline
    async function openAlbum(album) {
        savedScrollY.current = window.scrollY

        if (album.type === 'video') {
            const isSingleVideo = album.imageCount === 1
            saveVerticalScroll(location.pathname)
            navigate(`/video/${album.albumId}${isSingleVideo ? '?play=1' : ''}`)
            return
        }

        setSelectedAlbum(album)
        setImages([])
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

    // Lightbox navigation — wraps around at ends
    const goNext = useCallback(() => {
        setLightboxIndex((i) => (i + 1) % images.length)
    }, [images.length])

    const goPrev = useCallback(() => {
        setLightboxIndex((i) => (i - 1 + images.length) % images.length)
    }, [images.length])
    const closeLightbox = useCallback(() => setLightboxIndex(null), [])

    // Download current lightbox image
    const downloadImage = async (e) => {
        e.stopPropagation()
        const img = images[lightboxIndex]
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

    const groupAlbums = useCallback((albumList) => {
        const grouped = albumList.reduce((acc, album) => {
            const cat = album.category || 'Uncategorized';
            if (!acc[cat]) acc[cat] = [];
            acc[cat].push(album);
            return acc;
        }, {});
        return Object.keys(grouped).sort((a, b) => {
            if (a === 'Uncategorized') return 1;
            if (b === 'Uncategorized') return -1;
            return a.localeCompare(b);
        }).map(cat => ({ category: cat, items: grouped[cat] }));
    }, []);

    const photoCategories = useMemo(() => groupAlbums(photoAlbums), [photoAlbums, groupAlbums]);
    const videoCategories = useMemo(() => groupAlbums(videoAlbums), [videoAlbums, groupAlbums]);

    const pageVariants = {
        initial: { opacity: 0, y: 15 },
        animate: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } },
        exit: { opacity: 0, y: -15, transition: { duration: 0.3, ease: "easeIn" } }
    }

    const renderAlbumGrid = (categoriesList) => {
        return categoriesList.map(({ category, items }, categoryIndex) => (
            <div key={category}>
                <div className="flex items-center gap-4 mb-6">
                    <span className="linen-category-number">{String(categoryIndex + 1).padStart(2, '0')}</span>
                    <h3 className="font-serif text-2xl font-normal text-charcoal">{category}</h3>
                    <div className="h-px bg-warm-border flex-1"></div>
                </div>
                <ScrollRow scrollKey={`user-${category}`}>
                    {items.map((album) => (
                        <div
                            key={album.albumId}
                            className="shrink-0 w-[280px] sm:w-[320px] md:w-[340px] snap-start stagger-child"
                        >
                            <AlbumCard
                                album={album}
                                onOpen={() => openAlbum(album)}
                                onImageError={() => requestCoverRefresh('media-error')}
                                onMouseEnter={() => markAsRevealed(`user-album-${album.albumId}`)}
                            />
                        </div>
                    ))}
                </ScrollRow>
            </div>
        ))
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
                            onClick={() => { setSelectedAlbum(null); setImages([]); requestAnimationFrame(() => window.scrollTo({ top: savedScrollY.current, behavior: 'instant' })) }}
                            className="linen-gallery-back inline-flex items-center gap-2 text-sm font-medium text-warm-gray hover:text-amber transition-colors duration-200 mb-8 cursor-pointer"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                            </svg>
                            Back to Albums
                        </button>

                        <div className="linen-gallery-header flex items-start justify-between mb-8 pb-6 border-b border-warm-border">
                            <div>
                                <h2 className="font-serif text-3xl font-semibold text-charcoal">{selectedAlbum.title}</h2>
                                {selectedAlbum.description && <p className="mt-2 text-warm-gray">{selectedAlbum.description}</p>}
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
                            <div className="linen-media-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                                {images.map((img, index) => {
                                    const thumbUrl = mediaThumbnailUrl(img)

                                    return (
                                        <button
                                            data-page-scroll-media
                                            type="button"
                                            key={mediaId(img) || index}
                                            className="linen-media-frame group cursor-pointer rounded-xl overflow-hidden shadow-warm-sm hover:shadow-warm-lg transition-shadow duration-500 aspect-[4/3] relative text-left"
                                            onClick={() => setLightboxIndex(index)}
                                            aria-label={`Open item ${index + 1} from ${selectedAlbum.title}`}
                                        >
                                            <div className="relative w-full h-full">
                                                <ProgressiveImage
                                                    src={thumbUrl}
                                                    srcSet={mediaPreviewSrcSet(img) || undefined}
                                                    blurhash={img.blurhash}
                                                    width={img.width}
                                                    height={img.height}
                                                    sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                                                    alt={`Photo ${index + 1} from ${selectedAlbum.title}`}
                                                    onError={() => requestSelectedRefresh('media-error')}
                                                    className="w-full h-full"
                                                />
                                                {/* Warm overlay on hover */}
                                                <div className="absolute inset-0 bg-gradient-to-t from-charcoal/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
                                            </div>
                                        </button>
                                    )
                                })}
                            </div>
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
                                            {renderAlbumGrid(photoCategories)}
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
                                            {renderAlbumGrid(videoCategories)}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </>
                )}
            </div>

            {lightboxIndex !== null && images[lightboxIndex] && (
                <PhotoLightbox
                    images={images}
                    index={lightboxIndex}
                    ariaLabel={`Photo viewer for ${selectedAlbum?.title || 'private album'}`}
                    onClose={closeLightbox}
                    onNext={goNext}
                    onPrevious={goPrev}
                    onDownload={downloadImage}
                    onPrint={printImage}
                    canShare={false}
                    onBeforeRefresh={() => requestSelectedRefresh('original-status')}
                    onMediaError={() => requestSelectedRefresh('media-error')}
                />
            )}
        </motion.div >
    )
}

export default UserDashboard
