import { useState, useEffect, useCallback } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { fetchAlbum } from '../utils/api'
import { useAuth } from '../context/authContext'
import JSZip from 'jszip'

// Demo images for when the backend isn't connected
const DEMO_IMAGES = [
    'https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?w=800&q=80',
    'https://images.unsplash.com/photo-1495616811223-4d98c6e9c869?w=800&q=80',
    'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=800&q=80',
    'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=800&q=80',
    'https://images.unsplash.com/photo-1509316785289-025f5b846b35?w=800&q=80',
    'https://images.unsplash.com/photo-1514565131-fce0801e5785?w=800&q=80',
    'https://images.unsplash.com/photo-1448375240586-882707db888b?w=800&q=80',
    'https://images.unsplash.com/photo-1470770841497-7b3200f18291?w=800&q=80',
    'https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=800&q=80',
]

// Album gallery page — displays all images in a masonry-like grid
function AlbumGallery() {
    const { albumId } = useParams()
    const navigate = useNavigate()
    const [album, setAlbum] = useState(null)
    const [images, setImages] = useState([])
    const [loading, setLoading] = useState(true)
    const [downloading, setDownloading] = useState(false)
    const { getIdToken } = useAuth()

    // Lightbox state — store index for prev/next navigation
    const [lightboxIndex, setLightboxIndex] = useState(null)

    // Fetch album data on mount — falls back to demo data
    useEffect(() => {
        const load = async () => {
            let token = null
            try {
                token = await getIdToken()
            } catch (e) {
                // Not logged in, token stays null
            }
            try {
                const data = await fetchAlbum(albumId, token)
                setAlbum(data.album || data)
                setImages(data.images || [])
            } catch (err) {
                // Fallback to demo data
                setAlbum({
                    albumId,
                    title: 'Summer Solstice',
                    description: 'Golden light dancing across the meadows at dusk. A collection of warm, sun-kissed moments.',
                    createdAt: '2026-01-15T18:30:00Z',
                })
                setImages(DEMO_IMAGES.map((url, i) => ({ url, key: `image-${i}` })))
            } finally {
                setLoading(false)
            }
        }
        load()
    }, [albumId, getIdToken])

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

        const urlToDownload = typeof img === 'string' ? img : img.url
        const fileName = typeof img !== 'string' && img.key ? img.key.split('/').pop() : 'photo.jpg'

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

    // Download all photos in the album as a ZIP file
    async function downloadAll() {
        if (!images.length) return
        setDownloading(true)
        try {
            const zip = new JSZip()
            const folderName = album?.title || 'album'
            const folder = zip.folder(folderName)

            // Fetch all images in parallel for speed. 
            // We use cache: 'no-store' instead of dynamic URLs because Safari heavily blocks dynamic query string fetches 
            // inside loops as anti-tracking or strict CORS violations.
            const fetchPromises = images.map(async (img, index) => {
                try {
                    const urlObj = new URL(img.url || img)
                    urlObj.searchParams.set('dl', '1')

                    const response = await fetch(urlObj.toString(), { mode: 'cors', cache: 'no-store' })
                    if (!response.ok) throw new Error(`HTTP error ${response.status}`)
                    const blob = await response.blob()
                    // Handle objects vs raw strings for demo images
                    const keyString = typeof img === 'string' ? img : img.key
                    const fileName = keyString ? keyString.split('/').pop() : `photo-${index + 1}.jpg`
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

    return (
        <div className="max-w-7xl mx-auto px-6 py-12">
            {/* Back link — uses browser back to preserve scroll position */}
            <button
                onClick={() => navigate(-1)}
                className="inline-flex items-center gap-2 text-sm font-medium text-warm-gray hover:text-amber transition-colors duration-200 mb-8 cursor-pointer"
            >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                Back to Albums
            </button>

            {/* Loading state */}
            {loading && (
                <div className="flex justify-center py-32">
                    <div className="w-10 h-10 border-3 border-amber border-t-transparent rounded-full animate-spin" />
                </div>
            )}

            {/* Album content */}
            {!loading && album && (
                <div className="animate-fade-in">
                    {/* Album header */}
                    <div className="mb-12 flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-warm-gray/10">
                        <div>
                            <h1 className="font-serif text-4xl md:text-5xl font-semibold text-charcoal mb-4">
                                {album.title}
                            </h1>
                            {album.description && (
                                <p className="text-lg text-warm-gray max-w-2xl leading-relaxed whitespace-pre-wrap">
                                    {album.description}
                                </p>
                            )}
                            <p className="text-sm text-warm-gray/70 mt-4 uppercase tracking-wider font-medium">
                                {new Date(album.createdAt).toLocaleDateString('en-US', {
                                    year: 'numeric',
                                    month: 'long',
                                    day: 'numeric',
                                })}
                            </p>
                        </div>

                        {/* Download All Button */}
                        {images.length > 0 && (
                            <button
                                onClick={downloadAll}
                                disabled={downloading}
                                className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-medium transition-all duration-300 shadow-warm-sm border border-transparent disabled:opacity-70 disabled:cursor-not-allowed bg-amber text-white hover:bg-amber-dark shrink-0 mb-1"
                            >
                                {downloading ? (
                                    <>
                                        <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                        Zipping...
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
                        )}
                    </div>

                    {/* Image grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        {images.map((img, index) => (
                            <div
                                key={img.key || index}
                                className="group cursor-pointer rounded-xl overflow-hidden shadow-warm-sm hover:shadow-warm-lg transition-all duration-500 aspect-square"
                                onClick={() => setLightboxIndex(index)}
                            >
                                <img
                                    src={img.url || img}
                                    alt={`Photo ${index + 1} from ${album.title}`}
                                    className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-700 ease-out"
                                    loading="lazy"
                                />
                            </div>
                        ))}
                    </div>

                    {/* Empty state */}
                    {images.length === 0 && (
                        <div className="text-center py-20 text-warm-gray">
                            <p className="text-lg">No photos in this album yet.</p>
                        </div>
                    )}
                </div>
            )}

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
                            src={images[lightboxIndex].url || images[lightboxIndex]}
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

export default AlbumGallery
