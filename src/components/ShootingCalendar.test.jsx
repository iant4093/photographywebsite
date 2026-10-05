import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import ShootingCalendar from './ShootingCalendar'

const calendar = {
    albums: ['trip', 'walk', 'gone'],
    days: [
        ['2025-06-01', 3, 0, [1]],
        ['2026-01-01', 10, 0, [0]],
        ['2026-01-02', 2, 1, [0, 1]],
        ['2026-01-03', 30, 0, [2]],
    ],
}
const albums = [
    { albumId: 'trip', title: 'Prague', category: 'Travel', type: 'photo', coverImageUrl: 'https://cdn.test/prague.jpg' },
    { albumId: 'walk', title: 'Morning walk', type: 'video' },
]

function mounted() {
    return render(
        <MemoryRouter>
            <ShootingCalendar calendar={calendar} albums={albums} routeFor={(album) => `/album/${album.albumId}`} today={new Date(2026, 0, 10)} />
        </MemoryRouter>,
    )
}

describe('ShootingCalendar', () => {
    it('shows the latest year with a summary and one button per shooting day', () => {
        mounted()
        expect(screen.getByRole('button', { name: '2026' })).toHaveAttribute('aria-pressed', 'true')
        const summary = screen.getByText('Days shooting').closest('dl')
        expect(within(summary).getByText('3')).toBeInTheDocument()
        expect(within(summary).getByText('3 days')).toBeInTheDocument()
        expect(within(summary).getByText('42 photos · 1 video')).toBeInTheDocument()
        const days = within(screen.getByRole('group', { name: 'Shooting days in 2026' })).getAllByRole('button')
        expect(days).toHaveLength(3)
        expect(days[0]).toHaveAccessibleName('Thursday, January 1, 2026: 10 photos')
        expect(screen.getByText('Pick a day to see what was shot.')).toBeInTheDocument()
    })

    it('lists the albums shot on a picked day, and toggles it off again', () => {
        mounted()
        const day = screen.getByRole('button', { name: 'Friday, January 2, 2026: 2 photos · 1 video' })
        fireEvent.click(day)
        expect(day).toHaveAttribute('aria-pressed', 'true')
        expect(screen.getByRole('heading', { name: 'Friday, January 2, 2026' })).toBeInTheDocument()
        expect(screen.getByRole('link', { name: /Prague/ })).toHaveAttribute('href', '/album/trip')
        expect(screen.getByRole('link', { name: /Morning walk/ })).toHaveTextContent('Video')
        fireEvent.click(day)
        expect(screen.getByText('Pick a day to see what was shot.')).toBeInTheDocument()
    })

    it('jumps to the busiest day, explains albums that are no longer public, and switches years', () => {
        mounted()
        fireEvent.click(screen.getByRole('button', { name: 'Jan 3' }))
        expect(screen.getByRole('heading', { name: 'Saturday, January 3, 2026' })).toBeInTheDocument()
        expect(screen.getByText('These albums are no longer public.')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: '2025' }))
        expect(screen.getByText('Pick a day to see what was shot.')).toBeInTheDocument()
        expect(within(screen.getByRole('group', { name: 'Shooting days in 2025' })).getAllByRole('button')).toHaveLength(1)
    })

    it('renders nothing without any shooting days', () => {
        const { container } = render(<MemoryRouter><ShootingCalendar calendar={{ albums: [], days: [] }} albums={[]} routeFor={() => '/'} /></MemoryRouter>)
        expect(container).toBeEmptyDOMElement()
    })
})
