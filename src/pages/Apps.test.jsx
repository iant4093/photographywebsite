import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'
import TruongCam from './TruongCam'
import PhotoApp from './PhotoApp'
import Apps, { AppComingSoon } from './Apps'
import DocumentMetadata from '../components/DocumentMetadata'

function renderApps(path = '/apps') {
    return render(
        <MemoryRouter initialEntries={[path]}>
            <DocumentMetadata />
            <Routes>
                <Route path="/apps" element={<Apps />} />
                <Route path="/editor" element={<h1>Existing photo editor</h1>} />
                <Route path="/apps/truongroom" element={<AppComingSoon moduleId="truongroom" />} />
                <Route path="/apps/truongcam" element={<TruongCam />} />
                <Route path="/apps/truongnoiser" element={<PhotoApp moduleId="truongnoiser" />} />
                <Route path="/apps/truongscaler" element={<PhotoApp moduleId="truongscaler" />} />
            </Routes>
        </MemoryRouter>,
    )
}

describe('Apps navigation', () => {
    it('opens the launched camera with the repository download and installation details', () => {
        renderApps()
        fireEvent.click(screen.getByRole('link', { name: /TruongCam/ }))
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('TruongCam')
        expect(screen.getByRole('link', { name: /Download for iPhone/ })).toHaveAttribute('href', 'https://github.com/iant4093/TruongCam/releases/latest/download/TruongCam.ipa')
        expect(screen.getByRole('link', { name: /View on GitHub/ })).toHaveAttribute('href', 'https://github.com/iant4093/TruongCam')
        expect(screen.getByText(/iOS 27.*Unsigned IPA.*Signing required/)).toBeInTheDocument()
        expect(document.title).toBe('TruongCam — RAW Camera for iPhone | Ian Truong Photography')
    })

    it('opens the existing editor from the available Web Editor module', () => {
        renderApps()
        expect(screen.getByRole('heading', { name: 'Apps' })).toBeInTheDocument()
        const modules = screen.getByRole('region', { name: 'Apps' })
        expect(within(modules).getAllByRole('link')).toHaveLength(5)
        fireEvent.click(within(modules).getByRole('link', { name: /Web Editor/ }))
        expect(screen.getByRole('heading', { name: 'Existing photo editor' })).toBeInTheDocument()
    })

    it.each(['TruongRoom'])('opens %s, then returns to the modules', title => {
        renderApps()
        fireEvent.click(screen.getByRole('link', { name: new RegExp(title) }))
        expect(screen.getByRole('heading', { name: title })).toBeInTheDocument()
        expect(screen.getByText('Coming soon')).toBeInTheDocument()
        expect(document.title).toBe(`${title} — Coming Soon | Ian Truong Photography`)
        fireEvent.click(screen.getByRole('link', { name: /All apps/ }))
        expect(screen.getByRole('heading', { name: 'Apps' })).toBeInTheDocument()
        expect(document.title).toBe('Apps | Ian Truong Photography')
    })

    it.each(['truongroom'])('supports opening /apps/%s directly and trying the editor', moduleId => {
        renderApps(`/apps/${moduleId}`)
        expect(screen.getByText('Coming soon')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('link', { name: /Try Web Editor/ }))
        expect(screen.getByRole('heading', { name: 'Existing photo editor' })).toBeInTheDocument()
    })

    it.each([
        ['TruongNoiser', 'Photo Denoising', /NAFNet.*CGNet/, /luminance and color strength/],
        ['TruongScaler', '2× Photo Upscaling', /QuickSRNet.*EDSR.*HAT-S/, /grain retention/],
    ])('opens the launched %s page with downloads, screenshots, and app details', (title, description, models, controls) => {
        renderApps()
        const module = screen.getByRole('link', { name: new RegExp(title) })
        expect(module).toHaveTextContent('Available now')
        fireEvent.click(module)
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(title)
        expect(screen.queryByText('Coming soon')).not.toBeInTheDocument()
        expect(screen.getByRole('link', { name: /Download for iPhone/ })).toHaveAttribute('href', `https://github.com/iant4093/${title}/releases/latest/download/${title}.ipa`)
        expect(screen.getByRole('link', { name: /View on GitHub/ })).toHaveAttribute('href', `https://github.com/iant4093/${title}`)
        expect(screen.getByText(models)).toBeInTheDocument()
        expect(screen.getByText(controls)).toBeInTheDocument()
        expect(screen.getByText(/iOS 27.*Unsigned IPA.*Signing required/)).toBeInTheDocument()
        expect(screen.getByRole('heading', { name: 'Installation' })).toBeInTheDocument()
        expect(screen.getAllByRole('img')).toHaveLength(5)
        expect(document.title).toBe(`${title} — ${description} for iPhone | Ian Truong Photography`)
        expect(document.querySelector('link[rel="canonical"]')).toHaveAttribute('href', `https://iantruongphotography.com/apps/${title.toLowerCase()}`)
        fireEvent.click(screen.getByRole('link', { name: /All apps/ }))
        expect(screen.getByRole('heading', { name: 'Apps' })).toBeInTheDocument()
    })

    it('opens both app pages directly and links between companion apps', () => {
        renderApps('/apps/truongnoiser')
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('TruongNoiser')
        fireEvent.click(screen.getByRole('link', { name: 'TruongScaler →' }))
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('TruongScaler')
        expect(document.title).toContain('2× Photo Upscaling')
        fireEvent.click(screen.getByRole('link', { name: 'TruongNoiser →' }))
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('TruongNoiser')
    })
})
