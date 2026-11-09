import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TruongCam from './TruongCam'
import PhotoApp from './PhotoApp'
import PhotoApi from './PhotoApi'
import DesktopApp from './DesktopApp'
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
                <Route path="/apps/truongflix" element={<DesktopApp moduleId="truongflix" />} />
                <Route path="/apps/truongcleaner" element={<DesktopApp moduleId="truongcleaner" />} />
                <Route path="/apps/photo-api" element={<PhotoApi />} />
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
        expect(within(modules).getAllByRole('link')).toHaveLength(8)
        fireEvent.click(within(modules).getByRole('link', { name: /Web Editor/ }))
        expect(screen.getByRole('heading', { name: 'Existing photo editor' })).toBeInTheDocument()
    })

    it('opens the Photo API reference with the public endpoint and selection rules', () => {
        renderApps()
        fireEvent.click(screen.getByRole('link', { name: /Photo API/ }))
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Photo API')
        expect(screen.getByRole('link', { name: /Open the endpoint/ })).toHaveAttribute(
            'href', 'https://photos-api.iantruongphotography.com/v1/photos/random',
        )
        expect(screen.getByText(/If it has none, pick from all its photos/)).toBeInTheDocument()
        expect(document.title).toBe('Photo API | Ian Truong Photography')
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

describe('Desktop app downloads', () => {
    afterEach(() => vi.restoreAllMocks())

    it.each([
        ['TruongFlix', 'MacIntel', undefined, 'macOS', 'TruongFlix-macOS.dmg'],
        ['TruongFlix', 'Win32', undefined, 'Windows', 'TruongFlix-Windows-Setup.exe'],
        ['TruongFlix', 'Linux x86_64', { platform: 'Windows', mobile: false }, 'Windows', 'TruongFlix-Windows-Setup.exe'],
        ['TruongCleaner', 'MacIntel', undefined, 'macOS', 'TruongCleaner.dmg'],
    ])('selects the primary installer for %s on %s', (title, platform, userAgentData, label, file) => {
        vi.spyOn(window, 'navigator', 'get').mockReturnValue({ platform, userAgentData })
        renderApps()
        fireEvent.click(screen.getByRole('link', { name: new RegExp(title) }))
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(title)
        expect(screen.getByRole('link', { name: `Download for ${label}` })).toHaveAttribute('href', `https://github.com/iant4093/${title}/releases/latest/download/${file}`)
        expect(screen.getAllByRole('link', { name: /Download for/ })).toHaveLength(1)
        expect(screen.getAllByRole('img')).toHaveLength(5)
        expect(document.title).toContain(title)
    })

    it.each([
        ['truongflix', { platform: 'iPhone' }, /Visit this page on your Mac or Windows computer/],
        ['truongflix', { platform: 'MacIntel', maxTouchPoints: 5 }, /Visit this page on your Mac or Windows computer/],
        ['truongcleaner', { platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 (Linux; Android 14)' }, /Visit this page on your Mac/],
    ])('shows desktop guidance for %s on mobile (%j)', (moduleId, device, message) => {
        vi.spyOn(window, 'navigator', 'get').mockReturnValue(device)
        renderApps(`/apps/${moduleId}`)
        expect(screen.getByText(message)).toBeInTheDocument()
        expect(screen.queryByRole('link', { name: /Download for|installer/i })).not.toBeInTheDocument()
    })

    it.each([
        ['truongcleaner', 'Win32', /Available for Mac\./, ['macOS installer']],
        ['truongflix', 'Linux x86_64', /Available for Mac and Windows\./, ['macOS installer', 'Windows installer']],
    ])('shows supported systems for %s on %s and lets visitors choose an installer', (moduleId, platform, message, installers) => {
        vi.spyOn(window, 'navigator', 'get').mockReturnValue({ platform })
        renderApps(`/apps/${moduleId}`)
        expect(screen.getByText(message)).toBeInTheDocument()
        expect(screen.queryByRole('link', { name: /Download for/ })).not.toBeInTheDocument()
        expect(screen.getAllByRole('link', { name: /installer/ }).map(link => link.textContent)).toEqual(installers)
    })
})
