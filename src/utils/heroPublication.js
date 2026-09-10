import { fetchHeroManifest, HERO_PUBLISHED_EVENT } from './mediaUrls'
export { HERO_PUBLISHED_EVENT } from './mediaUrls'

function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        signal?.throwIfAborted()
        const abort = () => {
            clearTimeout(timer)
            reject(signal.reason)
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', abort)
            resolve()
        }, ms)
        signal?.addEventListener('abort', abort, { once: true })
    })
}

export async function waitForHeroPublication(heroType, etag, { signal, timeoutMs = 180_000, intervalMs = 1500 } = {}) {
    const version = etag.replaceAll('"', '').toLowerCase()
    // Bound every fetch as well as the whole polling window, including offline uploads.
    const deadline = AbortSignal.timeout(timeoutMs)
    const pollingSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
    try {
        while (!pollingSignal.aborted) {
            try {
                const manifest = await fetchHeroManifest({ heroType, signal: pollingSignal })
                if (manifest?.version === version) {
                    window.dispatchEvent(new CustomEvent(HERO_PUBLISHED_EVENT, { detail: { heroType, manifest } }))
                    return manifest
                }
            } catch (error) {
                if (pollingSignal.aborted) throw error
                // A transient CDN/network failure must not discard the uploaded file.
            }
            await delay(intervalMs, pollingSignal)
        }
    } catch (error) {
        if (signal?.aborted) throw error
    }
    signal?.throwIfAborted()
    throw new Error('The image was uploaded, but publication has not been confirmed yet. Your existing cover is still available. Check the gallery again shortly, or retry if it stays unchanged.')
}
