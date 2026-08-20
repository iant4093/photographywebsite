import { useEffect } from 'react'
import { useLocation } from 'react-router'

const SITE_ORIGIN = 'https://iantruongphotography.com'

export default function DocumentMetadata() {
    const location = useLocation()

    useEffect(() => {
        const canonical = document.querySelector('link[rel="canonical"]') || document.createElement('link')
        canonical.setAttribute('rel', 'canonical')
        canonical.setAttribute('href', new URL(location.pathname, SITE_ORIGIN).toString())
        if (!canonical.parentNode) document.head.appendChild(canonical)
        document.title = location.pathname === '/editor'
            ? 'Photo Editor | Ian Truong Photography'
            : 'Ian Truong Photography'
    }, [location.pathname])

    return null
}
