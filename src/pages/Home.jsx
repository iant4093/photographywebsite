import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigationType } from 'react-router'
import AlbumCard from '../components/AlbumCard'
import ScrollRow from '../components/ScrollRow'
import SkeletonGrid from '../components/SkeletonGrid'
import FloatingGallery from '../components/FloatingGallery'
import {
    fetchAlbumsPage,
} from '../utils/api'
import {
    CatalogPaginationError,
    deleteCatalogSnapshot,
    getCatalogSnapshot,
    loadCompleteCatalog,
    reconcilePublicCatalogItems,
    setCatalogSnapshot,
} from '../utils/catalogState'
import { isRevealed, markAsRevealed, useScrollRestoration } from '../utils/scroll'
import {
    currentHeroSrcSet,
    currentHeroUrl,
    heroCoverUrl,
} from '../utils/mediaUrls'
import { sortGalleryAlbums, sortGalleryCategories } from '../utils/galleryOrder'
import { HOME_SECTION_SORT_OPTIONS, sortHomePhotoSections } from '../utils/homeSectionSort'
import { trackHeroExplore } from '../utils/analytics'

const CATALOG_KEY = 'public-photos'
const RandomPhotoExplorer = lazy(() => import('../components/RandomPhotoExplorer'))
// Fetch the complete current public catalog in one compressed response while
// retaining cursor pagination once the catalog grows beyond the API's cap.
const PAGE_SIZE = 100
const HERO_WIDTHS = [640, 960, 1280, 1920]
const heroSet = (format) => HERO_WIDTHS
    .map((width) => `/images/heroes/photo-${width}.${format} ${width}w`)
    .join(', ')

function Home() {
    const navigationType = useNavigationType()
    const location = useLocation()
    const [initialSnapshot] = useState(() => getCatalogSnapshot(CATALOG_KEY))
    const catalogSnapshotRef = useRef(initialSnapshot)
    const pageRef = useRef(null)
    const heroRef = useRef(null)

    useScrollRestoration(location.pathname, navigationType === 'POP')

    const [albums, setAlbums] = useState(initialSnapshot?.items || [])
    const [loading, setLoading] = useState(!initialSnapshot)
    const [error, setError] = useState(null)
    const [loadAttempt, setLoadAttempt] = useState(0)
    const [responsiveHeroFailed, setResponsiveHeroFailed] = useState(false)
    const [managedHomeFailed, setManagedHomeFailed] = useState(false)
    const [sectionSort, setSectionSort] = useState('curated')

    const handleExplorePhotos = useCallback((event) => {
        const target = document.getElementById('photo-albums')
        if (!target) return
        event.preventDefault()
        trackHeroExplore('photo')
        target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, [])

    const savePage = useCallback((items, cursor) => {
        const reconciledItems = reconcilePublicCatalogItems(items, 'photo')
        catalogSnapshotRef.current = { items: reconciledItems, nextCursor: cursor }
        setAlbums(reconciledItems)
        setCatalogSnapshot(CATALOG_KEY, { items: reconciledItems, nextCursor: cursor })
    }, [])

    useEffect(() => {
        const controller = new AbortController()
        const snapshot = catalogSnapshotRef.current
        const hasFreshSnapshot = Boolean(snapshot && !snapshot.stale)

        loadCompleteCatalog({
            fetchPage: (cursor) => fetchAlbumsPage({
                visibility: 'public',
                type: 'photo',
                limit: PAGE_SIZE,
                cursor,
            }, { signal: controller.signal }),
            initialItems: hasFreshSnapshot ? snapshot.items : [],
            initialCursor: hasFreshSnapshot ? snapshot.nextCursor : null,
            hasInitialPage: hasFreshSnapshot,
            signal: controller.signal,
            onPage: ({ items, nextCursor: cursor }) => {
                if (controller.signal.aborted) return
                savePage(items, cursor)
                setLoading(false)
            },
        })
            .catch((requestError) => {
                if (requestError.name === 'AbortError') return
                if (
                    requestError instanceof CatalogPaginationError
                    || ['BAD_CURSOR', 'REPEATED_CURSOR'].includes(requestError.code)
                ) {
                    catalogSnapshotRef.current = null
                    deleteCatalogSnapshot(CATALOG_KEY)
                }
                setError(requestError.message || 'Photos could not be loaded.')
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false)
            })
        return () => controller.abort()
    }, [loadAttempt, savePage])

    useEffect(() => {
        const hero = heroRef.current
        if (!hero || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined
        let frame = null
        const update = () => {
            frame = null
            const shift = Math.min(Math.max(0, window.scrollY) * 0.08, 24)
            hero.style.transform = `translateY(-${shift}px)`
        }
        const onScroll = () => {
            if (frame === null) frame = window.requestAnimationFrame(update)
        }
        window.addEventListener('scroll', onScroll, { passive: true })
        return () => {
            window.removeEventListener('scroll', onScroll)
            if (frame !== null) window.cancelAnimationFrame(frame)
        }
    }, [responsiveHeroFailed, managedHomeFailed])

    useEffect(() => {
        const elements = pageRef.current?.querySelectorAll('[data-reveal-id]') || []
        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue
                entry.target.classList.add('is-visible')
                markAsRevealed(entry.target.dataset.revealId)
                observer.unobserve(entry.target)
            }
        }, { rootMargin: '0px 0px -60px 0px', threshold: 0.1 })

        for (const element of elements) {
            if (isRevealed(element.dataset.revealId)) {
                element.classList.add('is-visible', 'no-stagger')
            } else {
                observer.observe(element)
            }
        }
        return () => observer.disconnect()
    }, [albums])

    const photoAlbums = useMemo(() => albums.filter((album) => album.type !== 'video'), [albums])
    const managedHomeUrl = heroCoverUrl()
    const responsiveHomeUrl = currentHeroUrl()
    const useResponsiveHero = Boolean(responsiveHomeUrl) && !responsiveHeroFailed
    const useBundledHero = !useResponsiveHero && (!managedHomeUrl || managedHomeFailed)
    const heroSrc = useResponsiveHero
        ? responsiveHomeUrl
        : (useBundledHero ? '/images/heroes/photo-1280.jpg' : managedHomeUrl)
    const heroSrcSet = useResponsiveHero
        ? currentHeroSrcSet('jpeg')
        : (useBundledHero ? heroSet('jpg') : undefined)
    const heroWidth = useResponsiveHero ? 1280 : (useBundledHero ? 6000 : 2560)
    const heroHeight = useResponsiveHero ? 853 : (useBundledHero ? 4000 : 1707)
    const getInstantRandomPhoto = useCallback(() => {
        const url = heroRef.current?.currentSrc || heroSrc
        return url ? {
            id: url,
            url,
            thumbnailUrl: url,
            downloadUrl: url,
        } : null
    }, [heroSrc])
    const { groupedPhotoAlbums, curatedPhotoCategories } = useMemo(() => {
        const grouped = photoAlbums.reduce((result, album) => {
            const category = album.category || 'Uncategorized'
            if (!result[category]) result[category] = []
            result[category].push(album)
            return result
        }, {})
        for (const category of Object.keys(grouped)) {
            grouped[category] = sortGalleryAlbums(grouped[category])
        }
        const categories = sortGalleryCategories(Object.keys(grouped), grouped)
        return { groupedPhotoAlbums: grouped, curatedPhotoCategories: categories }
    }, [photoAlbums])
    const photoCategories = useMemo(() => (
        sortHomePhotoSections(curatedPhotoCategories, groupedPhotoAlbums, sectionSort)
    ), [curatedPhotoCategories, groupedPhotoAlbums, sectionSort])

    return (
        <div ref={pageRef}>
            <section className="home-hero linen-hero relative overflow-hidden">
                <div className="absolute inset-0 overflow-hidden">
                    <picture>
                        {useResponsiveHero ? (
                            <>
                                <source type="image/avif" srcSet={currentHeroSrcSet('avif')} sizes="100vw" />
                                <source type="image/webp" srcSet={currentHeroSrcSet('webp')} sizes="100vw" />
                            </>
                        ) : useBundledHero ? (
                            <>
                            <source type="image/avif" srcSet={heroSet('avif')} sizes="100vw" />
                            <source type="image/webp" srcSet={heroSet('webp')} sizes="100vw" />
                            </>
                        ) : null}
                        <img
                            ref={heroRef}
                            src={heroSrc}
                            srcSet={heroSrcSet}
                            sizes="100vw"
                            width={heroWidth}
                            height={heroHeight}
                            alt="Ian Truong Photography portfolio cover"
                            fetchPriority="high"
                            loading="eager"
                            decoding="async"
                            onError={() => {
                                if (useResponsiveHero) setResponsiveHeroFailed(true)
                                else if (!useBundledHero) setManagedHomeFailed(true)
                            }}
                            className="home-hero-media parallax-hero"
                        />
                    </picture>
                    <div className="home-hero-overlay absolute inset-0" />
                </div>

                <div className="linen-hero-content relative max-w-7xl mx-auto px-6 py-32 md:py-48">
                    <div className="linen-hero-copy max-w-xs sm:max-w-sm md:max-w-md animate-fade-in">
                        <h1 className="font-serif text-5xl md:text-7xl font-normal text-white leading-[0.95] tracking-tight">Ian Truong<br />Photography</h1>
                        <p className="mt-6 text-base md:text-lg text-white/90 font-light leading-relaxed">
                            Hi, I'm Ian — welcome to my photography portfolio. I shoot wildlife, portraits, sports, and general
                            photography as a hobby. Take a look around!
                        </p>
                        <div className="flex flex-wrap items-center gap-4 mt-8">
                            <a
                                href="#photo-albums"
                                onClick={handleExplorePhotos}
                                className="linen-button linen-button-light inline-flex items-center gap-2 px-6 py-3 text-white font-medium transition-all duration-300"
                            >
                                Explore Photos
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                </svg>
                            </a>
                            <div className="flex flex-col items-start">
                                <Link to="/videos" onClick={() => trackHeroExplore('video')} className="linen-text-link inline-flex items-center gap-2 px-1 py-2 text-white font-medium transition-all duration-300">
                                    Explore Videos
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                </Link>
                                <Suspense fallback={<span className="px-1 py-2 text-white/70">Explore Random Photos</span>}>
                                    <RandomPhotoExplorer
                                        albums={photoAlbums}
                                        getInstantPhoto={getInstantRandomPhoto}
                                    />
                                </Suspense>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            <section id="albums" className="max-w-7xl mx-auto px-6 pt-10 pb-16 md:pt-14 md:pb-24">
                <FloatingGallery albums={photoAlbums} />

                <div
                    id="photo-albums"
                    data-reveal-id="home-photo-header"
                    className="linen-section-heading linen-section-heading-album-index mb-14 scroll-animate"
                    style={{ scrollMarginTop: '6rem' }}
                >
                    <span>Selected index</span>
                    <h2 className="font-serif text-4xl md:text-5xl font-normal text-charcoal inline-block">Photo Albums</h2>
                    <label className="home-section-sort" htmlFor="home-section-sort">
                        <span>Sort sections</span>
                        <span className="home-section-sort-control">
                            <select
                                id="home-section-sort"
                                value={sectionSort}
                                onChange={(event) => setSectionSort(event.target.value)}
                            >
                                {HOME_SECTION_SORT_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>{option.label}</option>
                                ))}
                            </select>
                        </span>
                    </label>
                </div>

                {loading && <SkeletonGrid count={6} type="photo" />}
                {error && (
                    <div className="text-center py-8 text-red-700" role="alert">
                        <p>{error}</p>
                        <button
                            type="button"
                            onClick={() => {
                                setError(null)
                                setLoading(albums.length === 0)
                                setLoadAttempt((attempt) => attempt + 1)
                            }}
                            className="mt-4 px-5 py-2 rounded-xl border border-red-700 hover:bg-red-50 transition-colors"
                        >
                            Try again
                        </button>
                    </div>
                )}

                {!loading && photoCategories.map((category, categoryIndex) => {
                    const sectionId = `photo-cat-${category.toLowerCase().replace(/\s+/g, '-')}`
                    return (
                        <div
                            key={category}
                            data-reveal-id={sectionId}
                            className="mb-16 scroll-animate catalog-section"
                            style={{ transitionDelay: `${Math.min(categoryIndex, 4) * 80}ms` }}
                        >
                            <div className="flex items-center gap-4 mb-8">
                                <span className="linen-category-number">{String(categoryIndex + 1).padStart(2, '0')}</span>
                                <h3 className="font-serif text-2xl font-normal text-charcoal w-fit">{category}</h3>
                                <div className="h-px bg-warm-border flex-1" />
                            </div>
                            <ScrollRow scrollKey={`home-photo-${category}`}>
                                {groupedPhotoAlbums[category].map((album) => (
                                    <div key={album.albumId} className="shrink-0 w-[280px] sm:w-[320px] md:w-[360px] snap-start stagger-child">
                                        <AlbumCard album={album} showNewFlag />
                                    </div>
                                ))}
                            </ScrollRow>
                        </div>
                    )
                })}

                {!loading && photoAlbums.length === 0 && !error && (
                    <div className="text-center py-12 text-warm-gray"><p>No photo albums found.</p></div>
                )}
            </section>

        </div>
    )
}

export default Home
