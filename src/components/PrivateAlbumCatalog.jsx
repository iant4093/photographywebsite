import { useId, useMemo, useState } from 'react'
import AlbumCard from './AlbumCard'
import ScrollRow from './ScrollRow'
import SiteSelect from './SiteSelect'
import useAlbumYearFilters from '../hooks/useAlbumYearFilters'
import { sortGalleryAlbums, sortGalleryCategories } from '../utils/galleryOrder'
import { HOME_SECTION_SORT_OPTIONS, sortHomePhotoSections } from '../utils/homeSectionSort'
import { markAsRevealed } from '../utils/scroll'

// Everything here is derived from the authenticated owner's catalog. Public
// section stats and discovery endpoints must not be used for private galleries.
export default function PrivateAlbumCatalog({ albums, mediaType, onOpen, onMediaError }) {
    const id = useId()
    const [sort, setSort] = useState(0)
    const grouped = useMemo(() => {
        const result = Object.create(null)
        for (const album of albums) (result[album.category || 'Uncategorized'] ||= []).push(album)
        for (const category of Object.keys(result)) result[category] = sortGalleryAlbums(result[category])
        return result
    }, [albums])
    const categories = useMemo(() => sortHomePhotoSections(
        sortGalleryCategories(Object.keys(grouped), grouped), grouped, sort,
    ), [grouped, sort])
    const { sections, setCategoryYear } = useAlbumYearFilters(grouped)
    const mediaLabel = mediaType === 'video' ? 'videos' : 'photos'
    const shuffleSection = category => {
        const candidates = grouped[category].filter(album => album.imageCount !== 0)
        const total = candidates.reduce((sum, album) => sum + Math.max(1, Number(album.imageCount) || 1), 0)
        let position = Math.random() * total
        const selected = candidates.find(album => {
            position -= Math.max(1, Number(album.imageCount) || 1)
            return position < 0
        })
        if (selected) onOpen(selected, { randomPhoto: true })
    }
    return <div>
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <nav aria-label={`Your ${mediaLabel} sections`} className="flex flex-wrap gap-2">
                {categories.map(category => <button key={category} type="button"
                    onClick={() => document.getElementById(`${id}-${category}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                    className="rounded-full border border-warm-border px-3 py-1.5 text-sm text-warm-gray hover:text-amber hover:border-amber transition-colors">
                    {category}
                </button>)}
            </nav>
            <div className="w-full sm:w-56">
                <label htmlFor={`${id}-sort`} className="linen-category-number block mb-2">Sort sections</label>
                <SiteSelect id={`${id}-sort`} aria-label={`Sort ${mediaLabel} sections`} value={sort}
                    onChange={value => setSort(Number(value))}
                    options={HOME_SECTION_SORT_OPTIONS.map((label, value) => ({ value, label: label.replace('photo albums', `${mediaType} albums`) }))} />
            </div>
        </div>
        <div className="flex flex-col gap-8">
            {categories.map((category, categoryIndex) => {
                const { albums: visibleAlbums, year, options } = sections[category]
                const itemCount = grouped[category].reduce((count, album) => count + (Number(album.imageCount) || 0), 0)
                return <section key={category} id={`${id}-${category}`} className="scroll-mt-28" aria-label={`${category} ${mediaLabel}`}>
                    <div className="flex flex-wrap items-center gap-3 sm:gap-4 mb-6">
                        <span className="linen-category-number">{String(categoryIndex + 1).padStart(2, '0')}</span>
                        <h3 className="font-serif text-2xl font-normal text-charcoal min-w-0 [overflow-wrap:anywhere]">{category}</h3>
                        {mediaType === 'photo' && <button type="button" className="linen-theme-toggle"
                            aria-label={`Shuffle ${category} photos`} title={`Shuffle ${category} photos`}
                            disabled={!grouped[category].some(album => album.imageCount !== 0)}
                            onClick={() => shuffleSection(category)}>
                            <svg className="linen-theme-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                                <path d="M3 7h3c4 0 8 10 12 10h3M17 13l4 4-4 4M3 17h3c1.5 0 3-1.5 4.5-3.5M13.5 10.5C15 8.5 16.5 7 18 7h3M17 3l4 4-4 4" />
                            </svg>
                        </button>}
                        <details className="relative">
                            <summary aria-label={`Show ${category} ${mediaLabel} statistics`} className="linen-theme-toggle cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                                <svg className="linen-theme-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7v1" /></svg>
                            </summary>
                            <p className="absolute left-0 top-full z-10 mt-2 w-48 rounded-xl border border-warm-border bg-cream p-4 text-sm text-warm-gray shadow-warm-sm">
                                {grouped[category].length} albums · {itemCount} {mediaLabel}
                            </p>
                        </details>
                        <div className="hidden sm:block h-px bg-warm-border flex-1" />
                        <SiteSelect aria-label={`Filter ${category} ${mediaLabel} albums by year`} value={year}
                            onChange={value => setCategoryYear(category, value)} options={options}
                            className="ml-auto w-28 sm:w-32 shrink-0 text-sm" />
                    </div>
                    <ScrollRow key={year} scrollKey={`user-${mediaType}-${category}${year === 'all' ? '' : `-year-${year}`}`}>
                        {visibleAlbums.map(album => <div key={album.albumId} className="shrink-0 w-[280px] sm:w-[320px] md:w-[340px] snap-start stagger-child">
                            <AlbumCard album={album} onOpen={() => onOpen(album)} onImageError={onMediaError}
                                onMouseEnter={() => markAsRevealed(`user-album-${album.albumId}`)} />
                        </div>)}
                    </ScrollRow>
                </section>
            })}
        </div>
    </div>
}
