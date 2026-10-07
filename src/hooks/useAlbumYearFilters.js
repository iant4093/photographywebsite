import { useMemo } from 'react'
import useNavigationState from './useNavigationState'

function albumYear(album) {
    const timestamp = Date.parse(album.createdAt || '')
    return Number.isFinite(timestamp) ? String(new Date(timestamp).getFullYear()) : ''
}

export default function useAlbumYearFilters(groupedAlbums, scope = 'albums') {
    const [selectedYears, setSelectedYears] = useNavigationState(`${scope}-years`, {})
    // Parse dates and build each year's ordered albums only when data changes.
    // Changing one selector should not rebuild the entire catalog's year index.
    const yearIndex = useMemo(() => Object.fromEntries(
        Object.entries(groupedAlbums).map(([category, albums]) => {
            // Use the album date shown on the cards, not its upload date.
            const datedAlbums = albums.map(album => ({ album, year: albumYear(album) }))
            const years = [...new Set(datedAlbums.map(({ year }) => year).filter(Boolean))]
                .sort((left, right) => Number(right) - Number(left))
            const byYear = new Map(years.map(year => [year, []]))
            for (const item of datedAlbums) byYear.get(item.year)?.push(item.album)
            return [category, {
                albums,
                byYear,
                options: [{ value: 'all', label: 'All' }, ...years.map(value => ({ value, label: value }))],
            }]
        }),
    ), [groupedAlbums])
    const sections = useMemo(() => Object.fromEntries(
        Object.entries(yearIndex).map(([category, entry]) => {
            const selectedYear = selectedYears[category]
            const year = entry.byYear.has(selectedYear) ? selectedYear : 'all'
            return [category, {
                year,
                options: entry.options,
                albums: year === 'all' ? entry.albums : entry.byYear.get(year),
            }]
        }),
    ), [yearIndex, selectedYears])

    function setCategoryYear(category, year) {
        setSelectedYears(current => ({ ...current, [category]: year }))
    }

    return { sections, setCategoryYear }
}
