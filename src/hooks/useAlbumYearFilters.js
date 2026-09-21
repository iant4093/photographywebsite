import { useMemo } from 'react'
import useNavigationState from './useNavigationState'

function albumYear(album) {
    const timestamp = Date.parse(album.createdAt || '')
    return Number.isFinite(timestamp) ? String(new Date(timestamp).getFullYear()) : ''
}

export default function useAlbumYearFilters(groupedAlbums, scope = 'albums') {
    const [selectedYears, setSelectedYears] = useNavigationState(`${scope}-years`, {})
    const sections = useMemo(() => Object.fromEntries(
        Object.entries(groupedAlbums).map(([category, albums]) => {
            // Use the album date shown on the cards, not its upload date.
            const datedAlbums = albums.map(album => ({ album, year: albumYear(album) }))
            const years = [...new Set(datedAlbums.map(({ year }) => year).filter(Boolean))]
                .sort((left, right) => Number(right) - Number(left))
            const selectedYear = selectedYears[category]
            const year = years.includes(selectedYear) ? selectedYear : 'all'
            return [category, {
                year,
                options: [{ value: 'all', label: 'All' }, ...years.map(value => ({ value, label: value }))],
                albums: year === 'all' ? albums : datedAlbums
                    .filter(item => item.year === year)
                    .map(({ album }) => album),
            }]
        }),
    ), [groupedAlbums, selectedYears])

    function setCategoryYear(category, year) {
        setSelectedYears(current => ({ ...current, [category]: year }))
    }

    return { sections, setCategoryYear }
}
