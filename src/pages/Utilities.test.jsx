import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'
import TruongCam from './TruongCam'
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
                <Route path="/utilities/truongcam" element={<TruongCam />} />
                <Route path="/utilities/truongnoiser" element={<UtilityComingSoon moduleId="truongnoiser" />} />
                <Route path="/utilities/truongscaler" element={<UtilityComingSoon moduleId="truongscaler" />} />
            </Routes>
        </MemoryRouter>,
    )
}

describe('Utilities navigation', () => {
    it('opens the launched camera with the repository download and installation details', () => {
        renderUtilities()
        fireEvent.click(screen.getByRole('link', { name: /TruongCam/ }))
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('TruongCam')
        expect(screen.getByRole('link', { name: /Download for iPhone/ })).toHaveAttribute('href', 'https://github.com/iant4093/TruongCam/releases/latest/download/TruongCam.ipa')
        expect(screen.getByRole('link', { name: /View on GitHub/ })).toHaveAttribute('href', 'https://github.com/iant4093/TruongCam')
        expect(screen.getByText(/iOS 27.*Unsigned IPA.*Signing required/)).toBeInTheDocument()
        expect(document.title).toBe('TruongCam — RAW Camera for iPhone | Ian Truong Photography')
    })

    it('opens the existing editor from the available Web Editor module', () => {
        renderUtilities()
        expect(screen.getByRole('heading', { name: 'Utilities' })).toBeInTheDocument()
        const modules = screen.getByRole('region', { name: 'Utilities modules' })
        expect(within(modules).getAllByRole('link')).toHaveLength(5)
        fireEvent.click(within(modules).getByRole('link', { name: /Web Editor/ }))
        expect(screen.getByRole('heading', { name: 'Existing photo editor' })).toBeInTheDocument()
    })

    it.each(['TruongRoom', 'TruongNoiser', 'TruongScaler'])('opens %s, then returns to the modules', title => {
        renderUtilities()
        fireEvent.click(screen.getByRole('link', { name: new RegExp(title) }))
        expect(screen.getByRole('heading', { name: title })).toBeInTheDocument()
        expect(screen.getByText('Coming soon')).toBeInTheDocument()
        expect(document.title).toBe(`${title} — Coming Soon | Ian Truong Photography`)
        fireEvent.click(screen.getByRole('link', { name: /All Utilities modules/ }))
        expect(screen.getByRole('heading', { name: 'Utilities' })).toBeInTheDocument()
        expect(document.title).toBe('Utilities | Ian Truong Photography')
    })

    it.each(['truongroom', 'truongnoiser', 'truongscaler'])('supports opening /utilities/%s directly and trying the editor', moduleId => {
        renderUtilities(`/utilities/${moduleId}`)
        expect(screen.getByText('Coming soon')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('link', { name: /Try Web Editor/ }))
        expect(screen.getByRole('heading', { name: 'Existing photo editor' })).toBeInTheDocument()
    })
})
