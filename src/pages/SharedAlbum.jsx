import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { fetchSharedAlbum } from '../utils/api'
import ProgressiveImage from '../components/ProgressiveImage'
import JSZip from 'jszip'
import { Turnstile } from '@marsidev/react-turnstile'

export default function SharedAlbum() {
    const { code } = useParams()
    const navigate = useNavigate()

    const [album, setAlbum] = useState(null)
    const [images, setImages] = useState([])
    const [loading, setLoading] = useState(false)
    const [downloading, setDownloading] = useState(false)
    const [error, setError] = useState(null)
    const [inputCode, setInputCode] = useState('')
    const [turnstileToken, setTurnstileToken] = useState(null)

    // Lightbox
    const [lightboxIndex, setLightboxIndex] = useState(null)

    // Attempt to load album if code is present in URL
    useEffect(() => {
        if (!code) {
            setLoading(false)
            return
        }

        setLoading(true)
        setError(null)

        fetchSharedAlbum(code, turnstileToken).then(data => {
            setAlbum(data)
            setImages(data.images || [])
            setLoading(false)
        }).catch(err => {
            setError(err.message || 'The gallery could not be loaded. Please check your connection or try again later.')
            setLoading(false)
        })
    }, [code]) // Only depend on code now, not turnstileToken

    const handleManualSubmit = (e) => {
        e.preventDefault()
        let val = inputCode.trim()
        if (val) {
            // Handle full URL pastes naturally
            const parts = val.split('/').filter(Boolean)
            if (parts.length > 0) {
                val = parts[parts.length - 1]
            }
            navigate(`/sharedalbum/${val}`)
        }
    }

    // Lightbox navigation
    const goNext = useCallback(() => {
        setLightboxIndex((i) => (i + 1) % images.length)
    }, [images.length])

    const goPrev = useCallback(() => {
        setLightboxIndex((i) => (i - 1 + images.length) % images.length)
    }, [images.length])

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

    // Download a single image
    const downloadImage = async (e) => {
        e.stopPropagation()
        const img = images[lightboxIndex]
        if (!img) return

        const isLegacyOrDemo = typeof img === 'string' || !img.thumbKey
        const urlToDownload = isLegacyOrDemo ? (img.url || img) : `https://${import.meta.env.VITE_CLOUDFRONT_DOMAIN}/${img.rawKey}`
        const keyString = isLegacyOrDemo ? (typeof img === 'string' ? img : img.key) : img.rawKey
        const fileName = keyString ? keyString.split('/').pop() : 'photo.jpg'

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
            console.error('Download failed, opening directly:', err)
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
                    const isLegacyOrDemo = typeof img === 'string' || !img.thumbKey
                    const rawUrl = isLegacyOrDemo ? (img.url || img) : `https://${import.meta.env.VITE_CLOUDFRONT_DOMAIN}/${img.rawKey}`
                    const urlObj = new URL(rawUrl)
                    urlObj.searchParams.set('dl', '1')

                    const response = await fetch(urlObj.toString(), { mode: 'cors', cache: 'no-store' })
                    if (!response.ok) throw new Error(`HTTP error ${response.status}`)
                    const blob = await response.blob()

                    const keyString = isLegacyOrDemo ? (typeof img === 'string' ? img : img.key) : img.rawKey
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

    // State 1: No code in URL, show manual entry
    if (!code) {
        return (
            <div className="max-w-md mx-auto px-6 py-24 text-center animate-fade-in">
                <svg className="w-16 h-16 mx-auto text-amber mb-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
                <h1 className="font-serif text-3xl font-semibold text-charcoal mb-4">View Shared Album</h1>
                <p className="text-warm-gray mb-8">Enter the unique access code provided to you by the photographer.</p>

                <form onSubmit={handleManualSubmit} className="flex flex-col gap-3">
                    <input
                        type="text"
                        placeholder="e.g. xY7bQk9P"
                        value={inputCode}
                        onChange={(e) => setInputCode(e.target.value)}
                        className="w-full px-6 py-4 rounded-xl border border-warm-border bg-charcoal/5 text-charcoal text-center text-xl tracking-widest uppercase focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all shadow-inner"
                    />
                    <button type="submit" disabled={!inputCode.trim() || !turnstileToken} className="w-full py-4 rounded-xl bg-charcoal text-white font-medium hover:bg-charcoal-light transition-colors duration-300 shadow-warm disabled:opacity-50">
                        Access Gallery
                    </button>
                </form>
                <div className="mt-8 flex justify-center">
                    <Turnstile
                        siteKey={import.meta.env.VITE_TURNSTILE_SITE_KEY}
                        onSuccess={(token) => setTurnstileToken(token)}
                        options={{ theme: 'light' }}
                    />
                </div>
            </div>
        )
    }

    // State 2: Error loading or bad code
    if (error) {
        return (
            <div className="max-w-md mx-auto px-6 py-24 text-center animate-fade-in">
                <svg className="w-16 h-16 mx-auto text-red-400 mb-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <h1 className="font-serif text-2xl font-semibold text-charcoal mb-3">Link Invalid</h1>
                <p className="text-warm-gray mb-8">{error}</p>
                <button
                    onClick={() => navigate('/sharedalbum')}
                    className="inline-flex items-center gap-2 px-6 py-2.5 bg-white border border-warm-border rounded-xl text-charcoal font-medium hover:bg-cream-dark transition-colors"
                >
                    Try another code
                </button>
            </div>
        )
    }

    // State 3: Loading album
    if (loading || !album) {
        return (
            <div className="flex flex-col flex-1 items-center justify-center py-32 animate-fade-in">
                <div className="w-12 h-12 border-4 border-amber border-t-transparent rounded-full animate-spin"></div>
                <p className="mt-4 text-warm-gray font-medium">Accessing gallery...</p>
            </div>
        )
    }

    // State 4: Album Loaded — Render Grid
    return (
        <div className="max-w-7xl mx-auto px-6 py-12">
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
                            className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-medium transition-all duration-300 shadow-warm-sm border border-transparent disabled:opacity-70 disabled:cursor-not-allowed bg-amber text-white hover:bg-amber-dark shrink-0 mb-1 cursor-pointer"
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
                    {images.map((img, index) => {
                        const isLegacyOrDemo = typeof img === 'string' || !img.thumbKey
                        const thumbUrl = isLegacyOrDemo
                            ? (img.url || img)
                            : `https://${import.meta.env.VITE_CLOUDFRONT_DOMAIN}/${img.thumbKey}`

                        return (
                            <div
                                key={img.key || img.rawKey || index}
                                className="group cursor-pointer rounded-xl overflow-hidden shadow-warm-sm hover:shadow-warm-lg transition-all duration-500 aspect-[4/3]"
                                onClick={() => setLightboxIndex(index)}
                            >
                                <ProgressiveImage
                                    src={thumbUrl}
                                    blurhash={img.blurhash}
                                    alt={`Photo ${index + 1} from ${album.title}`}
                                    className="w-full h-full group-hover:scale-[1.02] transition-transform duration-700 ease-out"
                                />
                            </div>
                        )
                    })}
                </div>

                {/* Empty state */}
                {images.length === 0 && (
                    <div className="text-center py-20 text-warm-gray">
                        <p className="text-lg">No photos in this album yet.</p>
                    </div>
                )}
            </div>

            {/* Lightbox Overlay */}
            {lightboxIndex !== null && images[lightboxIndex] && (
                <div
                    className="fixed inset-0 z-[100] bg-charcoal/95 backdrop-blur-sm flex flex-col items-center justify-center p-4 pt-16 pb-8 animate-fade-in"
                    onClick={() => setLightboxIndex(null)}
                >
                    <button onClick={() => setLightboxIndex(null)} className="absolute top-6 right-6 text-white/80 hover:text-white transition-colors cursor-pointer z-10">
                        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>

                    {/* Navigation Arrows */}
                    <button
                        onClick={(e) => { e.stopPropagation(); goPrev() }}
                        className="absolute left-4 md:left-8 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/10 hover:bg-white/25 backdrop-blur-sm text-white flex items-center justify-center transition-all cursor-pointer z-10"
                    >
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                    </button>
                    <button
                        onClick={(e) => { e.stopPropagation(); goNext() }}
                        className="absolute right-4 md:right-8 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/10 hover:bg-white/25 backdrop-blur-sm text-white flex items-center justify-center transition-all cursor-pointer z-10"
                    >
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                    </button>

                    {/* Image Wrapper */}
                    <div className="flex-1 w-full min-h-0 flex flex-col items-center justify-center relative z-0" onClick={(e) => e.stopPropagation()}>
                        {(() => {
                            const activeImg = images[lightboxIndex]
                            const isLegacyOrDemo = typeof activeImg === 'string' || !activeImg.thumbKey
                            const activeRawUrl = isLegacyOrDemo ? (activeImg.url || activeImg) : `https://${import.meta.env.VITE_CLOUDFRONT_DOMAIN}/${activeImg.rawKey}`
                            return (
                                <>
                                    <div className="flex-1 min-h-0 flex items-center justify-center w-full">
                                        <img
                                            src={activeRawUrl}
                                            alt="Full size preview"
                                            className="max-w-full max-h-full object-contain rounded-lg shadow-warm-xl animate-scale-in"
                                        />
                                    </div>

                                    {/* EXIF Data Overlay */}
                                    {!isLegacyOrDemo && activeImg.exif && (
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

                    {/* Actions */}
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
