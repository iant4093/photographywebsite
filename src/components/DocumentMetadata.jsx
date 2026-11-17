import { useEffect } from 'react'
import { useLocation } from 'react-router'

const SITE_ORIGIN = 'https://iantruongphotography.com'
const SITE_NAME = 'Ian Truong Photography'
const PAGE_TITLES = {
    '/editor': 'Photo Editor',
    '/apps': 'Apps',
    '/apps/truongroom': 'TruongRoom — Coming Soon',
    '/apps/truongcam': 'TruongCam — RAW Camera for iPhone',
    '/apps/truongnoiser': 'TruongNoiser — Photo Denoising for iPhone',
    '/apps/truongscaler': 'TruongScaler — 2× Photo Upscaling for iPhone',
    '/apps/truongflix': 'TruongFlix — Local Media Center for Mac and Windows',
    '/apps/truongcleaner': 'TruongCleaner — Storage Cleaner for Mac',
    '/apps/truongpaper': 'TruongPaper — Live Wallpapers',
    '/apps/truongstream': 'TruongStream — USB Webcam Studio',
    '/apps/photo-api': 'Photo API',
    '/privacy': 'Privacy Notice',
    '/terms': 'Terms & Photo Use',
    '/print-policy': 'Print Orders & Returns',
    '/accessibility': 'Accessibility & Help',
    '/licenses': 'Software Licenses',
}

export default function DocumentMetadata() {
    const { pathname } = useLocation()

    useEffect(() => {
        const canonical = document.querySelector('link[rel="canonical"]') || document.createElement('link')
        canonical.rel = 'canonical'
        canonical.href = new URL(pathname, SITE_ORIGIN).href
        if (!canonical.parentNode) document.head.appendChild(canonical)
        const pageTitle = PAGE_TITLES[pathname]
        document.title = pageTitle ? `${pageTitle} | ${SITE_NAME}` : SITE_NAME
    }, [pathname])

    return null
}
