import { useEffect, useState } from 'react'
import { fetchHeroManifest } from '../utils/mediaUrls'

// A route revisit can reuse this document's already-decoded alias. Remember its
// original version across mounts so later publications still use fresh URLs.
const aliasVersions = new Map()

// Current aliases must revalidate and paint immediately. The first manifest
// establishes their version; renaming that same image would download it twice.
// A later publication still switches an open page to its immutable new URLs.
export default function usePublishedHero(heroType, heroRef) {
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
            if (controller.signal.aborted || document.hidden || pending) return
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
        void refresh()
        // The manifest already loads this module in parallel with its request.
        // Keep background refresh scheduling out of the initial page script.
        import('../utils/publicMediaMetadata').then(({ observeHeroRefresh }) => {
            observeHeroRefresh(heroRef?.current, heroType, refresh, controller.signal)
        }).catch(() => {})
        return () => controller.abort()
    }, [heroType, heroRef])
    return published?.heroType === heroType ? published.manifest : null
}
