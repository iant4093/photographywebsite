import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import PhotoLightbox from '../components/PhotoLightbox'
import ProgressiveImage from '../components/ProgressiveImage'
import { requestAlbumMediaDownload } from '../utils/api'
import { fetchExploreLenses, fetchExplorePhotos } from '../utils/exploreApi'
import { trackPhotoDownload } from '../utils/analytics'
import {
    mediaFileName,
    mediaId,
    mediaPreviewSrcSet,
    resolveMediaDownloadUrl,
    startBrowserDownload,
} from '../utils/mediaUrls'
import './Explore.css'

const PAGE_SIZE = 24
const COLOR_OPTIONS = Object.freeze([
    { id: 'blue', label: 'Blue', color: '#426f9c' },
    { id: 'cyan', label: 'Aqua', color: '#5d9fa2' },
    { id: 'green', label: 'Green', color: '#657b58' },
    { id: 'yellow', label: 'Yellow', color: '#c8a34f' },
    { id: 'orange', label: 'Warm orange', color: '#b56e3d' },
    { id: 'red', label: 'Red', color: '#9a4d45' },
    { id: 'pink', label: 'Pink', color: '#a8707c' },
    { id: 'purple', label: 'Purple', color: '#746589' },
    { id: 'monochrome', label: 'Monochrome', color: '#77716a' },
])
const COLOR_IDS = new Set(COLOR_OPTIONS.map(option => option.id))
const CARD_SIZES = '(max-width: 720px) calc(100vw - 3rem), (max-width: 1080px) 50vw, (min-width: 1440px) 420px, 360px'

function safeAspectRatio(item) {
    const width = Number(item?.width)
    const height = Number(item?.height)
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return '4 / 3'
    const ratio = Math.max(0.72, Math.min(width / height, 1.8))
    return String(ratio)
}

function ExploreCard({ item, index, onOpen }) {
    return (
        <button
            type="button"
            className="explore-photo-card editorial-motion-media"
            onClick={() => onOpen(index)}
            aria-label={`View photo from ${item.albumTitle}`}
        >
            <ProgressiveImage
                src={item.thumbnailUrl}
                srcSet={mediaPreviewSrcSet(item)}
                sizes={CARD_SIZES}
                alt=""
                width={item.width || 4}
                height={item.height || 3}
                className="explore-photo-image"
                style={{ aspectRatio: safeAspectRatio(item) }}
            />
            <span className="explore-photo-copy">
                <span>
                    <strong>{item.albumTitle}</strong>
                    <small>{item.albumCategory}</small>
                </span>
                <span className="explore-palette" aria-label="Extracted color palette">
                    {(item.palette || []).map((color, paletteIndex) => (
                        <i key={`${color}-${paletteIndex}`} style={{ backgroundColor: color }} />
                    ))}
                </span>
            </span>
        </button>
    )
}

export default function Explore() {
    const [searchParams, setSearchParams] = useSearchParams()
    const requestedMode = searchParams.get('mode')
    const mode = requestedMode === 'lens' ? 'lens' : 'color'
    const requestedColor = searchParams.get('color')
    const color = COLOR_IDS.has(requestedColor) ? requestedColor : 'blue'
    const requestedLens = searchParams.get('lens') || ''
    const [lenses, setLenses] = useState([])
    const [lensLoading, setLensLoading] = useState(true)
    const [lensError, setLensError] = useState('')
    const [pageState, setPageState] = useState({ key: '', items: [], nextCursor: null, error: '' })
    const [loadingMore, setLoadingMore] = useState(false)
    const [lightboxIndex, setLightboxIndex] = useState(null)

    useEffect(() => {
        const controller = new AbortController()
        fetchExploreLenses({ signal: controller.signal })
            .then(({ items: options }) => setLenses(options))
            .catch(error => {
                if (error?.name !== 'AbortError') setLensError(error?.message || 'Lens options could not be loaded.')
            })
            .finally(() => {
                if (!controller.signal.aborted) setLensLoading(false)
            })
        return () => controller.abort()
    }, [])

    const activeLens = useMemo(() => {
        if (requestedLens && lenses.some(option => option.name === requestedLens)) return requestedLens
        return lenses[0]?.name || ''
    }, [lenses, requestedLens])
    const value = mode === 'color' ? color : activeLens
    const requestKey = value ? `${mode}:${value}` : ''
    const hasCurrentPage = Boolean(requestKey && pageState.key === requestKey)
    const items = hasCurrentPage ? pageState.items : []
    const nextCursor = hasCurrentPage ? pageState.nextCursor : null
    const error = hasCurrentPage ? pageState.error : (mode === 'lens' ? lensError : '')
    const loading = Boolean(requestKey && !hasCurrentPage) || (mode === 'lens' && lensLoading)

    useEffect(() => {
        if (!value) return undefined
        const controller = new AbortController()
        fetchExplorePhotos({ mode, value, limit: PAGE_SIZE }, { signal: controller.signal })
            .then(page => {
                setPageState({ key: `${mode}:${value}`, items: page.items, nextCursor: page.nextCursor, error: '' })
            })
            .catch(requestError => {
                if (requestError?.name !== 'AbortError') {
                    setPageState({
                        key: `${mode}:${value}`,
                        items: [],
                        nextCursor: null,
                        error: requestError?.message || 'Explore photos could not be loaded.',
                    })
                }
            })
        return () => controller.abort()
    }, [mode, value])

    const updateMode = nextMode => {
        const next = new URLSearchParams()
        if (nextMode === 'lens') {
            next.set('mode', 'lens')
            if (activeLens) next.set('lens', activeLens)
        } else if (color !== 'blue') {
            next.set('color', color)
        }
        setSearchParams(next)
    }
    const updateColor = nextColor => {
        const next = new URLSearchParams()
        if (nextColor !== 'blue') next.set('color', nextColor)
        setSearchParams(next)
    }
    const updateLens = nextLens => setSearchParams({ mode: 'lens', lens: nextLens })

    const loadMore = useCallback(async () => {
        if (!nextCursor || loadingMore || !value) return
        setLoadingMore(true)
        try {
            const page = await fetchExplorePhotos({ mode, value, limit: PAGE_SIZE, cursor: nextCursor })
            setPageState(current => {
                if (current.key !== requestKey) return current
                const known = new Set(current.items.map(item => `${item.albumId}:${item.mediaId}`))
                return {
                    ...current,
                    items: current.items.concat(page.items.filter(item => !known.has(`${item.albumId}:${item.mediaId}`))),
                    nextCursor: page.nextCursor,
                    error: '',
                }
            })
        } catch (requestError) {
            setPageState(current => current.key === requestKey
                ? { ...current, error: requestError?.message || 'More photos could not be loaded.' }
                : current)
        } finally {
            setLoadingMore(false)
        }
    }, [loadingMore, mode, nextCursor, requestKey, value])

    const handleDownload = useCallback(async (event, image) => {
        event.stopPropagation()
        try {
            const downloadUrl = await resolveMediaDownloadUrl(
                () => requestAlbumMediaDownload(image.albumId, mediaId(image)),
                image,
            )
            startBrowserDownload(downloadUrl, mediaFileName(image, 'photo.jpg'))
            trackPhotoDownload(image.albumId)
        } catch (downloadError) {
            console.error('Explore photo download failed:', downloadError)
            alert('The photo could not be downloaded. Please try again.')
        }
    }, [])

    return (
        <div className="explore-page animate-fade-in pt-[74px]">
            <header className="explore-header max-w-7xl mx-auto px-6 pt-14 pb-8 md:pt-20 md:pb-12">
                <div className="linen-section-heading editorial-motion-frame">
                    <span>Visual index</span>
                    <h1 className="font-serif text-4xl md:text-6xl font-normal text-charcoal">Explore</h1>
                    <p>Move through the archive by the colors and lenses that shaped each photograph.</p>
                </div>
            </header>

            <section className="explore-content max-w-7xl mx-auto px-6 pb-20 md:pb-28">
                <div className="explore-mode-tabs" role="tablist" aria-label="Explore photographs">
                    <button type="button" role="tab" aria-selected={mode === 'color'} onClick={() => updateMode('color')}>Color Explorer</button>
                    <button type="button" role="tab" aria-selected={mode === 'lens'} onClick={() => updateMode('lens')}>Lens Explorer</button>
                </div>

                {mode === 'color' ? (
                    <section className="explore-filter-panel" aria-labelledby="color-explorer-title">
                        <div>
                            <span>01</span>
                            <h2 id="color-explorer-title">Choose a color</h2>
                        </div>
                        <div className="explore-color-options">
                            {COLOR_OPTIONS.map(option => (
                                <button
                                    type="button"
                                    key={option.id}
                                    className={color === option.id ? 'is-active' : ''}
                                    aria-pressed={color === option.id}
                                    onClick={() => updateColor(option.id)}
                                >
                                    <i style={{ backgroundColor: option.color }} />
                                    <span>{option.label}</span>
                                </button>
                            ))}
                        </div>
                    </section>
                ) : (
                    <section className="explore-filter-panel" aria-labelledby="lens-explorer-title">
                        <div>
                            <span>02</span>
                            <h2 id="lens-explorer-title">Choose a lens</h2>
                        </div>
                        <div className="explore-lens-options">
                            {lensLoading && <p role="status">Reading the lens archive…</p>}
                            {!lensLoading && lenses.map(option => (
                                <button
                                    type="button"
                                    key={option.name}
                                    className={activeLens === option.name ? 'is-active' : ''}
                                    aria-pressed={activeLens === option.name}
                                    onClick={() => updateLens(option.name)}
                                >
                                    <span>{option.name}</span>
                                    <small>{option.photos}</small>
                                </button>
                            ))}
                        </div>
                    </section>
                )}

                <div className="explore-results-heading" aria-live="polite">
                    <p><strong>{items.length}</strong> {items.length === 1 ? 'photograph' : 'photographs'}</p>
                    <span>{mode === 'color' ? COLOR_OPTIONS.find(option => option.id === color)?.label : activeLens}</span>
                </div>

                {loading && <div className="explore-loading" role="status">Finding photographs…</div>}
                {error && <p className="explore-error" role="alert">{error}</p>}
                {!loading && !error && items.length === 0 && (
                    <div className="explore-empty">
                        <h2>No matches yet</h2>
                        <p>This part of the visual index is still being prepared.</p>
                    </div>
                )}
                {items.length > 0 && (
                    <div className="explore-grid">
                        {items.map((item, index) => (
                            <ExploreCard key={`${item.albumId}:${item.mediaId}`} item={item} index={index} onOpen={setLightboxIndex} />
                        ))}
                    </div>
                )}
                {nextCursor && (
                    <button type="button" className="explore-load-more" onClick={loadMore} disabled={loadingMore}>
                        {loadingMore ? 'Loading…' : 'Load more photographs'}
                    </button>
                )}
            </section>

            {lightboxIndex !== null && (
                <PhotoLightbox
                    images={items}
                    index={lightboxIndex}
                    ariaLabel="Photographs in Explore"
                    onClose={() => setLightboxIndex(null)}
                    onNext={() => setLightboxIndex(current => (current + 1) % items.length)}
                    onPrevious={() => setLightboxIndex(current => (current - 1 + items.length) % items.length)}
                    onDownload={handleDownload}
                />
            )}
        </div>
    )
}
