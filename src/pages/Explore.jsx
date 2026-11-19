import { rememberLightboxTrigger } from '../utils/lightboxOrigin'
import useNavigationState from '../hooks/useNavigationState'
import { lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import PhotoLightbox from '../components/PhotoLightbox'
import ProgressiveImage from '../components/ProgressiveImage'
import { requestAlbumMediaDownload } from '../utils/api'
import {
    createExploreSeed,
    fetchExploreColors,
    fetchExploreExposures,
    fetchExploreLenses,
    fetchExplorePhotos,
    fetchExploreSample,
    fetchExploreSeasons,
    fetchExploreTimes,
    prefetchExploreModule,
} from '../utils/exploreApi'
import {
    readExploreBrowseState,
    writeExploreBrowseState,
} from '../utils/exploreState'
import { buildSettingsDeck, buildSettingsRoundForImage, EXPOSURE_GROUPS, SETTINGS_PROMPTS } from '../utils/exposure'
import { trackPhotoDownload } from '../utils/analytics'
import {
    mediaFileName,
    mediaId,
    mediaPreviewSrcSet,
    mediaThumbnailUrl,
    resolveMediaDownloadUrl,
    startBrowserDownload,
} from '../utils/mediaUrls'
import './Explore.css'
import { shareUrlForAlbumPhoto } from '../utils/share'
import { saveVerticalScroll } from '../utils/scroll'
import { EXPLORE_MODULES } from '../utils/exploreModules'
import usePhotoOriginalRefresh from '../hooks/usePhotoOriginalRefresh'
import useMediaQuery from '../hooks/useMediaQuery'
import { handlePointerTilt } from '../utils/pointerTilt'
import { createImageSnapshot } from '../utils/imageSnapshot'

const PAGE_SIZE = 24
const ImmersiveGallery = lazy(() => import('./ImmersiveGallery'))
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
const TIME_OPTIONS = Object.freeze([
    { id: 'dawn', label: 'Dawn', detail: '5–8 AM' },
    { id: 'morning', label: 'Morning', detail: '8 AM–12 PM' },
    { id: 'afternoon', label: 'Afternoon', detail: '12–5 PM' },
    { id: 'evening', label: 'Evening', detail: '5–9 PM' },
    { id: 'night', label: 'Night', detail: '9 PM–5 AM' },
])
const SEASON_OPTIONS = Object.freeze([
    { id: 'winter', label: 'Winter', detail: 'December–February' },
    { id: 'spring', label: 'Spring', detail: 'March–May' },
    { id: 'summer', label: 'Summer', detail: 'June–August' },
    { id: 'autumn', label: 'Autumn', detail: 'September–November' },
])
const TEMPORAL_CONFIG = Object.freeze({
    time: {
        title: 'Time of Day Explorer',
        detail: 'Browse photographs by the camera-local hour recorded at capture. Undated photographs are left out rather than guessed.',
        prompt: 'time of day',
        queryParam: 'period',
        options: TIME_OPTIONS,
        fetchOptions: fetchExploreTimes,
    },
    season: {
        title: 'Season Explorer',
        detail: 'Move through the archive by Northern Hemisphere meteorological season, using each photograph’s recorded capture date.',
        prompt: 'season',
        queryParam: 'season',
        options: SEASON_OPTIONS,
        fetchOptions: fetchExploreSeasons,
    },
})
const CARD_SIZES = '(max-width: 720px) calc(100vw - 3rem), (max-width: 1080px) 50vw, (min-width: 2200px) calc((90vw - 3rem) / 5), (min-width: 1850px) calc((90vw - 3rem) / 4), (min-width: 1440px) 420px, 360px'

function exposureSelection(value) {
    const [groupId, optionId] = String(value || '').split(':', 2)
    const group = EXPOSURE_GROUPS.find(candidate => candidate.id === groupId)
    if (!group?.options.some(option => option.id === optionId)) return null
    return { groupId, optionId }
}

function ExploreHeader({ title = 'Explore', detail = 'Choose a different way into the photography archive.' }) {
    return (
        <header className="explore-header max-w-7xl mx-auto px-6 pt-14 pb-8 md:pt-20 md:pb-12">
            <div className={`linen-section-heading${title === 'Explore' ? ' editorial-motion-frame' : ''}`}
                data-scroll-title-static={title === 'Explore' ? undefined : ''}>
                <span>Visual index</span>
                <h1 className="font-serif text-4xl md:text-6xl font-normal text-charcoal">{title}</h1>
                <p>{detail}</p>
            </div>
        </header>
    )
}

// Each module's card illustration, keyed by its id in EXPLORE_MODULES.
const MODULE_ART = {
    immersive: (
        <div className="explore-module-museum" aria-hidden="true">
            <span className="explore-module-museum-ceiling" />
            <i /><i /><i /><i /><i /><i />
            <strong>ENTER GALLERY</strong>
        </div>
    ),
    color: (
        <div className="explore-module-colors" aria-hidden="true">
            {COLOR_OPTIONS.slice(0, 8).map(option => <i key={option.id} style={{ backgroundColor: option.color }} />)}
        </div>
    ),
    lens: (
        <div className="explore-module-lens" aria-hidden="true">
            <i />
            <i />
            <i />
        </div>
    ),
    exposure: <div className="explore-module-exposure" aria-hidden="true"><i /><i /><i /><i /></div>,
    time: <div className="explore-module-time" aria-hidden="true"><i /><i /><i /><i /><i /></div>,
    season: <div className="explore-module-season" aria-hidden="true"><i /><i /><i /><i /></div>,
    guess: (
        <div className="explore-module-game" aria-hidden="true">
            <span>?</span>
            <i>1/500</i><i>f/2.8</i><i>ISO 400</i>
        </div>
    ),
}

function ExploreLanding() {
    const warmModule = useCallback((mode) => {
        prefetchExploreModule(mode).catch(() => {})
    }, [])

    return (
        <div className="explore-page animate-fade-in pt-[74px]">
            <ExploreHeader />
            <section className="explore-modules max-w-7xl mx-auto px-6 pb-20 md:pb-28" aria-label="Explore modules">
                {EXPLORE_MODULES.map((module, index) => (
                    <Link
                        key={module.id}
                        data-route-card={module.id === 'immersive' ? undefined : 'explore'}
                        to={module.path}
                        className={`explore-module-card linen-media-frame linen-photo-frame${module.id === 'immersive' ? ' explore-module-card--immersive' : ''} editorial-motion-media`}
                        onClick={() => saveVerticalScroll('/explore')}
                        onPointerMove={handlePointerTilt}
                        onPointerLeave={handlePointerTilt}
                        onPointerEnter={module.prefetch ? () => warmModule(module.prefetch) : undefined}
                        onFocus={module.prefetch ? () => warmModule(module.prefetch) : undefined}
                    >
                        <span className="linen-photo-glow" />
                        <span className="explore-module-number">{String(index + 1).padStart(2, '0')}</span>
                        {MODULE_ART[module.id] || <div aria-hidden="true" />}
                        <div>
                            <h2>{module.title}</h2>
                            <p>{module.detail}</p>
                        </div>
                        <span className="explore-module-arrow" aria-hidden="true">→</span>
                    </Link>
                ))}
            </section>
        </div>
    )
}

function ExploreBackLink() {
    return <Link to="/explore" state={{ restoreScroll: '/explore' }} className="explore-back">← All Explore modules</Link>
}

function ExploreShuffleButton({ label, loading, disabled = false, onClick }) {
    return (
        <button
            type="button"
            className="explore-reshuffle"
            onClick={onClick}
            disabled={loading || disabled}
            aria-label={`Reshuffle ${label}`}
        >
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 4h3l10 16h3M20 4h-3l-3.5 5.6M4 20h3l3.5-5.6" />
            </svg>
            <span>{loading ? 'Shuffling…' : 'Reshuffle'}</span>
        </button>
    )
}

function ExploreCard({ item, index, mode, onOpen }) {
    return (
        <button
            type="button"
            className="explore-photo-card linen-media-frame linen-photo-frame editorial-motion-media"
            data-camera-cursor="photo"
            data-lightbox-item={mediaId(item)}
            onClick={event => {
                rememberLightboxTrigger(event.currentTarget, 'photo', mediaId(item))
                onOpen(index)
            }}
            onPointerMove={handlePointerTilt}
            onPointerLeave={handlePointerTilt}
            aria-label={`View photo from ${item.albumTitle}`}
        >
            <span className="linen-photo-glow" />
            <ProgressiveImage
                src={item.thumbnailUrl}
                srcSet={mediaPreviewSrcSet(item)}
                sizes={CARD_SIZES}
                alt=""
                width={item.width || 4}
                height={item.height || 3}
                blurhash={item.blurhash}
                className="explore-photo-image"
                eager={index < 4}
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

function ExploreResultLayer({ items, mode, onOpen, phase, inactive, layerRef }) {
    return (
        <div ref={layerRef} className={`explore-grid explore-grid--${phase}`} data-lightbox-grid={phase === 'current' ? '' : undefined}
            inert={inactive} aria-hidden={inactive || undefined}>
            {items.map((item, index) => (
                <ExploreCard key={`${item.albumId}:${mediaId(item)}`} item={item} index={index} mode={mode} onOpen={onOpen} />
            ))}
        </div>
    )
}

function waitForExploreThumbnails(layer, commit) {
    const cards = [...layer.children]
    const viewportBottom = Math.min(window.innerHeight, layer.getBoundingClientRect().bottom)
    const visible = cards.filter(card => {
        const { top, bottom } = card.getBoundingClientRect()
        return top < viewportBottom && bottom > 0
    })
    // Prime the leading row when the filters fill the entire viewport.
    const needed = visible.length ? visible : cards.slice(0, 4)
    let settled = false
    let decoding = false
    const finish = () => {
        if (settled) return
        cancel()
        for (const image of layer.querySelectorAll('.progressive-image-ready')) image.dataset.explorePrepared = ''
        commit()
    }
    const check = () => {
        if (decoding) return
        const images = needed.map(card => card.querySelector('.progressive-image-ready'))
        if (images.some(image => !image)) return
        decoding = true
        Promise.allSettled(images.map(image => image.naturalWidth && image.decode?.())).then(finish)
    }
    const observer = new MutationObserver(check)
    const timer = setTimeout(finish, 1100)
    function cancel() {
        settled = true
        observer.disconnect()
        clearTimeout(timer)
    }
    observer.observe(layer, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    check()
    return cancel
}

function captureExplorePhotos(current, staged) {
    if (!current || staged.getBoundingClientRect().top >= window.innerHeight) return []
    const oldFrames = current.querySelectorAll('.explore-photo-image')
    return [...staged.querySelectorAll('.explore-photo-image')].flatMap((frame, index) => {
        const oldFrame = oldFrames[index]
        const oldImage = oldFrame?.querySelector('img.progressive-image-ready')
        const newImage = frame.querySelector('img.progressive-image-ready')
        if (!oldImage?.naturalWidth || !newImage?.naturalWidth || oldImage.currentSrc === newImage.currentSrc) return []
        const bounds = frame.getBoundingClientRect()
        if (!bounds.width || bounds.top >= window.innerHeight || bounds.bottom <= 0) return []
        const oldBounds = oldFrame.getBoundingClientRect()
        if (['top', 'left', 'width', 'height'].some(edge => Math.abs(oldBounds[edge] - bounds[edge]) > 2)) return []
        const snapshot = createImageSnapshot(oldImage, Math.min(768, Math.ceil(bounds.width * window.devicePixelRatio)))
        return snapshot ? [{ frame, snapshot }] : []
    })
}

function ExploreResults({ items, revision, label, total, mode, onOpen, updating, reshuffling, onShuffle,
    nextCursor, loadingMore, onLoadMore, children }) {
    const reduced = useMediaQuery('(prefers-reduced-motion: reduce)')
    const currentRef = useRef(null)
    const stagedRef = useRef(null)
    const [shown, setShown] = useState({ items, revision, label, total, nextCursor })
    const replacement = shown.revision !== revision
    const canBlend = replacement && shown.items.length > 0 && items.length > 0 && !reduced && Boolean(globalThis.Element?.prototype.animate)
    const staging = canBlend && !updating
    if ((!updating || !shown.items.length) && !canBlend && (replacement || shown.items !== items || shown.label !== label
        || shown.total !== total || shown.nextCursor !== nextCursor)) {
        setShown({ items, revision, label, total, nextCursor, photos: replacement ? undefined : shown.photos })
    }

    useLayoutEffect(() => {
        if (!staging || !stagedRef.current) return undefined
        const staged = stagedRef.current
        return waitForExploreThumbnails(staged, () => {
            const photos = captureExplorePhotos(currentRef.current, staged)
            setShown({ items, revision, label, total, nextCursor, photos })
        })
    }, [items, label, nextCursor, revision, staging, total])

    useLayoutEffect(() => {
        if (!shown.photos?.length) return undefined
        const cleanups = shown.photos.map(({ frame, snapshot }) => {
            const remove = () => {
                snapshot.remove()
                snapshot.width = snapshot.height = 0
            }
            if (reduced || !frame.isConnected || !snapshot.width) { remove(); return remove }
            snapshot.className = 'explore-photo-dissolve'
            snapshot.setAttribute('aria-hidden', 'true')
            frame.append(snapshot)
            const animation = snapshot.animate([{ opacity: 1 }, { opacity: 0 }],
                { duration: 230, easing: 'ease-out', fill: 'both' })
            animation.finished.then(remove, remove)
            return () => { animation.cancel(); remove() }
        })
        return () => cleanups.forEach(cleanup => cleanup())
    }, [reduced, shown.photos])

    const busy = updating || replacement
    return (
        <>
            {shown.label && <div className="explore-results-heading" aria-live="polite">
                <div className="explore-result-label">
                    <p><strong>{shown.total}</strong> {shown.total === 1 ? 'photograph' : 'photographs'}</p>
                    <span title={shown.label}>{shown.label}</span>
                </div>
                <ExploreShuffleButton label={`${shown.label.replace(' · ', ' ')} photographs`} loading={reshuffling}
                    disabled={busy || loadingMore} onClick={onShuffle} />
            </div>}
            <span className="sr-only" role="status">{busy ? 'Updating photographs…' : ''}</span>
            {children}
            {shown.items.length > 0 && <div className="explore-results-stage" aria-busy={busy}>
                <ExploreResultLayer key={shown.revision} items={shown.items} mode={mode} onOpen={onOpen} layerRef={currentRef}
                    phase="current" inactive={busy} />
                {staging && <ExploreResultLayer key={revision} items={items} mode={mode} onOpen={onOpen}
                    layerRef={stagedRef} phase="staged" inactive />}
            </div>}
            {shown.nextCursor && <button type="button" className="explore-load-more" onClick={onLoadMore} disabled={busy || loadingMore}>
                {loadingMore ? 'Loading…' : 'Show more'}
            </button>}
        </>
    )
}

function ExploreModule({ mode }) {
    const [searchParams, setSearchParams] = useSearchParams()
    const [facets, setFacets] = useState([])
    const [facetLoading, setFacetLoading] = useState(true)
    const [facetError, setFacetError] = useState('')
    const [pageState, setPageState] = useNavigationState('explore-page', { key: '', items: [], nextCursor: null, error: '' })
    const [loadingMore, setLoadingMore] = useState(false)
    const [reshuffling, setReshuffling] = useState(false)
    const [lightboxIndex, setLightboxIndex] = useState(null)
    const currentRequestKeyRef = useRef('')
    const isColor = mode === 'color'

    useEffect(() => {
        const controller = new AbortController()
        setFacetLoading(true)
        setFacetError('')
        const request = isColor ? fetchExploreColors : fetchExploreLenses
        request({ signal: controller.signal })
            .then(({ items, initialPage }) => {
                setFacets(items)
                if (initialPage?.value) {
                    setPageState(current => current.key ? current : {
                        key: `${mode}:${initialPage.value}`,
                        items: initialPage.items,
                        nextCursor: initialPage.nextCursor,
                        error: '',
                    })
                }
            })
            .catch(error => {
                if (error?.name !== 'AbortError') setFacetError(error?.message || 'Explore options could not be loaded.')
            })
            .finally(() => {
                if (!controller.signal.aborted) setFacetLoading(false)
            })
        return () => controller.abort()
    }, [isColor, mode, setPageState])

    const requestedValue = isColor ? searchParams.get('color') : searchParams.get('lens')
    const activeFacet = useMemo(() => {
        const key = isColor ? 'id' : 'name'
        return facets.find(option => option[key] === requestedValue) || facets[0] || null
    }, [facets, isColor, requestedValue])
    const value = activeFacet ? (isColor ? activeFacet.id : activeFacet.name) : ''
    const requestKey = value ? `${mode}:${value}` : ''
    currentRequestKeyRef.current = requestKey
    const hasCurrentPage = Boolean(requestKey && pageState.key === requestKey)
    const items = hasCurrentPage ? pageState.items : []
    const { images: lightboxPhotos, refreshOriginal } = usePhotoOriginalRefresh(items)
    const nextCursor = hasCurrentPage ? pageState.nextCursor : null
    const resultError = hasCurrentPage ? pageState.error : ''
    const loading = Boolean(requestKey && !hasCurrentPage)
    const displayItems = hasCurrentPage ? items : pageState.items

    useEffect(() => {
        setLightboxIndex(null)
    }, [requestKey])

    useEffect(() => {
        if (!value || hasCurrentPage) return undefined
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
    }, [hasCurrentPage, mode, requestKey, value, setPageState])

    const chooseFacet = nextValue => setSearchParams(isColor ? { color: nextValue } : { lens: nextValue })
    const loadMore = useCallback(async () => {
        if (!nextCursor || loadingMore || reshuffling || !value) return
        setLoadingMore(true)
        try {
            const page = await fetchExplorePhotos({ mode, value, limit: PAGE_SIZE, cursor: nextCursor })
            setPageState(current => {
                if (current.key !== requestKey) return current
                const known = new Set(current.items.map(item => `${item.albumId}:${mediaId(item)}`))
                return {
                    ...current,
                    items: current.items.concat(page.items.filter(item => !known.has(`${item.albumId}:${mediaId(item)}`))),
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
    }, [loadingMore, mode, nextCursor, requestKey, reshuffling, value, setPageState])

    const reshuffle = useCallback(async () => {
        if (!value || loading || loadingMore || reshuffling) return
        const targetKey = requestKey
        const seed = createExploreSeed()
        setReshuffling(true)
        setLightboxIndex(null)
        try {
            const page = await fetchExplorePhotos({
                mode,
                value,
                limit: PAGE_SIZE,
                seed,
            })
            if (currentRequestKeyRef.current !== targetKey) return
            setPageState({ key: targetKey, seed, items: page.items, nextCursor: page.nextCursor, error: '' })
        } catch (error) {
            if (currentRequestKeyRef.current === targetKey) {
                setPageState(current => ({
                    ...current,
                    error: error?.message || 'A new shuffle could not be loaded.',
                }))
            }
        } finally {
            setReshuffling(false)
        }
    }, [loading, loadingMore, mode, requestKey, reshuffling, value, setPageState])

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
                <ExploreBackLink />
                <section className="explore-filter-panel" aria-labelledby="explore-filter-title">
                    <div>
                        <span>{isColor ? '01' : '02'}</span>
                        <h2 id="explore-filter-title">Choose a {isColor ? 'color' : 'lens'}</h2>
                    </div>
                    {facetLoading && <p className="sr-only" role="status">Reading the visual index…</p>}
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

                <ExploreResults revision={JSON.stringify([pageState.key, pageState.seed])} items={displayItems}
                    mode={mode} onOpen={setLightboxIndex} updating={loading || reshuffling} label={activeFacet && activeLabel}
                    total={activeFacet?.photos} nextCursor={nextCursor} loadingMore={loadingMore} onLoadMore={loadMore}
                    reshuffling={reshuffling} onShuffle={reshuffle}>
                    {resultError && <p className="explore-error" role="alert">{resultError}</p>}
                    {!facetLoading && !facetError && !loading && !resultError && !activeFacet && (
                        <div className="explore-empty explore-results-note"><h2>No indexed photographs</h2><p>Try another Explore module.</p></div>
                    )}
                    {!loading && !resultError && activeFacet && items.length === 0 && (
                        <div className="explore-empty explore-results-note"><h2>No photographs found</h2><p>Choose another option and try again.</p></div>
                    )}
                </ExploreResults>
            </section>

            {lightboxIndex !== null && items[lightboxIndex] && (
                <PhotoLightbox
                    images={lightboxPhotos}
                    index={lightboxIndex}
                    ariaLabel={`Photographs in ${isColor ? 'Color' : 'Lens'} Explorer`}
                    onClose={() => setLightboxIndex(null)}
                    onNext={() => setLightboxIndex(current => (current + 1) % items.length)}
                    onPrevious={() => setLightboxIndex(current => (current - 1 + items.length) % items.length)}
                    onDownload={handleDownload}
                    publicPrint
                    onBeforeRefresh={refreshOriginal}
                    shareUrl={image => shareUrlForAlbumPhoto(image.albumId, mediaId(image))}
                />
            )}
        </div>
    )
}

function TemporalExplorer({ mode }) {
    const config = TEMPORAL_CONFIG[mode]
    const [searchParams, setSearchParams] = useSearchParams()
    const [facetState, setFacetState] = useState({ items: [], initialPage: null, loading: true, error: '' })
    const [pageState, setPageState] = useNavigationState('explore-page', { key: '', items: [], nextCursor: null, seed: '', error: '' })
    const [loadingMoreKey, setLoadingMoreKey] = useState('')
    const [reshufflingKey, setReshufflingKey] = useState('')
    const [lightboxIndex, setLightboxIndex] = useState(null)
    const [lightboxRequestKey, setLightboxRequestKey] = useState('')
    const currentRequestKeyRef = useRef('')
    const pageStateRef = useRef(pageState)
    const photoOperationRef = useRef({ generation: 0, controller: null })

    useEffect(() => {
        const controller = new AbortController()
        config.fetchOptions({ signal: controller.signal })
            .then(({ items, initialPage }) => {
                const counts = new Map(items.map(item => [item.id, item.photos]))
                setFacetState({
                    items: config.options.map(option => ({ ...option, photos: counts.get(option.id) || 0 })),
                    initialPage,
                    loading: false,
                    error: '',
                })
            })
            .catch(error => {
                if (error?.name !== 'AbortError') {
                    setFacetState({
                        items: [],
                        initialPage: null,
                        loading: false,
                        error: error?.message || 'The temporal index could not be loaded.',
                    })
                }
            })
        return () => controller.abort()
    }, [config])

    const requestedValue = searchParams.get(config.queryParam)
    const activeFacet = useMemo(() => (
        facetState.items.find(option => option.id === requestedValue && option.photos > 0)
        || facetState.items.find(option => option.photos > 0)
        || null
    ), [facetState.items, requestedValue])
    const value = activeFacet?.id || ''
    const requestKey = value ? `${mode}:${value}` : ''
    const hasCurrentPage = Boolean(requestKey && pageState.key === requestKey)
    const items = hasCurrentPage ? pageState.items : []
    const nextCursor = hasCurrentPage ? pageState.nextCursor : null
    const resultError = hasCurrentPage ? pageState.error : ''
    const loading = Boolean(requestKey && !hasCurrentPage)
    const displayItems = hasCurrentPage ? items : pageState.items
    const loadingMore = loadingMoreKey === requestKey
    const reshuffling = reshufflingKey === requestKey

    const cancelPhotoOperation = useCallback(() => {
        const previous = photoOperationRef.current
        previous.controller?.abort()
        photoOperationRef.current = { generation: previous.generation + 1, controller: null }
    }, [])

    const beginPhotoOperation = useCallback(() => {
        const previous = photoOperationRef.current
        previous.controller?.abort()
        const operation = {
            generation: previous.generation + 1,
            controller: new AbortController(),
        }
        photoOperationRef.current = operation
        return operation
    }, [])

    const photoOperationIsCurrent = useCallback((operation, key) => (
        photoOperationRef.current.generation === operation.generation
        && currentRequestKeyRef.current === key
    ), [])

    useEffect(() => {
        pageStateRef.current = pageState
    }, [pageState])

    useEffect(() => {
        currentRequestKeyRef.current = requestKey
    }, [requestKey])

    useEffect(() => {
        cancelPhotoOperation()
    }, [cancelPhotoOperation, requestKey])

    useEffect(() => () => cancelPhotoOperation(), [cancelPhotoOperation])

    useEffect(() => {
        if (facetState.loading || facetState.error || !activeFacet || requestedValue === activeFacet.id) return
        setSearchParams({ [config.queryParam]: activeFacet.id }, { replace: true })
    }, [activeFacet, config.queryParam, facetState.error, facetState.loading, requestedValue, setSearchParams])

    const commitPage = useCallback((key, next, scrollY = window.scrollY) => {
        pageStateRef.current = next
        setPageState(next)
        writeExploreBrowseState(key, {
            items: next.items,
            total: next.total,
            nextCursor: next.nextCursor,
            seed: next.seed,
            scrollY,
        })
    }, [setPageState])

    useEffect(() => {
        let disposed = false
        let effectOperation = null
        const loadPage = async () => {
            await Promise.resolve()
            if (disposed || !requestKey || facetState.loading || facetState.error) return
            if (pageStateRef.current.key === requestKey && pageStateRef.current.items.length) return
            const snapshot = readExploreBrowseState(requestKey)
            if (snapshot) {
                const restored = {
                    key: requestKey,
                    items: snapshot.items,
                    total: snapshot.total ?? activeFacet.photos,
                    nextCursor: snapshot.nextCursor,
                    seed: snapshot.seed,
                    error: '',
                }
                pageStateRef.current = restored
                setPageState(restored)
                if (!snapshot.stale) return
            }

            if (!snapshot && facetState.initialPage?.value === value) {
                commitPage(requestKey, {
                    key: requestKey,
                    items: facetState.initialPage.items,
                    total: activeFacet.photos,
                    nextCursor: facetState.initialPage.nextCursor,
                    seed: facetState.initialPage.seed || '',
                    error: '',
                })
                return
            }

            const seed = snapshot?.seed || createExploreSeed()
            const operation = beginPhotoOperation()
            effectOperation = operation
            try {
                const page = await fetchExplorePhotos(
                    { mode, value, limit: PAGE_SIZE, seed },
                    { signal: operation.controller.signal },
                )
                if (disposed || !photoOperationIsCurrent(operation, requestKey)) return
                const current = pageStateRef.current
                const cachedTail = current.key === requestKey ? current.items.slice(page.items.length) : []
                const known = new Set(page.items.map(item => `${item.albumId}:${mediaId(item)}`))
                const merged = page.items.concat(cachedTail.filter(item => !known.has(`${item.albumId}:${mediaId(item)}`)))
                commitPage(requestKey, {
                    key: requestKey,
                    items: merged,
                    total: activeFacet.photos,
                    nextCursor: cachedTail.length ? current.nextCursor : page.nextCursor,
                    seed: page.seed || seed,
                    error: '',
                })
            } catch (error) {
                if (error?.name === 'AbortError' || disposed || !photoOperationIsCurrent(operation, requestKey)) return
                const current = pageStateRef.current
                pageStateRef.current = current.key === requestKey
                    ? { ...current, error: error?.message || 'Photographs could not be refreshed.' }
                    : {
                        key: requestKey,
                        items: [],
                        total: activeFacet.photos,
                        nextCursor: null,
                        seed,
                        error: error?.message || 'Explore photos could not be loaded.',
                    }
                setPageState(pageStateRef.current)
            }
        }
        void loadPage()
        return () => {
            disposed = true
            if (effectOperation && photoOperationIsCurrent(effectOperation, requestKey)) {
                cancelPhotoOperation()
            }
        }
    }, [
        activeFacet, beginPhotoOperation, cancelPhotoOperation, commitPage, facetState.error,
        facetState.initialPage, facetState.loading, mode, photoOperationIsCurrent, requestKey, value, setPageState,
    ])

    const chooseFacet = nextValue => {
        if (nextValue === value) return
        cancelPhotoOperation()
        setLoadingMoreKey('')
        setReshufflingKey('')
        setSearchParams({ [config.queryParam]: nextValue })
        setLightboxIndex(null)
    }

    const openLightbox = useCallback(index => {
        setLightboxRequestKey(requestKey)
        setLightboxIndex(index)
    }, [requestKey])

    const loadMore = useCallback(async () => {
        if (!nextCursor || loadingMore || reshuffling || loading || !value) return
        const operation = beginPhotoOperation()
        setLoadingMoreKey(requestKey)
        setReshufflingKey('')
        try {
            const page = await fetchExplorePhotos(
                { mode, value, limit: PAGE_SIZE, cursor: nextCursor },
                { signal: operation.controller.signal },
            )
            if (!photoOperationIsCurrent(operation, requestKey)) return
            const current = pageStateRef.current
            const known = new Set(current.items.map(item => `${item.albumId}:${mediaId(item)}`))
            commitPage(requestKey, {
                ...current,
                items: current.items.concat(page.items.filter(item => !known.has(`${item.albumId}:${mediaId(item)}`))),
                nextCursor: page.nextCursor,
                seed: current.seed || page.seed || '',
                error: '',
            })
        } catch (error) {
            if (error?.name === 'AbortError' || !photoOperationIsCurrent(operation, requestKey)) return
            const current = pageStateRef.current
            if (current.key === requestKey) {
                pageStateRef.current = { ...current, error: error?.message || 'More photos could not be loaded.' }
                setPageState(pageStateRef.current)
            }
        } finally {
            if (photoOperationIsCurrent(operation, requestKey)) setLoadingMoreKey('')
        }
    }, [
        beginPhotoOperation, commitPage, loading, loadingMore, mode, nextCursor, setPageState,
        photoOperationIsCurrent, requestKey, reshuffling, value,
    ])

    const reshuffle = useCallback(async () => {
        if (!value || reshuffling || loadingMore || loading) return
        const seed = createExploreSeed()
        const operation = beginPhotoOperation()
        setReshufflingKey(requestKey)
        setLoadingMoreKey('')
        setLightboxIndex(null)
        try {
            const page = await fetchExplorePhotos(
                { mode, value, limit: PAGE_SIZE, seed },
                { signal: operation.controller.signal },
            )
            if (!photoOperationIsCurrent(operation, requestKey)) return
            commitPage(requestKey, {
                key: requestKey,
                items: page.items,
                total: activeFacet.photos,
                nextCursor: page.nextCursor,
                seed: page.seed || seed,
                error: '',
            })
        } catch (error) {
            if (error?.name === 'AbortError' || !photoOperationIsCurrent(operation, requestKey)) return
            const current = pageStateRef.current
            if (current.key === requestKey) {
                pageStateRef.current = { ...current, error: error?.message || 'A new shuffle could not be loaded.' }
                setPageState(pageStateRef.current)
            }
        } finally {
            if (photoOperationIsCurrent(operation, requestKey)) setReshufflingKey('')
        }
    }, [
        activeFacet, beginPhotoOperation, commitPage, loading, loadingMore, mode, setPageState,
        photoOperationIsCurrent, requestKey, reshuffling, value,
    ])

    return (
        <div className="explore-page animate-fade-in pt-[74px]">
            <ExploreHeader title={config.title} detail={config.detail} />
            <section className="explore-content max-w-7xl mx-auto px-6 pb-20 md:pb-28">
                <ExploreBackLink />
                <section className="explore-filter-panel" aria-labelledby="explore-temporal-filter-title">
                    <div>
                        <span>{mode === 'time' ? '05' : '06'}</span>
                        <h2 id="explore-temporal-filter-title">Choose a {config.prompt}</h2>
                    </div>
                    {facetState.loading && <p className="sr-only" role="status">Reading capture metadata…</p>}
                    {facetState.error && <p className="explore-error explore-facet-error" role="alert">{facetState.error}</p>}
                    {!facetState.loading && !facetState.error && (
                        <div className={`explore-temporal-options explore-temporal-options--${mode}`}>
                            {facetState.items.map(option => (
                                <button
                                    type="button"
                                    key={option.id}
                                    className={value === option.id ? 'is-active' : ''}
                                    aria-pressed={value === option.id}
                                    disabled={option.photos === 0}
                                    onClick={() => chooseFacet(option.id)}
                                >
                                    <i aria-hidden="true" />
                                    <span><strong>{option.label}</strong><small>{option.detail}</small></span>
                                    <b>{option.photos}</b>
                                </button>
                            ))}
                        </div>
                    )}
                </section>

                <ExploreResults revision={JSON.stringify([pageState.key, pageState.seed])} items={displayItems}
                    mode={mode} onOpen={openLightbox} updating={loading || reshuffling} label={activeFacet?.label}
                    total={activeFacet?.photos} nextCursor={nextCursor} loadingMore={loadingMore} onLoadMore={loadMore}
                    reshuffling={reshuffling} onShuffle={reshuffle}>
                    {resultError && <p className="explore-error" role="alert">{resultError}</p>}
                    {!facetState.loading && !facetState.error && !activeFacet && (
                        <div className="explore-empty explore-results-note"><h2>No dated photographs yet</h2><p>Photos without trustworthy capture dates are intentionally omitted.</p></div>
                    )}
                    {!loading && activeFacet && items.length === 0 && !resultError && (
                        <div className="explore-empty explore-results-note"><h2>No photographs found</h2><p>Choose another option and try again.</p></div>
                    )}
                </ExploreResults>
            </section>
            <ExploreSampleLightbox
                images={items}
                index={lightboxRequestKey === requestKey ? lightboxIndex : null}
                setIndex={setLightboxIndex}
                ariaLabel={`Photographs in ${config.title}`}
            />
        </div>
    )
}

function useExploreSample() {
    const [state, setState] = useState({ images: [], loading: true, error: '' })
    useEffect(() => {
        const controller = new AbortController()
        fetchExploreSample({ signal: controller.signal })
            .then(payload => setState({ images: payload.images || [], loading: false, error: '' }))
            .catch(error => {
                if (error?.name !== 'AbortError') {
                    setState({ images: [], loading: false, error: error?.message || 'Photographs could not be loaded.' })
                }
            })
        return () => controller.abort()
    }, [])
    return state
}

function ExploreSampleLightbox({ images, index, setIndex, ariaLabel }) {
    const { images: lightboxPhotos, refreshOriginal } = usePhotoOriginalRefresh(images)
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

    if (index === null || !images[index]) return null
    return (
        <PhotoLightbox
            images={lightboxPhotos}
            index={index}
            ariaLabel={ariaLabel}
            onClose={() => setIndex(null)}
            onNext={() => setIndex(current => (current + 1) % images.length)}
            onPrevious={() => setIndex(current => (current - 1 + images.length) % images.length)}
            onDownload={handleDownload}
            publicPrint
            onBeforeRefresh={refreshOriginal}
            shareUrl={image => shareUrlForAlbumPhoto(image.albumId, mediaId(image))}
            shareTitle="Ian Truong Photography"
        />
    )
}

function ExposureExplorer() {
    const [searchParams, setSearchParams] = useSearchParams()
    const initialSelection = useRef(
        exposureSelection(searchParams.get('setting')) || { groupId: 'aperture', optionId: 'wide' },
    )
    const [facetState, setFacetState] = useState({ groups: [], loading: true, error: '' })
    const [pageState, setPageState] = useNavigationState('explore-page', { key: '', items: [], total: 0, nextCursor: null, error: '' })
    const [loadingMore, setLoadingMore] = useState(false)
    const [reshuffling, setReshuffling] = useState(false)
    const { groupId, optionId } = exposureSelection(searchParams.get('setting')) || initialSelection.current
    const [lightboxIndex, setLightboxIndex] = useState(null)
    const currentValueRef = useRef('')
    const group = EXPOSURE_GROUPS.find(candidate => candidate.id === groupId) || EXPOSURE_GROUPS[0]
    const indexedGroup = facetState.groups.find(candidate => candidate.id === group.id)
    const value = `${group.id}:${optionId}`
    currentValueRef.current = value
    const hasCurrentPage = pageState.key === value
    const images = hasCurrentPage ? pageState.items : []
    const total = hasCurrentPage
        ? pageState.total
        : indexedGroup?.options.find(option => option.id === optionId)?.photos || 0
    const nextCursor = hasCurrentPage ? pageState.nextCursor : null
    const resultError = hasCurrentPage ? pageState.error : ''
    const loading = facetState.loading || (!facetState.error && !hasCurrentPage)
    const displayImages = hasCurrentPage ? images : pageState.items

    useEffect(() => {
        const controller = new AbortController()
        fetchExploreExposures({ signal: controller.signal })
            .then(({ items, initialPage }) => {
                setFacetState({ groups: items, loading: false, error: '' })
                if (initialPage?.value) {
                    const requestedValue = `${initialSelection.current.groupId}:${initialSelection.current.optionId}`
                    if (initialPage.value === requestedValue) {
                        setPageState(current => current.key === initialPage.value ? current : {
                            key: initialPage.value,
                            items: initialPage.items,
                            total: initialPage.total ?? initialPage.items.length,
                            nextCursor: initialPage.nextCursor,
                            error: '',
                        })
                    }
                }
            })
            .catch(error => {
                if (error?.name !== 'AbortError') {
                    setFacetState({ groups: [], loading: false, error: error?.message || 'Exposure settings could not be loaded.' })
                }
            })
        return () => controller.abort()
    }, [setPageState])

    useEffect(() => {
        if (facetState.loading || facetState.error || hasCurrentPage) return undefined
        const controller = new AbortController()
        fetchExplorePhotos({ mode: 'exposure', value, limit: PAGE_SIZE }, { signal: controller.signal })
            .then(page => setPageState({
                key: value,
                items: page.items,
                total: page.total ?? page.items.length,
                nextCursor: page.nextCursor,
                error: '',
            }))
            .catch(error => {
                if (error?.name !== 'AbortError') {
                    setPageState({ key: value, items: [], total, nextCursor: null, error: error?.message || 'Exposure photos could not be loaded.' })
                }
            })
        return () => controller.abort()
    }, [facetState.error, facetState.loading, hasCurrentPage, total, value, setPageState])

    const chooseGroup = nextGroup => {
        const next = EXPOSURE_GROUPS.find(candidate => candidate.id === nextGroup)
        if (!next) return
        const counts = facetState.groups.find(candidate => candidate.id === next.id)?.options || []
        const populated = next.options.find(option => counts.find(row => row.id === option.id)?.photos > 0)
        const nextOptionId = populated?.id || next.options[0].id
        setSearchParams({ setting: `${next.id}:${nextOptionId}` }, { replace: true })
        setLightboxIndex(null)
    }

    const chooseOption = nextOptionId => {
        setSearchParams({ setting: `${group.id}:${nextOptionId}` }, { replace: true })
        setLightboxIndex(null)
    }

    const loadMore = useCallback(async () => {
        if (!nextCursor || loadingMore || reshuffling) return
        setLoadingMore(true)
        try {
            const page = await fetchExplorePhotos({ mode: 'exposure', value, limit: PAGE_SIZE, cursor: nextCursor })
            setPageState(current => {
                if (current.key !== value) return current
                const known = new Set(current.items.map(item => `${item.albumId}:${mediaId(item)}`))
                return {
                    ...current,
                    items: current.items.concat(page.items.filter(item => !known.has(`${item.albumId}:${mediaId(item)}`))),
                    total: page.total ?? current.total,
                    nextCursor: page.nextCursor,
                    error: '',
                }
            })
        } catch (error) {
            setPageState(current => current.key === value
                ? { ...current, error: error?.message || 'More photos could not be loaded.' }
                : current)
        } finally {
            setLoadingMore(false)
        }
    }, [loadingMore, nextCursor, reshuffling, value, setPageState])

    const reshuffle = useCallback(async () => {
        if (loading || loadingMore || reshuffling) return
        const targetValue = value
        const seed = createExploreSeed()
        setReshuffling(true)
        setLightboxIndex(null)
        try {
            const page = await fetchExplorePhotos({
                mode: 'exposure',
                value,
                limit: PAGE_SIZE,
                seed,
            })
            if (currentValueRef.current !== targetValue) return
            setPageState({
                key: targetValue,
                seed,
                items: page.items,
                total: page.total ?? page.items.length,
                nextCursor: page.nextCursor,
                error: '',
            })
        } catch (error) {
            if (currentValueRef.current === targetValue) {
                setPageState(current => ({
                    ...current,
                    error: error?.message || 'A new shuffle could not be loaded.',
                }))
            }
        } finally {
            setReshuffling(false)
        }
    }, [loading, loadingMore, reshuffling, value, setPageState])

    return (
        <div className="explore-page animate-fade-in pt-[74px]">
            <ExploreHeader title="Exposure Explorer" detail="Browse a random cross-section of the archive by the choices behind each exposure." />
            <section className="explore-content max-w-7xl mx-auto px-6 pb-20 md:pb-28">
                <ExploreBackLink />
                <section className="explore-exposure-panel" aria-labelledby="exposure-filter-title">
                    <div className="explore-exposure-heading">
                        <span>03</span>
                        <h2 id="exposure-filter-title">Choose a setting</h2>
                    </div>
                    <div className="explore-exposure-groups" role="tablist" aria-label="Exposure setting">
                        {EXPOSURE_GROUPS.map(candidate => (
                            <button
                                type="button"
                                role="tab"
                                aria-selected={candidate.id === group.id}
                                className={candidate.id === group.id ? 'is-active' : ''}
                                key={candidate.id}
                                onClick={() => chooseGroup(candidate.id)}
                            >
                                {candidate.label}
                            </button>
                        ))}
                    </div>
                    <div key={group.id} className="explore-exposure-options">
                        {group.options.map(option => {
                            const count = indexedGroup?.options.find(row => row.id === option.id)?.photos || 0
                            return (
                                <button
                                    type="button"
                                    key={option.id}
                                    className={option.id === optionId ? 'is-active' : ''}
                                    aria-pressed={option.id === optionId}
                                    disabled={!facetState.loading && count === 0}
                                    onClick={() => chooseOption(option.id)}
                                >
                                    <strong>{option.label}</strong>
                                    <span>{option.detail}</span>
                                    {!facetState.loading && <small>{count}</small>}
                                </button>
                            )
                        })}
                    </div>
                </section>

                <ExploreResults revision={JSON.stringify([pageState.key, pageState.seed])} items={displayImages}
                    mode="exposure" onOpen={setLightboxIndex} updating={loading || reshuffling}
                    label={!facetState.error && !resultError && (!loading || displayImages.length > 0)
                        ? `${group.label} · ${group.options.find(option => option.id === optionId)?.label}` : ''}
                    total={total} nextCursor={nextCursor} loadingMore={loadingMore} onLoadMore={loadMore}
                    reshuffling={reshuffling} onShuffle={reshuffle}>
                    {facetState.error && <p className="explore-error" role="alert">{facetState.error}</p>}
                    {resultError && <p className="explore-error" role="alert">{resultError}</p>}
                    {!loading && !facetState.error && !resultError && images.length === 0 && (
                        <div className="explore-empty explore-results-note"><h2>No photographs found</h2><p>Choose another setting to keep exploring.</p></div>
                    )}
                </ExploreResults>
            </section>
            <ExploreSampleLightbox
                images={images}
                index={lightboxIndex}
                setIndex={setLightboxIndex}
                ariaLabel="Photographs in Exposure Explorer"
            />
        </div>
    )
}

function GuessSettingsGame() {
    const { images, loading, error } = useExploreSample()

    return (
        <div className="explore-page animate-fade-in pt-[74px]">
            <ExploreHeader title="Guess the Settings" detail="Look closely at the photograph, then choose the setting you think made it." />
            <section className="explore-game max-w-7xl mx-auto px-6 pb-20 md:pb-28">
                <ExploreBackLink />
                {loading && <div className="explore-loading" role="status" aria-busy="true">Building a settings round…</div>}
                {error && <p className="explore-error" role="alert">{error}</p>}
                {!loading && !error && images.length === 0 && (
                    <div className="explore-empty"><h2>Not enough settings yet</h2><p>The game needs photographs with complete exposure metadata.</p></div>
                )}
                {!loading && !error && images.length > 0 && <SettingsGameBoard images={images} />}
            </section>
        </div>
    )
}

function createSettingsGame(images) {
    const deck = buildSettingsDeck(images)
    const [image, ...remaining] = deck
    return {
        remaining,
        round: buildSettingsRoundForImage(images, image),
        sequence: 0,
    }
}

function SettingsGameBoard({ images }) {
    const [game, setGame] = useState(() => createSettingsGame(images))
    const [selected, setSelected] = useState('')
    const [score, setScore] = useState({ correct: 0, answered: 0 })
    const [advancing, setAdvancing] = useState(false)
    const roundRef = useRef(null)
    const departureRef = useRef(null)
    const reduced = useMediaQuery('(prefers-reduced-motion: reduce)')
    const activeRound = game.round

    useLayoutEffect(() => () => departureRef.current?.cancel(), [])

    const chooseAnswer = value => {
        if (!activeRound || selected || departureRef.current) return
        setSelected(value)
        setScore(current => ({
            correct: current.correct + (value === activeRound.answer ? 1 : 0),
            answered: current.answered + 1,
        }))
    }

    const advanceRound = () => {
        departureRef.current = null
        setGame(current => {
            let deck = current.remaining.length ? current.remaining : buildSettingsDeck(images)
            const currentId = mediaId(current.round?.image)
            if (
                current.remaining.length === 0
                && deck.length > 1
                && mediaId(deck[0]) === currentId
            ) {
                deck = deck.slice(1).concat(deck[0])
            }
            const [image, ...remaining] = deck
            return {
                remaining,
                round: buildSettingsRoundForImage(images, image),
                sequence: current.sequence + 1,
            }
        })
        setSelected('')
        setAdvancing(false)
    }

    const nextRound = () => {
        if (departureRef.current) return
        const round = roundRef.current
        if (reduced || !round?.animate) {
            advanceRound()
            return
        }
        const style = getComputedStyle(round)
        const departure = round.animate([{ opacity: style.opacity, translate: style.translate }, { opacity: 0, translate: '0 -4px' }],
            { duration: 145, easing: 'ease-in', fill: 'forwards' })
        departureRef.current = departure
        setAdvancing(true)
        departure.finished.then(advanceRound, () => {})
    }

    if (!activeRound) {
        return <div className="explore-empty"><h2>Not enough settings yet</h2><p>The game needs photographs with complete exposure metadata.</p></div>
    }

    return (
        <div className="explore-game-board">
            <div className="explore-game-photo">
                <ProgressiveImage
                    key={mediaId(activeRound.image)}
                    src={mediaThumbnailUrl(activeRound.image)}
                    srcSet={mediaPreviewSrcSet(activeRound.image)}
                    sizes="(max-width: 800px) calc(100vw - 3rem), 58vw"
                    width={activeRound.image.width || 4}
                    height={activeRound.image.height || 3}
                    alt={`A photograph from ${activeRound.image.albumTitle}`}
                    eager
                    className="explore-game-image"
                />
                <span>{activeRound.image.albumTitle}</span>
            </div>
            <div className="explore-game-question">
                <div className="explore-game-score">
                    <span>04 · Round {score.answered + (selected ? 0 : 1)}</span>
                    <strong>{score.correct} / {score.answered} correct</strong>
                </div>
                <div key={game.sequence} ref={roundRef} className="explore-game-round" data-round={game.sequence} aria-busy={advancing || undefined}>
                    <div className="explore-game-prompt">
                        {SETTINGS_PROMPTS.map(prompt => <span key={prompt} aria-hidden="true">{prompt}</span>)}
                        <h2>{activeRound.prompt}</h2>
                    </div>
                    <div className="explore-game-options">
                        {activeRound.options.map(option => {
                            const answered = Boolean(selected)
                            const className = answered
                                ? option === activeRound.answer ? 'is-correct' : option === selected ? 'is-wrong' : ''
                                : ''
                            return (
                                <button type="button" key={option} className={className} disabled={answered || advancing}
                                    title={option} onClick={() => chooseAnswer(option)}>
                                    {option}
                                </button>
                            )
                        })}
                    </div>
                </div>
                <div className="explore-game-feedback" data-answered={selected ? '' : undefined}>
                    <div className="explore-game-answer" role="status" aria-hidden={!selected}>
                        <strong>{selected === activeRound.answer ? 'Correct.' : `The answer was ${activeRound.answer}.`}</strong>
                        <p>
                            {activeRound.image.exif.focalLength} · {activeRound.image.exif.focalRatio} · {activeRound.image.exif.shutterSpeed} · {activeRound.image.exif.iso}
                        </p>
                    </div>
                    {!selected && <button type="button" className="explore-game-skip" aria-disabled={advancing || undefined} onClick={nextRound}>Skip photograph</button>}
                    <div className="explore-game-actions">
                        {selected && <button type="button" className="explore-game-next" aria-disabled={advancing || undefined} onClick={nextRound}>Next photograph →</button>}
                    </div>
                </div>
            </div>
        </div>
    )
}

export default function Explore() {
    const location = useLocation()
    const { pathname } = location
    if (pathname === '/explore/immersive-gallery') return <ImmersiveGallery />
    if (pathname === '/explore/colors') return <ExploreModule key="color" mode="color" />
    if (pathname === '/explore/lenses') return <ExploreModule key="lens" mode="lens" />
    if (pathname === '/explore/exposure') return <ExposureExplorer />
    if (pathname === '/explore/time-of-day') return <TemporalExplorer key="time" mode="time" />
    if (pathname === '/explore/seasons') return <TemporalExplorer key="season" mode="season" />
    if (pathname === '/explore/guess-settings') return <GuessSettingsGame />
    return <ExploreLanding />
}
