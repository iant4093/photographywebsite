// Casting TV mode to a television. Chromecast goes through Google's Cast SDK
// and its Default Media Receiver, which this page drives one photo at a time.
// Safari gives web pages AirPlay for video only, so Apple devices are offered
// the system's Screen Mirroring instead.
import { mediaDisplayUrl, mediaPreviewCandidates } from './mediaUrls'

export const CAST_SDK_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1'
const ARTIST = 'Ian Truong'
export const CAST_IDLE = Object.freeze({ available: false, connecting: false, connected: false, device: '' })

/** Chrome and other Chromium browsers can cast; every iOS browser is WebKit and cannot. */
export function canCast(win = globalThis.window) {
    if (!win?.chrome) return false
    return !/\b(iPhone|iPad|iPod)\b|CriOS|EdgiOS/.test(win.navigator?.userAgent || '')
}

let sdk = null

/** Loads the Cast sender once; resolves false when it is blocked or unsupported. */
export function loadCastSdk(win = window, doc = document) {
    if (sdk) return sdk
    sdk = new Promise((resolve) => {
        if (win.cast?.framework && win.chrome?.cast) {
            resolve(true)
            return
        }
        const previous = win.__onGCastApiAvailable
        win.__onGCastApiAvailable = (available) => {
            if (typeof previous === 'function') previous(available)
            resolve(Boolean(available && win.cast?.framework && win.chrome?.cast))
        }
        const script = doc.createElement('script')
        script.src = CAST_SDK_URL
        script.async = true
        script.onerror = () => resolve(false)
        doc.head.appendChild(script)
    })
    return sdk
}

export function resetCastSdk() {
    sdk = null
}

function contentType(url) {
    const path = String(url).split(/[?#]/)[0].toLowerCase()
    if (path.endsWith('.webp')) return 'image/webp'
    if (path.endsWith('.png')) return 'image/png'
    return 'image/jpeg'
}

/** The 1920 px preview suits a 1080p TV; the original is the fallback. */
export function castImage(photo) {
    const url = mediaPreviewCandidates(photo).at(-1)?.url || mediaDisplayUrl(photo)
    return url ? { url, contentType: contentType(url) } : null
}

/**
 * Wraps the Cast context: reports {available, connecting, connected, device}
 * through ``onChange`` and sends photos to the connected TV.
 */
export function createCastController(onChange, win = window) {
    const { framework } = win.cast
    const { media } = win.chrome.cast
    const context = framework.CastContext.getInstance()
    context.setOptions({
        receiverApplicationId: media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: win.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    })

    const read = () => {
        const state = context.getCastState()
        const connected = state === framework.CastState.CONNECTED
        return {
            available: state !== framework.CastState.NO_DEVICES_AVAILABLE,
            connecting: state === framework.CastState.CONNECTING,
            connected,
            device: connected ? context.getCurrentSession()?.getCastDevice?.()?.friendlyName || '' : '',
        }
    }
    const report = () => onChange(read())
    const events = [framework.CastContextEventType.CAST_STATE_CHANGED, framework.CastContextEventType.SESSION_STATE_CHANGED]
    events.forEach((type) => context.addEventListener(type, report))
    report()

    return {
        /** Opens Chrome's device picker, which also offers "Stop casting". */
        open() {
            Promise.resolve(context.requestSession()).catch(() => {})
        },
        show(photo, { caption = true } = {}) {
            const session = context.getCurrentSession()
            const image = castImage(photo)
            if (!session || !image) return
            const info = new media.MediaInfo(image.url, image.contentType)
            const metadata = new media.PhotoMediaMetadata()
            metadata.artist = ARTIST
            if (caption && photo.albumTitle) metadata.title = photo.albumTitle
            if (Number(photo.width) > 0 && Number(photo.height) > 0) {
                metadata.width = Number(photo.width)
                metadata.height = Number(photo.height)
            }
            info.metadata = metadata
            Promise.resolve(session.loadMedia(new media.LoadRequest(info))).catch(() => {})
        },
        dispose({ stop = false } = {}) {
            events.forEach((type) => context.removeEventListener(type, report))
            if (stop && read().connected) context.endCurrentSession(true)
        },
    }
}

export function hasAirPlay(win = globalThis.window) {
    return typeof win?.WebKitPlaybackTargetAvailabilityEvent !== 'undefined'
}

/**
 * Safari reports AirPlay devices to media elements only. Calls back with
 * true or false as AirPlay receivers appear and disappear; null means the
 * browser has no AirPlay at all.
 */
export function watchAirPlay(onChange, win = window, doc = document) {
    if (!hasAirPlay(win)) return null
    const probe = doc.createElement('video')
    probe.setAttribute('x-webkit-airplay', 'allow')
    const listener = (event) => onChange(event.availability === 'available')
    probe.addEventListener('webkitplaybacktargetavailabilitychanged', listener)
    return () => probe.removeEventListener('webkitplaybacktargetavailabilitychanged', listener)
}

/** Apple touch devices mirror from Control Center differently from a Mac. */
export function isAppleTouchDevice(win = window) {
    const nav = win.navigator || {}
    return /\b(iPhone|iPad|iPod)\b/.test(nav.userAgent || '') || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
}
