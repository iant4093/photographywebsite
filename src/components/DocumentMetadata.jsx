import { useEffect } from 'react'
import { useLocation } from 'react-router'

const SITE_ORIGIN = 'https://iantruongphotography.com'
const PAGE_TITLES = {
    '/editor': 'Photo Editor',
    '/utilities': 'Utilities',
    '/utilities/truongroom': 'TruongRoom — Coming Soon',
    '/utilities/truongcam': 'TruongCam — RAW Camera for iPhone',
    '/utilities/truongnoiser': 'TruongNoiser — Coming Soon',
    '/utilities/truongscaler': 'TruongScaler — Coming Soon',
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
