import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import AlbumCard from '../components/AlbumCard'
import VideoAlbumCard from '../components/VideoAlbumCard'
import SiteSelect from '../components/SiteSelect'
import SkeletonGrid from '../components/SkeletonGrid'
import useAlbumYearFilters from '../hooks/useAlbumYearFilters'
import { fetchAlbumsPage } from '../utils/api'
import { CatalogPaginationError, deleteCatalogSnapshot, getCatalogSnapshot, loadCompleteCatalog, reconcilePublicCatalogItems, setCatalogSnapshot } from '../utils/catalogState'
import { sortGalleryAlbums } from '../utils/galleryOrder'
import { navigateBackOr } from '../utils/navigation'
import './SectionAlbums.css'

const FeaturedPhotoExplorer = lazy(() => import('../components/FeaturedPhotoExplorer'))
const RandomPhotoExplorer = lazy(() => import('../components/RandomPhotoExplorer'))
const EMPTY = []

export default function SectionAlbums() {
    const { mediaType, category } = useParams()
    const navigate = useNavigate()
    const validType = mediaType === 'photo' || mediaType === 'video'
    const catalogKey = mediaType === 'video' ? 'public-videos' : 'public-photos'
    const [state, setState] = useState(() => ({ key: catalogKey, items: getCatalogSnapshot(catalogKey)?.items || [] }))
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [attempt, setAttempt] = useState(0)
    const items = state.key === catalogKey ? state.items : EMPTY
    const grouped = useMemo(() => ({
        [category]: sortGalleryAlbums(items.filter(album => (
            (album.category || 'Uncategorized') === category
            && (mediaType === 'video' ? album.type === 'video' : album.type !== 'video')
            && (album.visibility === undefined || album.visibility === 'public')
        ))),
    }), [items, category, mediaType])
    const { sections, setCategoryYear } = useAlbumYearFilters(grouped)
    const { albums, year, options } = sections[category]
    const label = mediaType === 'video' ? 'Video' : 'Photo'
    const back = mediaType === 'video' ? '/videos' : '/#photo-albums'

    useEffect(() => {
        if (!validType) return undefined
        const controller = new AbortController()
        const snapshot = getCatalogSnapshot(catalogKey)
        const fresh = Boolean(snapshot && !snapshot.stale)
        Promise.resolve().then(() => {
            if (controller.signal.aborted) return
            setLoading(true)
            setError('')
            return loadCompleteCatalog({
                fetchPage: cursor => fetchAlbumsPage({ visibility: 'public', type: mediaType, limit: 100, cursor }, { signal: controller.signal }),
                initialItems: fresh ? snapshot.items : [],
                initialCursor: fresh ? snapshot.nextCursor : null,
                hasInitialPage: fresh,
                signal: controller.signal,
                onPage: ({ items: page, nextCursor }) => {
                    const reconciled = reconcilePublicCatalogItems(page, mediaType)
                    setState({ key: catalogKey, items: reconciled })
                    setCatalogSnapshot(catalogKey, { items: reconciled, nextCursor })
                },
            })
        }).then(({ items: page } = {}) => {
            if (!controller.signal.aborted) setState({ key: catalogKey, items: reconcilePublicCatalogItems(page, mediaType) })
        }).catch(error => {
            if (controller.signal.aborted || error.name === 'AbortError') return
            if (error instanceof CatalogPaginationError || ['BAD_CURSOR', 'REPEATED_CURSOR'].includes(error.code)) deleteCatalogSnapshot(catalogKey)
            setError(error.message || 'Albums could not be loaded.')
        }).finally(() => {
            if (!controller.signal.aborted) setLoading(false)
        })
        return () => controller.abort()
    }, [attempt, catalogKey, mediaType, validType])

    if (!validType) return <div className="max-w-7xl mx-auto px-6 pt-32 pb-24">
        <h1 className="font-serif text-4xl">Section not found</h1>
        <Link to="/" className="linen-text-link">Browse photo albums</Link>
    </div>

    return <div className="max-w-7xl mx-auto px-6 pt-28 pb-20 md:pt-36 md:pb-28" aria-busy={loading}>
        <button type="button" onClick={() => navigateBackOr(navigate, back)} className="linen-gallery-back mb-10 inline-flex items-center gap-2 text-sm text-warm-gray hover:text-amber cursor-pointer">
            <span aria-hidden="true">←</span> All {label.toLowerCase()} albums
        </button>
        <header className="linen-section-heading mb-10">
            <span>{label} collection</span>
            <h1 className="font-serif text-4xl md:text-6xl text-charcoal [overflow-wrap:anywhere]">{category}</h1>
            <p>{grouped[category].length} {grouped[category].length === 1 ? 'album' : 'albums'}</p>
        </header>
        <div className="mb-8 flex flex-wrap items-center gap-x-6 gap-y-5">
            {mediaType === 'photo' && <div key={category} className="section-photo-actions" role="group" aria-label={`${category} photo tools`}>
                <Suspense fallback={<><span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" /></>}>
                    <FeaturedPhotoExplorer category={category} variant="icon" showLabel />
                    <RandomPhotoExplorer category={category} variant="icon" showStats showLabel />
                </Suspense>
            </div>}
            <div className="flex min-w-0 flex-1 basis-64 items-center justify-between gap-4">
                <p className="text-sm text-warm-gray">{year === 'all' ? 'All years' : year} · {albums.length} {albums.length === 1 ? 'album' : 'albums'}</p>
                <SiteSelect aria-label={`Filter ${category} albums by year`} value={year} onChange={value => setCategoryYear(category, value)} options={options} className="w-32 shrink-0" />
            </div>
        </div>
        {loading && !albums.length && <SkeletonGrid count={6} type={mediaType} />}
        {error && <div role="alert" className="mb-8 text-red-700"><p>{error}</p><button type="button" onClick={() => setAttempt(value => value + 1)} className="mt-3 underline cursor-pointer">Try again</button></div>}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-10">
            {albums.map(album => mediaType === 'video'
                ? <VideoAlbumCard key={album.albumId} album={album} />
                : <AlbumCard key={album.albumId} album={album} showNewFlag preview imageSizes="(max-width: 639px) calc(100vw - 3rem), (max-width: 1023px) 50vw, 400px" />)}
        </div>
        {!loading && !error && !albums.length && <p className="py-12 text-warm-gray">No {label.toLowerCase()} albums in this section yet.</p>}
    </div>
}
