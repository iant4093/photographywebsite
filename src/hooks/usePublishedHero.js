import { useEffect, useState } from 'react'
import { fetchHeroManifest, HERO_PUBLISHED_EVENT } from '../utils/mediaUrls'

// A route revisit can reuse this document's already-decoded alias. Remember its
// original version across mounts so later publications still use fresh URLs.
const aliasVersions = new Map()

// Current aliases must revalidate and paint immediately. The first manifest
// establishes their version; renaming that same image would download it twice.
// A later publication still switches an open page to its immutable new URLs.
export default function usePublishedHero(heroType) {
    const [published, setPublished] = useState(null)
    useEffect(() => {
        const controller = new AbortController()
        let pending = false
        const apply = (manifest) => {
            if (manifest && !controller.signal.aborted) {
                const alias = aliasVersions.get(heroType) || { version: manifest.version, changed: false }
                alias.changed ||= alias.version !== manifest.version
                aliasVersions.set(heroType, alias)
                setPublished((current) => current?.heroType === heroType && current.manifest.version === manifest.version
                    ? current : { heroType, manifest: { ...manifest, useAlias: !alias.changed } })
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
