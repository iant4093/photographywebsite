import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigationType } from 'react-router'
import VideoAlbumCard from '../components/VideoAlbumCard'
import ScrollRow from '../components/ScrollRow'
import SkeletonGrid from '../components/SkeletonGrid'
import { fetchAlbumsPage } from '../utils/api'
import { mergeUniqueById } from '../utils/apiResponse'
import { getCatalogSnapshot, reconcilePublicCatalogItems, setCatalogSnapshot } from '../utils/catalogState'
import { sortGalleryAlbums, sortGalleryCategories } from '../utils/galleryOrder'
import { sortVideoSections, VIDEO_SECTION_SORT_OPTIONS } from '../utils/videoSectionSort'
import { cdnUrl, HERO_CURRENT_WIDTHS } from '../utils/mediaUrls'
import { isRevealed, markAsRevealed, useScrollRestoration } from '../utils/scroll'

const CATALOG_KEY = 'public-videos'
// The API enforces 100 as its maximum, which keeps today's video catalog to a
// single request without removing the existing cursor safety net.
const PAGE_SIZE = 100
const HERO_WIDTHS = [640, 960, 1280, 1920]
const heroSet = (format) => HERO_WIDTHS
    .map((width) => `/images/heroes/video-${width}.${format} ${width}w`)
    .join(', ')
const VIDEO_HERO_PREFIX = 'site/hero/video/current'
const currentVideoHeroUrl = (format = 'jpeg') => {
    const extension = format === 'jpeg' ? 'jpg' : format
    return ['avif', 'webp', 'jpg'].includes(extension) ? cdnUrl(`${VIDEO_HERO_PREFIX}/hero.${extension}`) : ''
}
const currentVideoHeroSrcSet = (format = 'jpeg') => {
    const extension = format === 'jpeg' ? 'jpg' : format
    return ['avif', 'webp', 'jpg'].includes(extension)
        ? HERO_CURRENT_WIDTHS.map((width) => `${cdnUrl(`${VIDEO_HERO_PREFIX}/hero-${width}.${extension}`)} ${width}w`).join(', ')
        : ''
}

export default function Videos() {
    const navigationType = useNavigationType()
    const location = useLocation()
    const [initialSnapshot] = useState(() => getCatalogSnapshot(CATALOG_KEY))
    const pageRef = useRef(null)
    const heroRef = useRef(null)
    useScrollRestoration(location.pathname, navigationType === 'POP')

    const [albums, setAlbums] = useState(initialSnapshot?.items || [])
    const [nextCursor, setNextCursor] = useState(initialSnapshot?.nextCursor || null)
    const [loading, setLoading] = useState(!initialSnapshot)
    const [loadingMore, setLoadingMore] = useState(false)
    const [error, setError] = useState(null)
    const [responsiveHeroFailed, setResponsiveHeroFailed] = useState(false)
    const [managedHeroFailed, setManagedHeroFailed] = useState(false)
    const [sectionSort, setSectionSort] = useState(0)

    const savePage = useCallback((items, cursor) => {
        const reconciledItems = reconcilePublicCatalogItems(items, 'video')
        setAlbums(reconciledItems)
        setNextCursor(cursor)
        setCatalogSnapshot(CATALOG_KEY, { items: reconciledItems, nextCursor: cursor })
    }, [])

    useEffect(() => {
        if (initialSnapshot && !initialSnapshot.stale) return undefined
        const controller = new AbortController()
        fetchAlbumsPage({ visibility: 'public', type: 'video', limit: PAGE_SIZE }, { signal: controller.signal })
            .then((page) => savePage(page.items, page.nextCursor))
            .catch((requestError) => {
                if (requestError.name !== 'AbortError') setError(requestError.message || 'Videos could not be loaded.')
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false)
            })
        return () => controller.abort()
    }, [initialSnapshot, savePage])

    useEffect(() => {
        const hero = heroRef.current
        if (!hero || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined
        let frame = null
        const update = () => {
            frame = null
            hero.style.transform = `translateY(${Math.min(Math.max(0, window.scrollY) * 0.15, 60)}px)`
        }
        const onScroll = () => {
            if (frame === null) frame = window.requestAnimationFrame(update)
        }
        window.addEventListener('scroll', onScroll, { passive: true })
        return () => {
            window.removeEventListener('scroll', onScroll)
            if (frame !== null) window.cancelAnimationFrame(frame)
        }
    }, [])

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
            if (isRevealed(element.dataset.revealId)) element.classList.add('is-visible', 'no-stagger')
            else observer.observe(element)
        }
        return () => observer.disconnect()
    }, [albums])

    const videoAlbums = useMemo(() => albums.filter((album) => album.type === 'video'), [albums])
    const { groupedVideoAlbums, curatedVideoCategories } = useMemo(() => {
        const grouped = videoAlbums.reduce((result, album) => {
            const category = album.category || 'Uncategorized'
            if (!result[category]) result[category] = []
            result[category].push(album)
            return result
        }, {})
        for (const category of Object.keys(grouped)) {
            grouped[category] = sortGalleryAlbums(grouped[category])
        }
        const categories = sortGalleryCategories(Object.keys(grouped), grouped)
        return { groupedVideoAlbums: grouped, curatedVideoCategories: categories }
    }, [videoAlbums])
    const videoCategories = useMemo(() => (
        sortVideoSections(curatedVideoCategories, groupedVideoAlbums, sectionSort)
    ), [curatedVideoCategories, groupedVideoAlbums, sectionSort])
    const managedHeroUrl = cdnUrl('site/hero/video/home')
    const responsiveHeroUrl = currentVideoHeroUrl()
    const useResponsiveHero = Boolean(responsiveHeroUrl) && !responsiveHeroFailed
    const useBundledHero = !useResponsiveHero && (!managedHeroUrl || managedHeroFailed)
    const heroSrc = useResponsiveHero
        ? responsiveHeroUrl
        : (useBundledHero ? '/images/heroes/video-1280.jpg' : managedHeroUrl)
    const heroSrcSet = useResponsiveHero
        ? currentVideoHeroSrcSet()
        : (useBundledHero ? heroSet('jpg') : undefined)

    const loadMore = async () => {
        if (!nextCursor || loadingMore) return
        setLoadingMore(true)
        setError(null)
        try {
            const page = await fetchAlbumsPage({ visibility: 'public', type: 'video', limit: PAGE_SIZE, cursor: nextCursor })
            savePage(mergeUniqueById(albums, page.items), page.nextCursor)
        } catch (requestError) {
            setError(requestError.message || 'More videos could not be loaded.')
        } finally {
            setLoadingMore(false)
        }
    }

    return (
        <div ref={pageRef} className="animate-fade-in">
            <section className="linen-video-hero relative overflow-hidden">
                <div className="absolute inset-0 overflow-hidden">
                    <picture>
                        {useResponsiveHero ? (
                            <>
                                <source type="image/avif" srcSet={currentVideoHeroSrcSet('avif')} sizes="100vw" />
                                <source type="image/webp" srcSet={currentVideoHeroSrcSet('webp')} sizes="100vw" />
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
                            width={useBundledHero ? 6177 : 1280}
                            height={useBundledHero ? 4118 : 853}
                            alt="Cinematography"
                            fetchPriority="high"
                            loading="eager"
                            decoding="async"
                            onError={() => {
                                if (useResponsiveHero) setResponsiveHeroFailed(true)
                                else if (!useBundledHero) setManagedHeroFailed(true)
                            }}
                            className="w-full h-[110%] object-cover object-center parallax-hero"
                        />
                    </picture>
                    <div className="absolute inset-0 bg-gradient-to-b from-charcoal/60 via-charcoal/40 to-cream" />
                </div>
                <div className="relative max-w-7xl mx-auto px-6 py-32 md:py-48">
                    <div className="max-w-2xl animate-fade-in">
                        <h1 className="font-serif text-5xl md:text-7xl font-normal text-white leading-tight tracking-tight w-fit">Videography</h1>
                        <p className="mt-6 text-lg text-white/90 font-light leading-relaxed">Short films, moving portraits and moments gathered in motion.</p>
                    </div>
                </div>
            </section>

            <section className="linen-catalog-paper">
                <div className="max-w-7xl mx-auto px-6 py-16 md:py-24">
                    <div data-reveal-id="video-projects-header" className="linen-section-heading mb-14 scroll-animate">
                        <span>Film index</span>
                        <h2 className="font-serif text-4xl md:text-5xl font-normal text-charcoal">Video Projects</h2>
                        <label className="w-full" htmlFor="video-section-sort">
                            <span className="linen-category-number block mb-1">Sort sections</span>
                            <span className="relative block">
                                <select
                                    id="video-section-sort"
                                    aria-label="Sort video sections"
                                    value={sectionSort}
                                    onChange={(event) => setSectionSort(Number(event.target.value))}
                                    className="w-full py-2 px-4 border-0 border-b border-charcoal rounded-none text-charcoal bg-transparent text-xs font-medium tracking-wider uppercase cursor-pointer focus:outline-none"
                                    style={{ WebkitAppearance: 'none', appearance: 'none', background: 'transparent' }}
                                >
                                    {VIDEO_SECTION_SORT_OPTIONS.map((option, index) => (
                                        <option key={option} value={index}>{option}</option>
                                    ))}
                                </select>
                                <span aria-hidden="true" className="absolute right-0 top-1/2 -translate-y-1/2 text-amber-dark pointer-events-none text-base">⌄</span>
                            </span>
                        </label>
                    </div>

                    {loading && <SkeletonGrid count={6} type="video" />}
                    {error && <div className="text-center py-8 text-red-700" role="alert"><p>{error}</p></div>}

                    {!loading && videoCategories.map((category, categoryIndex) => {
                        const sectionId = `video-cat-${category.toLowerCase().replace(/\s+/g, '-')}`
                        return (
                            <div key={category} data-reveal-id={sectionId} className="mb-16 scroll-animate catalog-section" style={{ transitionDelay: `${Math.min(categoryIndex, 4) * 80}ms` }}>
                                <div className="flex items-center gap-4 mb-8">
                                    <span className="linen-category-number">{String(categoryIndex + 1).padStart(2, '0')}</span>
                                    <h3 className="font-serif text-2xl font-normal text-charcoal">{category}</h3>
                                    <div className="h-px bg-warm-border flex-1" />
                                </div>
                                <ScrollRow scrollKey={`videos-${category}`}>
                                    {groupedVideoAlbums[category].map((album) => (
                                        <div key={album.albumId} className="shrink-0 w-[280px] sm:w-[320px] md:w-[360px] snap-start stagger-child">
                                            <VideoAlbumCard album={album} />
                                        </div>
                                    ))}
                                </ScrollRow>
                            </div>
                        )
                    })}

                    {!loading && videoAlbums.length === 0 && !error && (
                        <div className="text-center py-12 text-warm-gray"><p>No video projects found.</p></div>
                    )}
                    {nextCursor && (
                        <div className="flex justify-center pt-2">
                            <button type="button" onClick={loadMore} disabled={loadingMore} className="px-6 py-3 rounded-xl bg-charcoal text-white hover:bg-charcoal-light transition-colors disabled:opacity-60">
                                {loadingMore ? 'Loading…' : 'Load more videos'}
                            </button>
                        </div>
                    )}
                </div>
            </section>
        </div>
    )
}
