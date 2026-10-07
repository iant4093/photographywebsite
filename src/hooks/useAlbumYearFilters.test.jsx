import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { expect, it } from 'vitest'
import useAlbumYearFilters from './useAlbumYearFilters'

function Catalog({ grouped }) {
    const { sections, setCategoryYear } = useAlbumYearFilters(grouped)
    return Object.entries(sections).map(([category, section]) => <section key={category}>
        <select aria-label={`${category} year`} value={section.year} onChange={event => setCategoryYear(category, event.target.value)}>
            {section.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <p data-testid={category}>{section.albums.map(album => album.albumId).join(',')}</p>
    </section>)
}

it('filters by displayed date, preserves album order and keeps other categories unchanged', () => {
    const grouped = {
        Hikes: [
            { albumId: 'newer', createdAt: '2026-06-01T12:00:00Z' },
            { albumId: 'old', createdAt: '2025-06-01T12:00:00Z', uploadedAt: '2026-06-02T12:00:00Z' },
            { albumId: 'invalid', createdAt: 'bad' },
            { albumId: 'new', createdAt: '2026-05-01T12:00:00Z' },
        ],
        Birds: [{ albumId: 'bird', createdAt: '2024-05-01T12:00:00Z' }],
    }
    render(<MemoryRouter><Catalog grouped={grouped} /></MemoryRouter>)
    expect(screen.getByTestId('Hikes')).toHaveTextContent('newer,old,invalid,new')
    fireEvent.change(screen.getByLabelText('Hikes year'), { target: { value: '2026' } })
    expect(screen.getByTestId('Hikes')).toHaveTextContent('newer,new')
    expect(screen.getByTestId('Birds')).toHaveTextContent('bird')
    fireEvent.change(screen.getByLabelText('Hikes year'), { target: { value: '2025' } })
    expect(screen.getByTestId('Hikes')).toHaveTextContent('old')
    fireEvent.change(screen.getByLabelText('Hikes year'), { target: { value: 'all' } })
    expect(screen.getByTestId('Hikes')).toHaveTextContent('newer,old,invalid,new')
})

it('returns to all albums when updated data removes the selected year', () => {
    const view = render(<MemoryRouter><Catalog grouped={{ Hikes: [{ albumId: 'old', createdAt: '2025-06-01T12:00:00Z' }] }} /></MemoryRouter>)
    fireEvent.change(screen.getByLabelText('Hikes year'), { target: { value: '2025' } })
    view.rerender(<MemoryRouter><Catalog grouped={{ Hikes: [{ albumId: 'new', createdAt: '2026-06-01T12:00:00Z' }] }} /></MemoryRouter>)
    expect(screen.getByLabelText('Hikes year')).toHaveValue('all')
    expect(screen.getByTestId('Hikes')).toHaveTextContent('new')
})
