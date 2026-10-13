import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'
import Utilities, { UtilityComingSoon } from './Utilities'
import DocumentMetadata from '../components/DocumentMetadata'

function renderUtilities(path = '/utilities') {
    return render(
        <MemoryRouter initialEntries={[path]}>
            <DocumentMetadata />
            <Routes>
                <Route path="/utilities" element={<Utilities />} />
                <Route path="/editor" element={<h1>Existing photo editor</h1>} />
                <Route path="/utilities/truongroom" element={<UtilityComingSoon moduleId="truongroom" />} />
                <Route path="/utilities/truongcam" element={<UtilityComingSoon moduleId="truongcam" />} />
            </Routes>
        </MemoryRouter>,
    )
}

describe('Utilities navigation', () => {
    it('opens the existing editor from the available Web Editor module', () => {
        renderUtilities()
        expect(screen.getByRole('heading', { name: 'Utilities' })).toBeInTheDocument()
        const modules = screen.getByRole('region', { name: 'Utilities modules' })
        expect(within(modules).getAllByRole('link')).toHaveLength(3)
        fireEvent.click(within(modules).getByRole('link', { name: /Web Editor/ }))
        expect(screen.getByRole('heading', { name: 'Existing photo editor' })).toBeInTheDocument()
    })

    it.each(['TruongRoom', 'TruongCam'])('opens %s, then returns to the modules', title => {
        renderUtilities()
        fireEvent.click(screen.getByRole('link', { name: new RegExp(title) }))
        expect(screen.getByRole('heading', { name: title })).toBeInTheDocument()
        expect(screen.getByText('Coming soon')).toBeInTheDocument()
        expect(document.title).toBe(`${title} — Coming Soon | Ian Truong Photography`)
        fireEvent.click(screen.getByRole('link', { name: /All Utilities modules/ }))
        expect(screen.getByRole('heading', { name: 'Utilities' })).toBeInTheDocument()
        expect(document.title).toBe('Utilities | Ian Truong Photography')
    })

    it.each(['truongroom', 'truongcam'])('supports opening /utilities/%s directly and trying the editor', moduleId => {
        renderUtilities(`/utilities/${moduleId}`)
        expect(screen.getByText('Coming soon')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('link', { name: /Try Web Editor/ }))
        expect(screen.getByRole('heading', { name: 'Existing photo editor' })).toBeInTheDocument()
    })
})
