import { sendAnalyticsEvents } from './api'

const PREFERENCE_KEY = 'ian-photography-analytics'
const PREFERENCE_EVENT = 'ian:analytics-preference'
const FLUSH_DELAY_MS = 750
const MAX_BATCH_SIZE = 20
const PRIVATE_PATH_PREFIXES = ['/admin', '/dashboard', '/login', '/sharedalbum']

let queue = []
let flushTimer = null

function storage() {
    try {
        return window.localStorage
    } catch {
        return null
    }
}

function privacySignalEnabled() {
    if (typeof navigator === 'undefined') return false
    return navigator.globalPrivacyControl === true || navigator.doNotTrack === '1' || window.doNotTrack === '1'
}

export function analyticsPreference() {
    const saved = storage()?.getItem(PREFERENCE_KEY)
    if (saved === 'disabled') return { enabled: false, source: 'preference' }
    if (privacySignalEnabled()) return { enabled: false, source: 'privacy-signal' }
    if (saved === 'enabled') return { enabled: true, source: 'preference' }
    return { enabled: true, source: 'default' }
}

export function setAnalyticsPreference(enabled) {
    const next = enabled ? 'enabled' : 'disabled'
    storage()?.setItem(PREFERENCE_KEY, next)
    if (!enabled) {
        queue = []
        if (flushTimer !== null) window.clearTimeout(flushTimer)
        flushTimer = null
    }
    window.dispatchEvent(new CustomEvent(PREFERENCE_EVENT, { detail: { enabled: Boolean(enabled) } }))
}

export function subscribeToAnalyticsPreference(listener) {
    window.addEventListener(PREFERENCE_EVENT, listener)
    return () => window.removeEventListener(PREFERENCE_EVENT, listener)
}

export function isPublicAnalyticsPath(pathname) {
    const normalized = typeof pathname === 'string' ? pathname : '/'
    return !PRIVATE_PATH_PREFIXES.some((prefix) => (
        normalized === prefix || normalized.startsWith(`${prefix}/`)
    ))
}

export function classifyTrafficSource(referrer = document.referrer) {
    if (!referrer) return 'direct'
    try {
        const hostname = new URL(referrer).hostname.toLowerCase()
        if (hostname === window.location.hostname.toLowerCase()) return 'direct'
        if (/(^|\.)(google|bing|yahoo|duckduckgo|baidu|yandex)\./.test(hostname)) return 'search'
        if (hostname === 'instagram.com' || hostname.endsWith('.instagram.com')) return 'instagram'
        if (hostname === 'github.com' || hostname.endsWith('.github.com')) return 'github'
        return 'other'
    } catch {
        return 'other'
    }
}

export function classifyDevice() {
    if (navigator.userAgentData?.mobile === true) return 'mobile'
    const width = Math.max(window.innerWidth || 0, window.screen?.width || 0)
    if (width <= 640) return 'mobile'
    if ((navigator.maxTouchPoints || 0) > 0 && width <= 1180) return 'tablet'
    return 'desktop'
}

function scheduleFlush() {
    if (flushTimer !== null) return
    flushTimer = window.setTimeout(() => {
        flushTimer = null
        void flushAnalytics()
    }, FLUSH_DELAY_MS)
}

export function trackAnalyticsEvent(event) {
    if (!analyticsPreference().enabled || !event || typeof event !== 'object') return false
    queue.push(event)
    if (queue.length >= MAX_BATCH_SIZE) void flushAnalytics()
    else scheduleFlush()
    return true
}

export async function flushAnalytics() {
    if (flushTimer !== null) window.clearTimeout(flushTimer)
    flushTimer = null
    if (!analyticsPreference().enabled) {
        queue = []
        return
    }
    while (queue.length > 0) {
        const events = queue.splice(0, MAX_BATCH_SIZE)
        try {
            await sendAnalyticsEvents(events)
        } catch {
            // Analytics must never interrupt the visitor experience or retry
            // indefinitely. A missed aggregate sample is preferable.
        }
    }
}

export function trackSiteVisit() {
    return trackAnalyticsEvent({
        name: 'site_visit',
        source: classifyTrafficSource(),
        device: classifyDevice(),
    })
}

export function trackPageView() {
    return trackAnalyticsEvent({ name: 'page_view' })
}

export function trackAlbumView(albumId) {
    return trackAnalyticsEvent({ name: 'album_view', albumId })
}

export function trackPhotoDownload(albumId) {
    return trackAnalyticsEvent({ name: 'photo_download', albumId })
}

export function trackZipRequest(albumId) {
    return trackAnalyticsEvent({ name: 'zip_request', albumId })
}

export function trackContactSubmission() {
    return trackAnalyticsEvent({ name: 'contact_submit' })
}

export function trackHeroExplore(kind) {
    return trackAnalyticsEvent({ name: kind === 'video' ? 'hero_explore_videos' : 'hero_explore_photos' })
}

export function trackWebVital(metric, value, rating) {
    return trackAnalyticsEvent({ name: 'web_vital', metric, value, rating })
}

export function trackFrontendError(kind) {
    return trackAnalyticsEvent({ name: 'frontend_error', kind })
}

export function ratingForVital(metric, value) {
    const thresholds = {
        LCP: [2500, 4000],
        INP: [200, 500],
        CLS: [0.1, 0.25],
    }[metric]
    if (!thresholds) return 'poor'
    if (value <= thresholds[0]) return 'good'
    if (value <= thresholds[1]) return 'needs-improvement'
    return 'poor'
}

export function resetAnalyticsForTests() {
    queue = []
    if (flushTimer !== null && typeof window !== 'undefined') window.clearTimeout(flushTimer)
    flushTimer = null
}
