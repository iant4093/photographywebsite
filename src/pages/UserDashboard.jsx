import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { useAuth } from '../context/auth'
import { fetchAlbumsFiltered, fetchAlbum, requestAlbumMediaDownload, requestAlbumZip } from '../utils/api'
import { motion, AnimatePresence } from 'framer-motion'
import ProgressiveImage from '../components/ProgressiveImage'
import ScrollRow from '../components/ScrollRow'
import SkeletonGrid from '../components/SkeletonGrid'
import { useScrollRestoration, saveVerticalScroll, getSavedScroll, isRevealed, markAsRevealed } from '../utils/scroll'
import {
    albumCoverUrl,
    mediaDisplayUrl,
    mediaFileName,
    mediaId,
    mediaPreviewSrcSet,
    mediaThumbnailUrl,
    resolveMediaDownloadUrl,
    startBrowserDownload,
} from '../utils/mediaUrls'
import { useMediaExpiryRefresh } from '../utils/useMediaExpiryRefresh'
import { pollZipJob } from '../utils/zipDownload'

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

    // Keyboard navigation for lightbox
    useEffect(() => {
        if (lightboxIndex === null) return
        function handleKey(e) {
            if (e.key === 'ArrowRight') goNext()
            if (e.key === 'ArrowLeft') goPrev()
            if (e.key === 'Escape') setLightboxIndex(null)
        }
        window.addEventListener('keydown', handleKey)
        return () => window.removeEventListener('keydown', handleKey)
    }, [lightboxIndex, goNext, goPrev])

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
        return categoriesList.map(({ category, items }) => (
            <div key={category}>
                <div className="flex items-center gap-4 mb-6">
                    <h3 className="font-serif text-2xl font-medium text-charcoal">{category}</h3>
                    <div className="h-px bg-warm-border flex-1"></div>
                </div>
                <ScrollRow scrollKey={`user-${category}`}>
                    {items.map((album) => (
                        <motion.div
                            key={album.albumId}
                            initial={isRevealed(`user-album-${album.albumId}`) ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
                            whileInView={isRevealed(`user-album-${album.albumId}`) ? {} : { opacity: 1, y: 0 }}
                            onViewportEnter={() => markAsRevealed(`user-album-${album.albumId}`)}
                            viewport={{ once: true, margin: "50px" }}
                            transition={{ duration: 0.5, ease: "easeOut" }}
                            onClick={() => openAlbum(album)}
                            className={`shrink-0 w-[280px] sm:w-[320px] md:w-[340px] snap-start stagger-child group block rounded-2xl overflow-hidden shadow-warm hover:shadow-warm-xl hover:-translate-y-1.5 transition-all duration-500 bg-white text-left cursor-pointer ${isRevealed(`user-album-${album.albumId}`) ? 'no-stagger' : ''}`}
                        >
                            {/* Cover image */}
                            <div className="aspect-[4/3] overflow-hidden relative">
                                {albumCoverUrl(album) ? (
                                    <ProgressiveImage
                                        src={albumCoverUrl(album)}
                                        blurhash={album.coverBlurhash}
                                        alt={album.title}
                                        onError={() => requestCoverRefresh('media-error')}
                                        className="w-full h-full group-hover:scale-105 transition-transform duration-700 ease-out"
                                    />
                                ) : (
                                    <div className="w-full h-full bg-cream-dark flex items-center justify-center">
                                        <svg className="w-12 h-12 text-warm-gray/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                        </svg>
                                    </div>
                                )}
                                {album.type === 'video' && (
                                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                        <div className="w-12 h-12 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center text-white shadow-lg relative">
                                            {album.imageCount > 1 && (
                                                <div className="absolute -top-1 -right-1 bg-amber text-xs font-bold w-5 h-5 flex items-center justify-center rounded-full border-2 border-charcoal">
                                                    {album.imageCount}
                                                </div>
                                            )}
                                            {album.imageCount > 1 ? (
                                                <svg className="w-6 h-6 ml-1" fill="currentColor" viewBox="0 0 24 24">
                                                    <path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8 12.5v-9l6 4.5-6 4.5z" />
                                                </svg>
                                            ) : (
                                                <svg className="w-6 h-6 ml-1" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                                            )}
                                        </div>
                                    </div>
                                )}
                                {/* Golden gradient overlay on hover */}
                                <div className="absolute inset-0 bg-gradient-to-t from-amber-dark/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 z-20 pointer-events-none" />
                            </div>
                            <div className="p-5">
                                <h3 className="font-serif text-lg font-semibold text-charcoal group-hover:text-amber-dark transition-colors">{album.title}</h3>
                                {album.description && <p className="mt-1 text-sm text-warm-gray line-clamp-2">{album.description}</p>}
                            </div>
                        </motion.div>
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
            className="flex-1 bg-cream animate-fade-in"
        >
            {/* Header section with User Info */}
            <div className="max-w-5xl mx-auto px-6 py-12 pt-[88px] md:pt-[104px]">
                {/* Albums grid or selected album view */}
                {selectedAlbum ? (
                    /* Album detail view */
                    <div className="animate-fade-in">
                        <button
                            onClick={() => { setSelectedAlbum(null); setImages([]); requestAnimationFrame(() => window.scrollTo({ top: savedScrollY.current, behavior: 'instant' })) }}
                            className="inline-flex items-center gap-2 text-sm font-medium text-warm-gray hover:text-amber transition-colors duration-200 mb-8 cursor-pointer"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                            </svg>
                            Back to Albums
                        </button>

                        <div className="flex items-start justify-between mb-8">
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
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                                {images.map((img, index) => {
                                    const thumbUrl = mediaThumbnailUrl(img)

                                    return (
                                        <div
                                            key={mediaId(img) || index}
                                            className="group cursor-pointer rounded-xl overflow-hidden shadow-warm-sm hover:shadow-warm-lg transition-shadow duration-500 aspect-[4/3] relative"
                                            onClick={() => setLightboxIndex(index)}
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
                                                    className="w-full h-full group-hover:scale-[1.02] transition-transform duration-700 ease-out"
                                                />
                                                {/* Warm overlay on hover */}
                                                <div className="absolute inset-0 bg-gradient-to-t from-charcoal/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
                                            </div>
                                        </div>
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

            {/* Lightbox Overlay */}
            <AnimatePresence>
                {lightboxIndex !== null && images[lightboxIndex] && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="fixed inset-0 z-[100] bg-charcoal/95 backdrop-blur-md flex flex-col items-center justify-center p-4 md:p-12 mb-0"
                        onClick={() => setLightboxIndex(null)}
                    >
                        <button onClick={() => setLightboxIndex(null)} className="absolute top-6 right-6 text-white/80 hover:text-white transition-colors cursor-pointer z-10">
                            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>

                        {/* Previous arrow */}
                        <button
                            onClick={(e) => { e.stopPropagation(); goPrev() }}
                            className="absolute left-4 md:left-8 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/10 hover:bg-white/25 backdrop-blur-sm text-white flex items-center justify-center transition-all cursor-pointer z-10"
                        >
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                            </svg>
                        </button>

                        {/* Next arrow */}
                        <button
                            onClick={(e) => { e.stopPropagation(); goNext() }}
                            className="absolute right-4 md:right-8 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/10 hover:bg-white/25 backdrop-blur-sm text-white flex items-center justify-center transition-all cursor-pointer z-10"
                        >
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                        </button>

                        {/* Image Wrapper & Info */}
                        <div
                            className="flex-1 w-full min-h-0 flex flex-col items-center justify-center relative z-0"
                            onClick={(e) => e.stopPropagation()}
                        >
                            {(() => {
                                const activeImg = images[lightboxIndex]
                                const thumbUrl = mediaThumbnailUrl(activeImg)
                                const activeRawUrl = mediaDisplayUrl(activeImg)

                                return (
                                    <>
                                        <div className="flex-1 min-h-0 flex items-center justify-center w-full relative">
                                            {/* High-res image with faded-in loading */}
                                            <motion.img
                                                key={`high-${mediaId(activeImg) || lightboxIndex}`}
                                                src={activeRawUrl}
                                                alt="Full size preview"
                                                onError={() => requestSelectedRefresh('media-error')}
                                                width={activeImg.width}
                                                height={activeImg.height}
                                                decoding="async"
                                                initial={{ opacity: 0 }}
                                                animate={{ opacity: 1 }}
                                                exit={{ opacity: 0 }}
                                                transition={{ duration: 0.4, delay: 0.1 }}
                                                className="max-w-full max-h-full object-contain rounded-lg shadow-warm-xl relative z-20"
                                                style={{ willChange: "opacity" }}
                                            />

                                            {/* Placeholder thumbnail for instant visual feedback */}
                                            <img
                                                src={thumbUrl}
                                                alt=""
                                                className="absolute inset-0 w-full h-full object-contain blur-sm scale-95 opacity-50 z-10 pointer-events-none"
                                            />
                                        </div>

                                        {/* EXIF Data Overlay */}
                                        {activeImg && activeImg.exif && (
                                            <div className="shrink-0 mt-4 text-center animate-fade-in max-w-2xl px-4">
                                                {activeImg.exif.model && (
                                                    <p className="text-white font-medium text-sm md:text-base drop-shadow-md">
                                                        {activeImg.exif.model}
                                                    </p>
                                                )}
                                                {activeImg.exif.lens && (
                                                    <p className="text-white/80 text-xs md:text-sm drop-shadow-md mb-1">
                                                        {activeImg.exif.lens}
                                                    </p>
                                                )}
                                                <div className="flex items-center justify-center gap-4 text-white/70 text-xs md:text-sm font-light tracking-wide italic mt-2">
                                                    {activeImg.exif.focalLength && <span>{activeImg.exif.focalLength}</span>}
                                                    {activeImg.exif.focalRatio && <span>{activeImg.exif.focalRatio}</span>}
                                                    {activeImg.exif.shutterSpeed && <span>{activeImg.exif.shutterSpeed}</span>}
                                                    {activeImg.exif.iso && <span>{activeImg.exif.iso}</span>}
                                                </div>
                                            </div>
                                        )}
                                    </>
                                )
                            })()}
                        </div>

                        {/* Download & Image counter */}
                        <div className="shrink-0 mt-6 flex flex-col items-center gap-2 z-10" onClick={(e) => e.stopPropagation()}>
                            <button
                                onClick={downloadImage}
                                className="text-white/60 hover:text-white transition-colors p-4 rounded-full cursor-pointer hover:bg-white/10 active:scale-95 touch-manipulation"
                                title="Download Photo"
                            >
                                <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                </svg>
                            </button>
                            <span className="text-white/70 text-sm font-medium drop-shadow-md">
                                {lightboxIndex + 1} / {images.length}
                            </span>
                        </div>
                    </motion.div>
                )
                }
            </AnimatePresence >
        </motion.div >
    )
}

export default UserDashboard
