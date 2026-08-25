import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import PhotoLightbox from '../components/PhotoLightbox'
import ProgressiveImage from '../components/ProgressiveImage'
import { requestAlbumMediaDownload } from '../utils/api'
import { fetchExploreColors, fetchExploreLenses, fetchExplorePhotos } from '../utils/exploreApi'
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
const COLOR_BY_ID = new Map(COLOR_OPTIONS.map(option => [option.id, option]))
const CARD_SIZES = '(max-width: 720px) calc(100vw - 3rem), (max-width: 1080px) 50vw, (min-width: 1440px) 420px, 360px'

function ExploreHeader({ title = 'Explore', detail = 'Choose a different way into the photography archive.' }) {
    return (
        <header className="explore-header max-w-7xl mx-auto px-6 pt-14 pb-8 md:pt-20 md:pb-12">
            <div className="linen-section-heading editorial-motion-frame">
                <span>Visual index</span>
                <h1 className="font-serif text-4xl md:text-6xl font-normal text-charcoal">{title}</h1>
                <p>{detail}</p>
            </div>
        </header>
    )
}

function ExploreLanding() {
    return (
        <div className="explore-page animate-fade-in pt-[74px]">
            <ExploreHeader />
            <section className="explore-modules max-w-7xl mx-auto px-6 pb-20 md:pb-28" aria-label="Explore modules">
                <Link to="/explore/colors" className="explore-module-card editorial-motion-media">
                    <span className="explore-module-number">01</span>
                    <div className="explore-module-colors" aria-hidden="true">
                        {COLOR_OPTIONS.slice(0, 8).map(option => <i key={option.id} style={{ backgroundColor: option.color }} />)}
                    </div>
                    <div>
                        <h2>Color Explorer</h2>
                        <p>Browse photographs by the colors that meaningfully shape each frame.</p>
                    </div>
                    <span className="explore-module-arrow" aria-hidden="true">→</span>
                </Link>
                <Link to="/explore/lenses" className="explore-module-card editorial-motion-media">
                    <span className="explore-module-number">02</span>
                    <div className="explore-module-lens" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                    </div>
                    <div>
                        <h2>Lens Explorer</h2>
                        <p>See how each lens renders the archive, from wide landscapes to distant wildlife.</p>
                    </div>
                    <span className="explore-module-arrow" aria-hidden="true">→</span>
                </Link>
            </section>
        </div>
    )
}

function ExploreCard({ item, index, mode, onOpen }) {
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
            />
            <span className="explore-photo-copy">
                <span>
                    <strong>{item.albumTitle}</strong>
                    <small>{item.albumCategory}</small>
                </span>
                {mode === 'color' && item.palette?.length > 0 && (
                    <span className="explore-palette" aria-label="Extracted color palette">
                        {item.palette.map((color, paletteIndex) => (
                            <i key={`${color}-${paletteIndex}`} style={{ backgroundColor: color }} />
                        ))}
                    </span>
                )}
            </span>
        </button>
    )
}

function ExploreModule({ mode }) {
    const [searchParams, setSearchParams] = useSearchParams()
    const [facets, setFacets] = useState([])
    const [facetLoading, setFacetLoading] = useState(true)
    const [facetError, setFacetError] = useState('')
    const [pageState, setPageState] = useState({ key: '', items: [], nextCursor: null, error: '' })
    const [loadingMore, setLoadingMore] = useState(false)
    const [lightboxIndex, setLightboxIndex] = useState(null)
    const isColor = mode === 'color'

    useEffect(() => {
        const controller = new AbortController()
        setFacetLoading(true)
        setFacetError('')
        const request = isColor ? fetchExploreColors : fetchExploreLenses
        request({ signal: controller.signal })
            .then(({ items }) => setFacets(items))
            .catch(error => {
                if (error?.name !== 'AbortError') setFacetError(error?.message || 'Explore options could not be loaded.')
            })
            .finally(() => {
                if (!controller.signal.aborted) setFacetLoading(false)
            })
        return () => controller.abort()
    }, [isColor])

    const requestedValue = isColor ? searchParams.get('color') : searchParams.get('lens')
    const activeFacet = useMemo(() => {
        const key = isColor ? 'id' : 'name'
        return facets.find(option => option[key] === requestedValue) || facets[0] || null
    }, [facets, isColor, requestedValue])
    const value = activeFacet ? (isColor ? activeFacet.id : activeFacet.name) : ''
    const requestKey = value ? `${mode}:${value}` : ''
    const hasCurrentPage = Boolean(requestKey && pageState.key === requestKey)
    const items = hasCurrentPage ? pageState.items : []
    const nextCursor = hasCurrentPage ? pageState.nextCursor : null
    const resultError = hasCurrentPage ? pageState.error : ''
    const loading = Boolean(requestKey && !hasCurrentPage)

    useEffect(() => {
        setLightboxIndex(null)
        if (!value) return undefined
        const controller = new AbortController()
        fetchExplorePhotos({ mode, value, limit: PAGE_SIZE }, { signal: controller.signal })
            .then(page => setPageState({ key: requestKey, items: page.items, nextCursor: page.nextCursor, error: '' }))
            .catch(error => {
                if (error?.name !== 'AbortError') {
                    setPageState({
                        key: requestKey,
                        items: [],
                        nextCursor: null,
                        error: error?.message || 'Explore photos could not be loaded.',
                    })
                }
            })
        return () => controller.abort()
    }, [mode, requestKey, value])

    const chooseFacet = nextValue => setSearchParams(isColor ? { color: nextValue } : { lens: nextValue })
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
        } catch (error) {
            setPageState(current => current.key === requestKey
                ? { ...current, error: error?.message || 'More photos could not be loaded.' }
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
        } catch (error) {
            console.error('Explore photo download failed:', error)
            alert('The photo could not be downloaded. Please try again.')
        }
    }, [])

    const activeLabel = isColor ? COLOR_BY_ID.get(value)?.label : value
    const availableColors = isColor
        ? facets.map(option => ({ ...COLOR_BY_ID.get(option.id), ...option })).filter(option => option.id && option.label)
        : []

    return (
        <div className="explore-page animate-fade-in pt-[74px]">
            <ExploreHeader
                title={isColor ? 'Color Explorer' : 'Lens Explorer'}
                detail={isColor
                    ? 'Colors are sampled from each photograph and included only when they occupy a meaningful part of the frame.'
                    : 'Browse photographs by the lens used to make them.'}
            />
            <section className="explore-content max-w-7xl mx-auto px-6 pb-20 md:pb-28">
                <Link to="/explore" className="explore-back">← All Explore modules</Link>
                <section className="explore-filter-panel" aria-labelledby="explore-filter-title">
                    <div>
                        <span>{isColor ? '01' : '02'}</span>
                        <h2 id="explore-filter-title">Choose a {isColor ? 'color' : 'lens'}</h2>
                    </div>
                    {facetLoading && <p className="explore-facet-status" role="status">Reading the visual index…</p>}
                    {facetError && <p className="explore-error explore-facet-error" role="alert">{facetError}</p>}
                    {!facetLoading && !facetError && isColor && (
                        <div className="explore-color-options">
                            {availableColors.map(option => (
                                <button
                                    type="button"
                                    key={option.id}
                                    className={value === option.id ? 'is-active' : ''}
                                    aria-pressed={value === option.id}
                                    onClick={() => chooseFacet(option.id)}
                                >
                                    <i style={{ backgroundColor: option.color }} />
                                    <span>{option.label}</span>
                                    <small>{option.photos}</small>
                                </button>
                            ))}
                        </div>
                    )}
                    {!facetLoading && !facetError && !isColor && (
                        <div className="explore-lens-options">
                            {facets.map(option => (
                                <button
                                    type="button"
                                    key={option.name}
                                    className={value === option.name ? 'is-active' : ''}
                                    aria-pressed={value === option.name}
                                    onClick={() => chooseFacet(option.name)}
                                >
                                    <span>{option.name}</span>
                                    <small>{option.photos}</small>
                                </button>
                            ))}
                        </div>
                    )}
                </section>

                {activeFacet && (
                    <div className="explore-results-heading" aria-live="polite">
                        <p><strong>{activeFacet.photos}</strong> {activeFacet.photos === 1 ? 'photograph' : 'photographs'}</p>
                        <span>{activeLabel}</span>
                    </div>
                )}
                {loading && <div className="explore-loading" role="status">Finding photographs…</div>}
                {resultError && <p className="explore-error" role="alert">{resultError}</p>}
                {!facetLoading && !facetError && !loading && !resultError && !activeFacet && (
                    <div className="explore-empty"><h2>No indexed photographs</h2><p>Try another Explore module.</p></div>
                )}
                {!loading && !resultError && activeFacet && items.length === 0 && (
                    <div className="explore-empty"><h2>No photographs found</h2><p>Choose another option and try again.</p></div>
                )}
                {items.length > 0 && (
                    <div className="explore-grid">
                        {items.map((item, index) => (
                            <ExploreCard
                                key={`${item.albumId}:${item.mediaId}`}
                                item={item}
                                index={index}
                                mode={mode}
                                onOpen={setLightboxIndex}
                            />
                        ))}
                    </div>
                )}
                {nextCursor && (
                    <button type="button" className="explore-load-more" onClick={loadMore} disabled={loadingMore}>
                        {loadingMore ? 'Loading…' : 'Show another random set'}
                    </button>
                )}
            </section>

            {lightboxIndex !== null && items[lightboxIndex] && (
                <PhotoLightbox
                    images={items}
                    index={lightboxIndex}
                    ariaLabel={`Photographs in ${isColor ? 'Color' : 'Lens'} Explorer`}
                    onClose={() => setLightboxIndex(null)}
                    onNext={() => setLightboxIndex(current => (current + 1) % items.length)}
                    onPrevious={() => setLightboxIndex(current => (current - 1 + items.length) % items.length)}
                    onDownload={handleDownload}
                />
            )}
        </div>
    )
}

export default function Explore() {
    const { pathname } = useLocation()
    if (pathname === '/explore/colors') return <ExploreModule mode="color" />
    if (pathname === '/explore/lenses') return <ExploreModule mode="lens" />
    return <ExploreLanding />
}
