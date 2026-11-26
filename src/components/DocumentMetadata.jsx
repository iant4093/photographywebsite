import { useEffect } from 'react'
import { useLocation } from 'react-router'

const SITE_ORIGIN = 'https://iantruongphotography.com'
const SITE_NAME = 'Ian Truong Photography'
const PAGE_TITLES = {
    '/editor': 'Photo Editor',
    '/apps': 'Apps',
    '/privacy': 'Privacy Notice',
    '/terms': 'Terms & Photo Use',
    '/print-policy': 'Print Orders & Returns',
    '/accessibility': 'Accessibility & Help',
    '/licenses': 'Software Licenses',
}
const APP_PAGE_TITLES = {
    __proto__: null,
    truongroom: 'TruongRoom — Coming Soon',
    truongcam: 'TruongCam — RAW Camera for iPhone',
    truongnoiser: 'TruongNoiser — Photo Denoising for iPhone',
    truongscaler: 'TruongScaler — 2× Photo Upscaling for iPhone',
    truongflix: 'TruongFlix — Local Media Center for Mac and Windows',
    truongphoto: 'TruongPhoto — Photo Library',
    truongcleaner: 'TruongCleaner — Storage Cleaner for Mac',
    truongpaper: 'TruongPaper — Live Wallpapers',
    truongsync: 'TruongSync',
    truongstream: 'TruongStream — USB Webcam Studio',
    'photo-api': 'Photo API',
}

export default function DocumentMetadata() {
    const { pathname } = useLocation()

    useEffect(() => {
        const canonical = document.querySelector('link[rel="canonical"]') || document.createElement('link')
        canonical.rel = 'canonical'
        canonical.href = new URL(pathname, SITE_ORIGIN).href
        if (!canonical.parentNode) document.head.appendChild(canonical)
        const pageTitle = pathname.startsWith('/apps/') ? APP_PAGE_TITLES[pathname.slice(6)] : PAGE_TITLES[pathname]
        document.title = pageTitle ? `${pageTitle} | ${SITE_NAME}` : SITE_NAME
    }, [pathname])

    return null
}
