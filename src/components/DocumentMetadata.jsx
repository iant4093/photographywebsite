import { useEffect } from 'react'
import { useLocation } from 'react-router'

const SITE_ORIGIN = 'https://iantruongphotography.com'
const PAGE_TITLES = {
    '/editor': 'Photo Editor',
    '/apps': 'Apps',
    '/apps/truongroom': 'TruongRoom — Coming Soon',
    '/apps/truongcam': 'TruongCam — RAW Camera for iPhone',
    '/apps/truongnoiser': 'TruongNoiser — Photo Denoising for iPhone',
    '/apps/truongscaler': 'TruongScaler — 2× Photo Upscaling for iPhone',
    '/apps/truongflix': 'TruongFlix — Local Media Center for Mac and Windows',
    '/apps/truongcleaner': 'TruongCleaner — Storage Cleaner for Mac',
    '/privacy': 'Privacy Notice',
    '/terms': 'Terms & Photo Use',
    '/print-policy': 'Print Orders & Returns',
    '/accessibility': 'Accessibility & Help',
    '/licenses': 'Software Licenses',
}

export default function DocumentMetadata() {
    const location = useLocation()

    useEffect(() => {
        const canonical = document.querySelector('link[rel="canonical"]') || document.createElement('link')
        canonical.setAttribute('rel', 'canonical')
        canonical.setAttribute('href', new URL(location.pathname, SITE_ORIGIN).toString())
        if (!canonical.parentNode) document.head.appendChild(canonical)
        document.title = PAGE_TITLES[location.pathname]
            ? `${PAGE_TITLES[location.pathname]} | Ian Truong Photography`
            : 'Ian Truong Photography'
    }, [location.pathname])

    return null
}
