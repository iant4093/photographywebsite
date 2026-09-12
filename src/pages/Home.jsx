import useHeroParallax from '../hooks/useHeroParallax'
import SiteSelect from '../components/SiteSelect'
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
    heroManifestSrcSet,
    heroManifestImageUrl,
} from '../utils/mediaUrls'
import { sortGalleryAlbums, sortGalleryCategories } from '../utils/galleryOrder'
import { HOME_SECTION_SORT_OPTIONS, sortHomePhotoSections } from '../utils/homeSectionSort'
import { trackHeroExplore } from '../utils/analytics'
import useAlbumYearFilters from '../hooks/useAlbumYearFilters'
import usePublishedHero from '../hooks/usePublishedHero'
import { heroImageSizes } from '../utils/heroImageSizes'

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
    const publishedHero = usePublishedHero('photo')
    const [failedHeroVersion, setFailedHeroVersion] = useState(null)

    useScrollRestoration(location.pathname, navigationType === 'POP')

    const [albums, setAlbums] = useState(initialSnapshot?.items || [])
    const [loading, setLoading] = useState(!initialSnapshot)
    const [error, setError] = useState(null)
    const [loadAttempt, setLoadAttempt] = useState(0)
    const [responsiveHeroFailed, setResponsiveHeroFailed] = useState(false)
    const [managedHomeFailed, setManagedHomeFailed] = useState(false)
    const [sectionSort, setSectionSort] = useState(0)

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

    useHeroParallax(heroRef, -0.08, 24)


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
    const usePublishedVersion = publishedHero && failedHeroVersion !== publishedHero.version
    const heroSizes = heroImageSizes(usePublishedVersion ? publishedHero.source : null)
    const useResponsiveHero = usePublishedVersion || (Boolean(responsiveHomeUrl) && !responsiveHeroFailed)
    const useBundledHero = !useResponsiveHero && (!managedHomeUrl || managedHomeFailed)
    const heroSrc = useResponsiveHero
        ? (usePublishedVersion ? heroManifestImageUrl(publishedHero) : responsiveHomeUrl)
        : (useBundledHero ? '/images/heroes/photo-1280.jpg' : managedHomeUrl)
    const heroSrcSet = useResponsiveHero
        ? (usePublishedVersion ? heroManifestSrcSet(publishedHero, 'jpeg') : currentHeroSrcSet('jpeg'))
        : (useBundledHero ? heroSet('jpg') : undefined)
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
    const { sections: photoSections, setCategoryYear } = useAlbumYearFilters(groupedPhotoAlbums)

    return (
        <div ref={pageRef}>
            <section className="home-hero linen-hero relative overflow-hidden">
                <div className="absolute inset-0 overflow-hidden">
                    <picture>
                        {useResponsiveHero ? (
                            <>
                                <source type="image/avif" srcSet={usePublishedVersion ? heroManifestSrcSet(publishedHero, 'avif') : currentHeroSrcSet('avif')} sizes={heroSizes} />
                                <source type="image/webp" srcSet={usePublishedVersion ? heroManifestSrcSet(publishedHero, 'webp') : currentHeroSrcSet('webp')} sizes={heroSizes} />
                            </>
                        ) : useBundledHero ? (
                            <>
                            <source type="image/avif" srcSet={heroSet('avif')} sizes={heroSizes} />
                            <source type="image/webp" srcSet={heroSet('webp')} sizes={heroSizes} />
                            </>
                        ) : null}
                        <img
                            ref={heroRef}
                            src={heroSrc}
                            srcSet={heroSrcSet}
                            sizes={heroSizes}
                            width="1280"
                            height="853"
                            alt="Ian Truong Photography portfolio cover"
                            fetchPriority="high"
                            decoding="async"
                            onError={() => {
                                if (usePublishedVersion) setFailedHeroVersion(publishedHero.version)
                                else if (useResponsiveHero) setResponsiveHeroFailed(true)
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
                        <div className="linen-hero-actions flex flex-wrap items-center gap-4">
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
                                    <RandomPhotoExplorer />
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
                    className="linen-section-heading mb-14 scroll-animate"
                    style={{ scrollMarginTop: '6rem' }}
                >
                    <span>Selected index</span>
                    <h2 className="font-serif text-4xl md:text-5xl font-normal text-charcoal inline-block">Photo Albums</h2>
                    <label className="w-full" htmlFor="home-section-sort">
                        <span className="linen-category-number block mb-1">Sort sections</span>
                        <span className="relative block">
                            <SiteSelect
                                id="home-section-sort"
                                aria-label="Sort sections"
                                value={sectionSort}
                                onChange={(value) => setSectionSort(Number(value))}
                                className="w-full py-2 px-4 border-0 border-b border-charcoal rounded-none text-charcoal bg-transparent text-xs font-medium tracking-wider uppercase cursor-pointer focus:outline-none"
                                options={HOME_SECTION_SORT_OPTIONS.map((label, value) => ({ value, label }))}
                            />
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
                    const { albums: visibleAlbums, year, options } = photoSections[category]
                    const scrollKey = `home-photo-${category}${year === 'all' ? '' : `-year-${year}`}`
                    return (
                        <div
                            key={category}
                            data-reveal-id={sectionId}
                            className="mb-16 scroll-animate catalog-section"
                            style={{ transitionDelay: `${Math.min(categoryIndex, 4) * 80}ms` }}
                        >
                            <div className="flex flex-wrap items-center gap-3 sm:gap-4 mb-8">
                                <div className="flex min-w-0 items-center gap-2 sm:gap-4">
                                    <span className="linen-category-number shrink-0">{String(categoryIndex + 1).padStart(2, '0')}</span>
                                    <h3 className="font-serif text-2xl font-normal text-charcoal min-w-0 [overflow-wrap:anywhere]">{category}</h3>
                                    <RandomPhotoExplorer category={category} variant="icon" showStats />
                                </div>
                                <div className="hidden sm:block h-px bg-warm-border flex-1" />
                                <SiteSelect
                                    aria-label={`Filter ${category} albums by year`}
                                    value={year}
                                    onChange={value => setCategoryYear(category, value)}
                                    options={options}
                                    className="ml-auto w-28 sm:w-32 shrink-0 text-sm"
                                />
                            </div>
                            <ScrollRow key={year} scrollKey={scrollKey}>
                                {visibleAlbums.map((album) => (
                                    <div key={album.albumId} className="shrink-0 w-[280px] sm:w-[320px] lg:w-[360px] snap-start stagger-child">
                                        <AlbumCard album={album} showNewFlag preview />
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
