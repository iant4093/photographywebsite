import { useEffect, useState } from 'react'
import { fetchHeroManifest, HERO_PUBLISHED_EVENT } from '../utils/mediaUrls'

// Fixed aliases paint immediately. Revalidation switches to immutable URLs so
// an open browser cannot keep reusing an earlier upload under the same URL.
export default function usePublishedHero(heroType) {
    const [published, setPublished] = useState(null)
    useEffect(() => {
        const controller = new AbortController()
        let pending = false
        const apply = (manifest) => {
            if (manifest && !controller.signal.aborted) {
                setPublished((current) => current?.heroType === heroType && current.manifest.version === manifest.version
                    ? current : { heroType, manifest })
            }
        }
        const refresh = async () => {
            if (document.hidden || pending) return
            pending = true
            try {
                apply(await fetchHeroManifest({
                    heroType,
                    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
                }))
            } catch {
                // Keep the last working cover when offline or during publication.
            } finally {
                pending = false
            }
        }
        const onPublished = ({ detail }) => {
            if (detail?.heroType === heroType) void refresh()
        }
        void refresh()
        const timer = setInterval(refresh, 15_000)
        window.addEventListener('focus', refresh)
        window.addEventListener('pageshow', refresh)
        window.addEventListener(HERO_PUBLISHED_EVENT, onPublished)
        document.addEventListener('visibilitychange', refresh)
        return () => {
            controller.abort()
            clearInterval(timer)
            window.removeEventListener('focus', refresh)
            window.removeEventListener('pageshow', refresh)
            window.removeEventListener(HERO_PUBLISHED_EVENT, onPublished)
            document.removeEventListener('visibilitychange', refresh)
        }
    }, [heroType])
    return published?.heroType === heroType ? published.manifest : null
}
