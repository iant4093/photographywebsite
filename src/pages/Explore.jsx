import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import PhotoLightbox from '../components/PhotoLightbox'
import ProgressiveImage from '../components/ProgressiveImage'
import { requestAlbumMediaDownload, requestAlbumPrintSession } from '../utils/api'
import {
    fetchExploreColors,
    fetchExploreLenses,
    fetchExplorePhotos,
    fetchExploreSample,
    prefetchExploreModule,
} from '../utils/exploreApi'
import { buildSettingsRound, EXPOSURE_GROUPS, matchingExposurePhotos } from '../utils/exposure'
import { trackPhotoDownload } from '../utils/analytics'
import {
    mediaFileName,
    mediaId,
    mediaPreviewSrcSet,
    resolveMediaDownloadUrl,
    startBrowserDownload,
} from '../utils/mediaUrls'
import './Explore.css'
import { openPrintOrder } from '../utils/printOrders'

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
    const warmModule = useCallback((mode) => {
        prefetchExploreModule(mode).catch(() => {})
    }, [])

    useEffect(() => {
        const warm = () => Promise.allSettled([
            prefetchExploreModule('color'),
            prefetchExploreModule('lens'),
            prefetchExploreModule('sample'),
        ])
        if (typeof window.requestIdleCallback === 'function') {
            const idleId = window.requestIdleCallback(warm, { timeout: 1500 })
            return () => window.cancelIdleCallback?.(idleId)
        }
        const timeoutId = window.setTimeout(warm, 350)
        return () => window.clearTimeout(timeoutId)
    }, [])

    return (
        <div className="explore-page animate-fade-in pt-[74px]">
            <ExploreHeader />
            <section className="explore-modules max-w-7xl mx-auto px-6 pb-20 md:pb-28" aria-label="Explore modules">
                <Link
                    to="/explore/colors"
                    className="explore-module-card editorial-motion-media"
                    onPointerEnter={() => warmModule('color')}
                    onFocus={() => warmModule('color')}
                >
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
                <Link
                    to="/explore/lenses"
                    className="explore-module-card editorial-motion-media"
                    onPointerEnter={() => warmModule('lens')}
                    onFocus={() => warmModule('lens')}
                >
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
                <Link
                    to="/explore/exposure"
                    className="explore-module-card editorial-motion-media"
                    onPointerEnter={() => warmModule('sample')}
                    onFocus={() => warmModule('sample')}
                >
                    <span className="explore-module-number">03</span>
                    <div className="explore-module-exposure" aria-hidden="true">
                        <i /><i /><i /><i />
                    </div>
                    <div>
                        <h2>Exposure Explorer</h2>
                        <p>Browse by aperture, shutter speed, ISO, and focal length.</p>
                    </div>
                    <span className="explore-module-arrow" aria-hidden="true">→</span>
                </Link>
                <Link
                    to="/explore/guess-settings"
                    className="explore-module-card editorial-motion-media"
                    onPointerEnter={() => warmModule('sample')}
                    onFocus={() => warmModule('sample')}
                >
                    <span className="explore-module-number">04</span>
                    <div className="explore-module-game" aria-hidden="true">
                        <span>?</span>
                        <i>1/500</i><i>f/2.8</i><i>ISO 400</i>
                    </div>
                    <div>
                        <h2>Guess the Settings</h2>
                        <p>Read the frame, choose the camera setting, and test your eye.</p>
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
            .then(({ items, initialPage }) => {
                setFacets(items)
                if (initialPage?.value) {
                    setPageState({
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
    }, [isColor, mode])

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
    }, [hasCurrentPage, mode, requestKey, value])

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

    const handlePrint = useCallback(async (event, image) => {
        event.stopPropagation()
        try {
            await openPrintOrder(() => requestAlbumPrintSession(image.albumId, mediaId(image)))
        } catch (error) {
            console.error('Explore print order failed:', error)
            alert(error?.message || 'The print store could not be opened. Please try again.')
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
                    onPrint={handlePrint}
                />
            )}
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

    const handlePrint = useCallback(async (event, image) => {
        event.stopPropagation()
        try {
            await openPrintOrder(() => requestAlbumPrintSession(image.albumId, mediaId(image)))
        } catch (error) {
            console.error('Explore print order failed:', error)
            alert(error?.message || 'The print store could not be opened. Please try again.')
        }
    }, [])

    if (index === null || !images[index]) return null
    return (
        <PhotoLightbox
            images={images}
            index={index}
            ariaLabel={ariaLabel}
            onClose={() => setIndex(null)}
            onNext={() => setIndex(current => (current + 1) % images.length)}
            onPrevious={() => setIndex(current => (current - 1 + images.length) % images.length)}
            onDownload={handleDownload}
            onPrint={handlePrint}
            shareTitle="Ian Truong Photography"
        />
    )
}

function ExposureExplorer() {
    const { images, loading, error } = useExploreSample()
    const [groupId, setGroupId] = useState('aperture')
    const [optionId, setOptionId] = useState('wide')
    const [lightboxIndex, setLightboxIndex] = useState(null)
    const group = EXPOSURE_GROUPS.find(candidate => candidate.id === groupId) || EXPOSURE_GROUPS[0]
    const matching = useMemo(
        () => matchingExposurePhotos(images, group.id, optionId),
        [group.id, images, optionId],
    )

    const chooseGroup = nextGroup => {
        const next = EXPOSURE_GROUPS.find(candidate => candidate.id === nextGroup)
        if (!next) return
        const populated = next.options.find(option => matchingExposurePhotos(images, next.id, option.id).length > 0)
        setGroupId(next.id)
        setOptionId(populated?.id || next.options[0].id)
        setLightboxIndex(null)
    }

    return (
        <div className="explore-page animate-fade-in pt-[74px]">
            <ExploreHeader title="Exposure Explorer" detail="Browse a random cross-section of the archive by the choices behind each exposure." />
            <section className="explore-content max-w-7xl mx-auto px-6 pb-20 md:pb-28">
                <Link to="/explore" className="explore-back">← All Explore modules</Link>
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
                    <div className="explore-exposure-options">
                        {group.options.map(option => {
                            const count = matchingExposurePhotos(images, group.id, option.id).length
                            return (
                                <button
                                    type="button"
                                    key={option.id}
                                    className={option.id === optionId ? 'is-active' : ''}
                                    aria-pressed={option.id === optionId}
                                    disabled={!loading && count === 0}
                                    onClick={() => { setOptionId(option.id); setLightboxIndex(null) }}
                                >
                                    <strong>{option.label}</strong>
                                    <span>{option.detail}</span>
                                    {!loading && <small>{count}</small>}
                                </button>
                            )
                        })}
                    </div>
                </section>

                {loading && <div className="explore-loading" role="status">Reading exposure settings…</div>}
                {error && <p className="explore-error" role="alert">{error}</p>}
                {!loading && !error && (
                    <div className="explore-results-heading" aria-live="polite">
                        <p><strong>{matching.length}</strong> {matching.length === 1 ? 'photograph' : 'photographs'} in this shuffle</p>
                        <span>{group.label} · {group.options.find(option => option.id === optionId)?.label}</span>
                    </div>
                )}
                {!loading && !error && matching.length === 0 && (
                    <div className="explore-empty"><h2>No match in this shuffle</h2><p>Choose another setting to keep exploring.</p></div>
                )}
                {matching.length > 0 && (
                    <div className="explore-grid">
                        {matching.map((item, itemIndex) => (
                            <ExploreCard
                                key={`${item.albumId}:${item.mediaId}`}
                                item={item}
                                index={itemIndex}
                                mode="exposure"
                                onOpen={setLightboxIndex}
                            />
                        ))}
                    </div>
                )}
            </section>
            <ExploreSampleLightbox
                images={matching}
                index={lightboxIndex}
                setIndex={setLightboxIndex}
                ariaLabel="Photographs in Exposure Explorer"
            />
        </div>
    )
}

function GuessSettingsGame() {
    const { images, loading, error } = useExploreSample()
    const [round, setRound] = useState(null)
    const [selected, setSelected] = useState('')
    const [score, setScore] = useState({ correct: 0, answered: 0 })
    const initialRound = useMemo(() => buildSettingsRound(images), [images])
    const activeRound = round || initialRound

    const chooseAnswer = value => {
        if (!activeRound || selected) return
        setSelected(value)
        setScore(current => ({
            correct: current.correct + (value === activeRound.answer ? 1 : 0),
            answered: current.answered + 1,
        }))
    }

    const nextRound = () => {
        const previousId = activeRound?.image?.mediaId || activeRound?.image?.id || activeRound?.image?.url || ''
        setRound(buildSettingsRound(images, previousId))
        setSelected('')
    }

    return (
        <div className="explore-page animate-fade-in pt-[74px]">
            <ExploreHeader title="Guess the Settings" detail="Look closely at the photograph, then choose the setting you think made it." />
            <section className="explore-game max-w-7xl mx-auto px-6 pb-20 md:pb-28">
                <Link to="/explore" className="explore-back">← All Explore modules</Link>
                {loading && <div className="explore-loading" role="status">Building a settings round…</div>}
                {error && <p className="explore-error" role="alert">{error}</p>}
                {!loading && !error && !activeRound && (
                    <div className="explore-empty"><h2>Not enough settings yet</h2><p>The game needs photographs with complete exposure metadata.</p></div>
                )}
                {activeRound && (
                    <div className="explore-game-board">
                        <div className="explore-game-photo">
                            <ProgressiveImage
                                key={mediaId(activeRound.image)}
                                src={activeRound.image.thumbnailUrl}
                                srcSet={mediaPreviewSrcSet(activeRound.image)}
                                sizes="(max-width: 800px) calc(100vw - 3rem), 58vw"
                                width={activeRound.image.width || 4}
                                height={activeRound.image.height || 3}
                                alt={`A photograph from ${activeRound.image.albumTitle}`}
                                eager
                            />
                            <span>{activeRound.image.albumTitle}</span>
                        </div>
                        <div className="explore-game-question">
                            <div className="explore-game-score">
                                <span>04 · Round {score.answered + (selected ? 0 : 1)}</span>
                                <strong>{score.correct} / {score.answered} correct</strong>
                            </div>
                            <h2>{activeRound.prompt}</h2>
                            <div className="explore-game-options">
                                {activeRound.options.map(option => {
                                    const answered = Boolean(selected)
                                    const className = answered
                                        ? option === activeRound.answer ? 'is-correct' : option === selected ? 'is-wrong' : ''
                                        : ''
                                    return (
                                        <button
                                            type="button"
                                            key={option}
                                            className={className}
                                            disabled={answered}
                                            onClick={() => chooseAnswer(option)}
                                        >
                                            {option}
                                        </button>
                                    )
                                })}
                            </div>
                            {selected ? (
                                <div className="explore-game-answer" role="status">
                                    <strong>{selected === activeRound.answer ? 'Correct.' : `The answer was ${activeRound.answer}.`}</strong>
                                    <p>
                                        {activeRound.image.exif.focalLength} · {activeRound.image.exif.focalRatio} · {activeRound.image.exif.shutterSpeed} · {activeRound.image.exif.iso}
                                    </p>
                                    <button type="button" onClick={nextRound}>Next photograph →</button>
                                </div>
                            ) : (
                                <button type="button" className="explore-game-skip" onClick={nextRound}>Skip photograph</button>
                            )}
                        </div>
                    </div>
                )}
            </section>
        </div>
    )
}

export default function Explore() {
    const { pathname } = useLocation()
    if (pathname === '/explore/colors') return <ExploreModule mode="color" />
    if (pathname === '/explore/lenses') return <ExploreModule mode="lens" />
    if (pathname === '/explore/exposure') return <ExposureExplorer />
    if (pathname === '/explore/guess-settings') return <GuessSettingsGame />
    return <ExploreLanding />
}
