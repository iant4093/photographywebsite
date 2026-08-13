import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import AlbumCard from '../components/AlbumCard'
import SkeletonGrid from '../components/SkeletonGrid'
import { fetchAlbumsPage } from '../utils/api'
import './Search.css'
import {
    CatalogPaginationError,
    deleteCatalogSnapshot,
    getCatalogSnapshot,
    loadCompleteCatalog,
    reconcilePublicCatalogItems,
    setCatalogSnapshot,
} from '../utils/catalogState'

const PAGE_SIZE = 100
const CATALOGS = [
    { key: 'public-photos', type: 'photo' },
    { key: 'public-videos', type: 'video' },
]
const TYPE_OPTIONS = new Set(['all', 'photo', 'video'])
const SORT_OPTIONS = new Set(['newest', 'oldest', 'title'])
const SEARCH_CARD_SIZES = '(max-width: 720px) calc(100vw - 3rem), (max-width: 1080px) 50vw, (min-width: 1440px) 520px, 400px'

function initialCatalogs() {
    return Object.fromEntries(CATALOGS.map(({ key, type }) => {
        const snapshot = getCatalogSnapshot(key)
        return [type, snapshot?.items || []]
    }))
}

function normalizeSearchValue(value) {
    return String(value || '').trim().toLocaleLowerCase()
}

function albumTimestamp(album) {
    const timestamp = Date.parse(album?.createdAt || '')
    return Number.isFinite(timestamp) ? timestamp : 0
}

function albumYear(album) {
    const timestamp = albumTimestamp(album)
    return timestamp ? String(new Date(timestamp).getFullYear()) : ''
}

function mergeCatalogs(catalogs) {
    const unique = new Map()
    for (const album of [...(catalogs.photo || []), ...(catalogs.video || [])]) {
        if (album?.albumId) unique.set(album.albumId, album)
    }
    return [...unique.values()]
}

export default function Search() {
    const [searchParams, setSearchParams] = useSearchParams()
    const [albumsByType, setAlbumsByType] = useState(initialCatalogs)
    const [loading, setLoading] = useState(() => CATALOGS.some(({ key }) => {
        const snapshot = getCatalogSnapshot(key)
        return !snapshot || snapshot.stale || Boolean(snapshot.nextCursor)
    }))
    const [error, setError] = useState(null)
    const [loadAttempt, setLoadAttempt] = useState(0)

    useEffect(() => {
        const controller = new AbortController()

        const loadCatalog = async ({ key, type }) => {
            const snapshot = getCatalogSnapshot(key)
            const hasFreshSnapshot = Boolean(snapshot && !snapshot.stale)
            const save = ({ items, nextCursor }) => {
                const reconciled = reconcilePublicCatalogItems(items, type)
                setCatalogSnapshot(key, { items: reconciled, nextCursor })
                setAlbumsByType((current) => ({ ...current, [type]: reconciled }))
            }

            try {
                const result = await loadCompleteCatalog({
                    fetchPage: (cursor) => fetchAlbumsPage({
                        visibility: 'public',
                        type,
                        limit: PAGE_SIZE,
                        cursor,
                    }, { signal: controller.signal }),
                    initialItems: hasFreshSnapshot ? snapshot.items : [],
                    initialCursor: hasFreshSnapshot ? snapshot.nextCursor : null,
                    hasInitialPage: hasFreshSnapshot,
                    signal: controller.signal,
                    onPage: save,
                })
                if (!controller.signal.aborted) save(result)
            } catch (requestError) {
                if (
                    requestError instanceof CatalogPaginationError
                    || ['BAD_CURSOR', 'REPEATED_CURSOR'].includes(requestError?.code)
                ) {
                    deleteCatalogSnapshot(key)
                }
                throw requestError
            }
        }

        Promise.allSettled(CATALOGS.map(loadCatalog))
            .then((results) => {
                if (controller.signal.aborted) return
                const failure = results.find(({ status, reason }) => (
                    status === 'rejected' && reason?.name !== 'AbortError'
                ))
                if (failure) {
                    setError(failure.reason?.message || 'Part of the archive could not be loaded.')
                }
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false)
            })

        return () => controller.abort()
    }, [loadAttempt])

    const albums = useMemo(() => mergeCatalogs(albumsByType), [albumsByType])
    const categories = useMemo(() => [...new Set(
        albums.map((album) => album.category || 'Uncategorized'),
    )].sort((left, right) => {
        if (left === 'Uncategorized') return 1
        if (right === 'Uncategorized') return -1
        return left.localeCompare(right)
    }), [albums])
    const years = useMemo(() => [...new Set(albums.map(albumYear).filter(Boolean))]
        .sort((left, right) => Number(right) - Number(left)), [albums])

    const query = searchParams.get('q') || ''
    const requestedType = searchParams.get('type') || 'all'
    const type = TYPE_OPTIONS.has(requestedType) ? requestedType : 'all'
    const requestedSort = searchParams.get('sort') || 'newest'
    const sort = SORT_OPTIONS.has(requestedSort) ? requestedSort : 'newest'
    const category = categories.includes(searchParams.get('category')) ? searchParams.get('category') : 'all'
    const year = years.includes(searchParams.get('year')) ? searchParams.get('year') : 'all'

    const results = useMemo(() => {
        const needle = normalizeSearchValue(query)
        return albums
            .filter((album) => {
                if (type === 'video' && album.type !== 'video') return false
                if (type === 'photo' && album.type === 'video') return false
                if (category !== 'all' && (album.category || 'Uncategorized') !== category) return false
                if (year !== 'all' && albumYear(album) !== year) return false
                if (!needle) return true
                return [album.title, album.description, album.category]
                    .some((value) => normalizeSearchValue(value).includes(needle))
            })
            .sort((left, right) => {
                if (sort === 'title') {
                    return String(left.title || '').localeCompare(String(right.title || ''), undefined, {
                        sensitivity: 'base',
                    }) || String(left.albumId).localeCompare(String(right.albumId))
                }
                const direction = sort === 'oldest' ? 1 : -1
                return (albumTimestamp(left) - albumTimestamp(right)) * direction
                    || String(left.title || '').localeCompare(String(right.title || ''))
            })
    }, [albums, category, query, sort, type, year])

    const updateParam = (name, value, defaultValue = 'all') => {
        const next = new URLSearchParams(searchParams)
        if (!value || value === defaultValue) next.delete(name)
        else next.set(name, value)
        setSearchParams(next, { replace: true })
    }

    const clearFilters = () => setSearchParams({}, { replace: true })
    const hasFilters = Boolean(query.trim())
        || type !== 'all'
        || category !== 'all'
        || year !== 'all'
        || sort !== 'newest'

    return (
        <div className="archive-search-page animate-fade-in pt-[74px]">
            <header className="archive-search-header max-w-7xl mx-auto px-6 pt-14 pb-8 md:pt-20 md:pb-12">
                <div className="linen-section-heading">
                    <span>Archive search</span>
                    <h1 className="font-serif text-4xl md:text-6xl font-normal text-charcoal">Find a photograph or film</h1>
                    <p>Search every public photo and video album by title, description, category, or date.</p>
                </div>
            </header>

            <section className="max-w-7xl mx-auto px-6 pb-20 md:pb-28" aria-labelledby="archive-search-controls">
                <h2 id="archive-search-controls" className="sr-only">Search and filter the archive</h2>
                <div className="archive-search-controls">
                    <div className="archive-search-query">
                        <label htmlFor="archive-search-input">Search the archive</label>
                        <span className="archive-search-input-wrap">
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="m21 21-4.35-4.35m2.35-5.65a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" />
                            </svg>
                            <input
                                id="archive-search-input"
                                type="search"
                                value={query}
                                onChange={(event) => updateParam('q', event.target.value, '')}
                                placeholder="Try wildlife, Spain, portraits…"
                                autoComplete="off"
                            />
                            {query && (
                                <button type="button" onClick={() => updateParam('q', '', '')} aria-label="Clear search">
                                    Clear
                                </button>
                            )}
                        </span>
                    </div>

                    <div className="archive-search-filter-grid">
                        <label>
                            <span>Format</span>
                            <select value={type} onChange={(event) => updateParam('type', event.target.value)}>
                                <option value="all">Photos & videos</option>
                                <option value="photo">Photos</option>
                                <option value="video">Videos</option>
                            </select>
                        </label>
                        <label>
                            <span>Category</span>
                            <select value={category} onChange={(event) => updateParam('category', event.target.value)}>
                                <option value="all">All categories</option>
                                {categories.map((option) => <option key={option} value={option}>{option}</option>)}
                            </select>
                        </label>
                        <label>
                            <span>Year</span>
                            <select value={year} onChange={(event) => updateParam('year', event.target.value)}>
                                <option value="all">All years</option>
                                {years.map((option) => <option key={option} value={option}>{option}</option>)}
                            </select>
                        </label>
                        <label>
                            <span>Order</span>
                            <select value={sort} onChange={(event) => updateParam('sort', event.target.value, 'newest')}>
                                <option value="newest">Newest first</option>
                                <option value="oldest">Oldest first</option>
                                <option value="title">Title A–Z</option>
                            </select>
                        </label>
                    </div>
                </div>

                <div className="archive-search-summary" aria-live="polite">
                    <p>
                        <strong>{results.length}</strong> {results.length === 1 ? 'album' : 'albums'}
                        {query.trim() ? <> matching “{query.trim()}”</> : ' in the public archive'}
                    </p>
                    {hasFilters && <button type="button" onClick={clearFilters}>Reset search</button>}
                </div>

                {loading && albums.length === 0 && <SkeletonGrid count={6} />}
                {loading && albums.length > 0 && (
                    <p className="archive-search-loading" role="status">Refreshing the complete archive…</p>
                )}
                {error && (
                    <div className="archive-search-error" role="alert">
                        <p>{error}</p>
                        <button
                            type="button"
                            onClick={() => {
                                setError(null)
                                setLoading(true)
                                setLoadAttempt((attempt) => attempt + 1)
                            }}
                        >
                            Try again
                        </button>
                    </div>
                )}

                {results.length > 0 && (
                    <div className="archive-search-results">
                        {results.map((album) => (
                            <AlbumCard key={album.albumId} album={album} imageSizes={SEARCH_CARD_SIZES} />
                        ))}
                    </div>
                )}

                {!loading && !error && results.length === 0 && (
                    <div className="archive-search-empty">
                        <span aria-hidden="true">No. 00</span>
                        <h2>No albums found</h2>
                        <p>Try a broader phrase or reset the filters to browse the full archive.</p>
                        {hasFilters && <button type="button" onClick={clearFilters}>Show the full archive</button>}
                    </div>
                )}
            </section>
        </div>
    )
}
