// Shared helpers for adaptive (HLS) playback: Safari and iOS play HLS
// natively; elsewhere hls.js is loaded on demand.
export const HLS_MIME = 'application/vnd.apple.mpegurl'

export function isHlsUrl(url) {
    return typeof url === 'string' && /\.m3u8(?:[?#]|$)/.test(url)
}

export function canPlayHlsNatively(video) {
    try {
        return Boolean(video?.canPlayType?.(HLS_MIME))
    } catch {
        return false
    }
}

// Resolves to the hls.js class, or null where Media Source playback is
// unavailable.
export async function loadHlsLibrary() {
    const { default: Hls } = await import('hls.js')
    return Hls.isSupported() ? Hls : null
}
