import { useState, useEffect, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../context/authContext'
import { fetchAlbumsFiltered, fetchAlbum } from '../utils/api'
import JSZip from 'jszip'

// User dashboard — shows only their private albums with download capability
function UserDashboard() {
    const { userEmail, getIdToken } = useAuth()
    const location = useLocation()
    const [albums, setAlbums] = useState([])
    const [loading, setLoading] = useState(true)

    // Selected album for viewing images
    const [selectedAlbum, setSelectedAlbum] = useState(null)
    const [images, setImages] = useState([])
    const [loadingImages, setLoadingImages] = useState(false)
    const [downloading, setDownloading] = useState(false)

    // Lightbox state — store index instead of URL for prev/next navigation
    const [lightboxIndex, setLightboxIndex] = useState(null)

    // Fetch user's albums on mount
    useEffect(() => {
        if (!userEmail) return
        fetchAlbumsFiltered({ visibility: 'private', ownerEmail: userEmail })
            .then(setAlbums)
            .catch(() => setAlbums([]))
            .finally(() => setLoading(false))
    }, [userEmail])

    // Reset to albums list when navigating to this page (e.g. clicking Dashboard in nav)
    useEffect(() => {
        setSelectedAlbum(null)
        setImages([])
        setLightboxIndex(null)
    }, [location.key])

    // Open album to view images
    async function openAlbum(album) {
        setLoadingImages(true)
        setSelectedAlbum(album)
        try {
            const token = await getIdToken()
            const data = await fetchAlbum(album.albumId, token)
            setImages(data.images || [])
        } catch (err) {
            console.error('Failed to load images:', err)
        } finally {
            setLoadingImages(false)
        }
    }

    // Download all photos in the album as a ZIP file
    async function downloadAll() {
        if (!images.length) return
        setDownloading(true)
        try {
            const zip = new JSZip()
            const folderName = selectedAlbum?.title || 'album'
            const folder = zip.folder(folderName)

            // Fetch all images in parallel for speed. 
            // We use cache: 'no-store' instead of dynamic URLs because Safari heavily blocks dynamic query string fetches 
            // inside loops as anti-tracking or strict CORS violations.
            const fetchPromises = images.map(async (img, index) => {
                try {
                    const urlObj = new URL(img.url)
                    urlObj.searchParams.set('dl', '1')

                    const response = await fetch(urlObj.toString(), { mode: 'cors', cache: 'no-store' })
                    if (!response.ok) throw new Error(`HTTP error ${response.status}`)
                    const blob = await response.blob()
                    const fileName = img.key ? img.key.split('/').pop() : `photo-${index + 1}.jpg`
                    folder.file(fileName, blob)
                } catch (err) {
                    console.error('Failed to fetch image for zip:', err)
                }
            })

            await Promise.all(fetchPromises)

            const zipBlob = await zip.generateAsync({ type: 'blob' })
            const url = URL.createObjectURL(zipBlob)
            const a = document.createElement('a')
            a.href = url
            a.download = `${folderName}.zip`
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            URL.revokeObjectURL(url)
        } catch (err) {
            console.error('ZIP Download failed:', err)
        } finally {
            setDownloading(false)
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

        const urlToDownload = img.url
        const fileName = img.key ? img.key.split('/').pop() : 'photo.jpg'

        try {
            // Reverted back to cache: no-store instead of dynamic timestamps because iOS Safari 
            // natively parses this correctly into a View/Download prompt, while dynamic urls throw CORS errors and get popup blocked.
            const urlObj = new URL(urlToDownload)
            urlObj.searchParams.set('dl', '1')
            const response = await fetch(urlObj.toString(), { mode: 'cors', cache: 'no-store' })
            const blob = await response.blob()
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = fileName
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            setTimeout(() => URL.revokeObjectURL(url), 100)
        } catch (err) {
            console.error('Download failed, falling back to direct navigation:', err)
            // window.open() inside an async catch block is heavily blocked by iOS Safari popup blockers.
            // Using window.location.assign gracefully navigates the user directly to the image where they can save it.
            window.location.assign(urlToDownload)
        }
    }

    // Group albums by category. Treat falsy values as "Uncategorized"
    const groupedAlbums = albums.reduce((acc, album) => {
        const cat = album.category || 'Uncategorized';
        if (!acc[cat]) acc[cat] = [];
        acc[cat].push(album);
        return acc;
    }, {});

    // Sort categories alphabetically, but put "Uncategorized" at the end
    const categories = Object.keys(groupedAlbums).sort((a, b) => {
        if (a === 'Uncategorized') return 1;
        if (b === 'Uncategorized') return -1;
        return a.localeCompare(b);
    });

    return (
        <div className="max-w-5xl mx-auto px-6 py-12">
            <div className="animate-slide-up">
                <div className="mb-10">
                    <h1 className="font-serif text-4xl font-semibold text-charcoal">Your Photos</h1>
                    <p className="mt-2 text-warm-gray">
                        Browse and download your photo albums.
                    </p>
                </div>

                {/* Albums grid or selected album view */}
                {selectedAlbum ? (
                    /* Album detail view */
                    <div className="animate-fade-in">
                        <button
                            onClick={() => { setSelectedAlbum(null); setImages([]) }}
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
                                        Downloading…
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

                        {/* Images */}
                        {loadingImages ? (
                            <div className="flex justify-center py-20">
                                <div className="w-10 h-10 border-3 border-amber border-t-transparent rounded-full animate-spin" />
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                                {images.map((img, index) => (
                                    <div
                                        key={img.key || index}
                                        className="group cursor-pointer rounded-xl overflow-hidden shadow-warm-sm hover:shadow-warm-lg transition-all duration-500 aspect-square"
                                        onClick={() => setLightboxIndex(index)}
                                    >
                                        <img
                                            src={img.url}
                                            alt={`Photo ${index + 1}`}
                                            className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-700 ease-out"
                                            loading="lazy"
                                        />
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                ) : (
                    /* Albums grid */
                    <>
                        {loading ? (
                            <div className="flex justify-center py-20">
                                <div className="w-10 h-10 border-3 border-amber border-t-transparent rounded-full animate-spin" />
                            </div>
                        ) : albums.length === 0 ? (
                            <div className="text-center py-20">
                                <svg className="w-16 h-16 mx-auto text-warm-gray/30 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                </svg>
                                <p className="text-warm-gray text-lg">No photos available yet.</p>
                                <p className="text-warm-gray/70 text-sm mt-1">Check back soon!</p>
                            </div>
                        ) : (
                            <div className="flex flex-col gap-12">
                                {categories.map((cat) => (
                                    <div key={cat}>
                                        <div className="flex items-center gap-4 mb-6">
                                            <h3 className="font-serif text-2xl font-medium text-charcoal">{cat}</h3>
                                            <div className="h-px bg-warm-border flex-1"></div>
                                        </div>
                                        <div className="flex overflow-x-auto gap-6 pb-6 snap-x snap-mandatory scrollbar-hide">
                                            {groupedAlbums[cat].map((album) => (
                                                <button
                                                    key={album.albumId}
                                                    onClick={() => openAlbum(album)}
                                                    className="shrink-0 w-[280px] sm:w-[320px] md:w-[340px] snap-start group block rounded-2xl overflow-hidden shadow-warm hover:shadow-warm-lg transition-all duration-500 bg-white text-left cursor-pointer"
                                                >
                                                    {/* Cover image */}
                                                    <div className="aspect-[4/3] overflow-hidden">
                                                        {album.coverImageUrl ? (
                                                            <img
                                                                src={album.coverImageUrl}
                                                                alt={album.title}
                                                                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700 ease-out"
                                                            />
                                                        ) : (
                                                            <div className="w-full h-full bg-cream-dark flex items-center justify-center">
                                                                <svg className="w-12 h-12 text-warm-gray/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                                                </svg>
                                                            </div>
                                                        )}
                                                    </div>
                                                    <div className="p-5">
                                                        <h3 className="font-serif text-lg font-semibold text-charcoal group-hover:text-amber-dark transition-colors">{album.title}</h3>
                                                        {album.description && <p className="mt-1 text-sm text-warm-gray line-clamp-2">{album.description}</p>}
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* Lightbox with prev/next arrows */}
            {lightboxIndex !== null && images[lightboxIndex] && (
                <div
                    className="fixed inset-0 z-[100] bg-charcoal/90 backdrop-blur-sm flex flex-col items-center justify-center p-4 pt-16 pb-8 animate-fade-in"
                    onClick={() => setLightboxIndex(null)}
                >
                    {/* Close button */}
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

                    {/* Image Wrapper */}
                    <div className="flex-1 w-full min-h-0 flex items-center justify-center relative z-0" onClick={(e) => e.stopPropagation()}>
                        <img
                            src={images[lightboxIndex].url}
                            alt="Full size preview"
                            className="max-w-full max-h-full object-contain rounded-lg shadow-warm-xl animate-scale-in"
                        />
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
                </div>
            )}
        </div>
    )
}

export default UserDashboard
