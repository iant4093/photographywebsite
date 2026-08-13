import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'

import Privacy from './Privacy'

describe('Privacy notice analytics controls', () => {
    beforeEach(() => localStorage.clear())

    it('discloses aggregate analytics and stores an opt-out choice', () => {
        render(<MemoryRouter><Privacy /></MemoryRouter>)
        expect(screen.getByRole('heading', { name: 'Aggregate website analytics' })).toBeInTheDocument()
        expect(screen.getByText(/Analytics records do not store cookies/i)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Opt out' }))
        expect(screen.getByText(/Current setting:/)).toHaveTextContent('Aggregate analytics disabled')
        expect(localStorage.getItem('ian-photography-analytics')).toBe('disabled')
    })
})
