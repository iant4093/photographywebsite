import { mediaHlsUrl } from './mediaUrls'

export const VIDEO_HOVER_DELAY_MS = 350
export const VIDEO_HOVER_DURATION_MS = 4000
export const VIDEO_HOVER_FADE_MS = 260

let hlsModulePromise = null

function loadHlsModule() {
    if (!hlsModulePromise) {
        hlsModulePromise = import('hls.js').catch((error) => {
            hlsModulePromise = null
            throw error
        })
    }
    return hlsModulePromise
}

function comparablePath(value) {
    if (!value) return ''
    try {
        return new URL(value, window.location.origin).pathname
    } catch {
        return String(value).split(/[?#]/, 1)[0]
    }
}

export function canRunVideoHoverPreview() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(hover: hover) and (pointer: fine)').matches
        && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function warmVideoHoverRuntime() {
    if (!canRunVideoHoverPreview()) return Promise.resolve(null)
    return loadHlsModule().catch(() => null)
}

export function selectAlbumCoverVideo(detail, album) {
    if (album?.coverHlsUrl) {
        const requestedTime = Number(album.coverThumbnailTime)
        return {
            hlsUrl: album.coverHlsUrl,
            startTime: Number.isFinite(requestedTime) ? Math.max(0, Math.min(requestedTime, 86400)) : 0,
        }
    }
    const videos = Array.isArray(detail?.images) ? detail.images : []
    const coverPaths = new Set([
        comparablePath(album?.coverThumbnailUrl),
        comparablePath(album?.coverImageUrl),
    ].filter(Boolean))
    const cover = videos.find((video) => (
        [video?.thumbnailUrl, video?.url]
            .map(comparablePath)
            .some((path) => path && coverPaths.has(path))
    )) || videos[0]
    const hlsUrl = mediaHlsUrl(cover)
    if (!cover || !hlsUrl) return null
    const requestedTime = Number(cover.thumbnailTime)
    return {
        hlsUrl,
        startTime: Number.isFinite(requestedTime) ? Math.max(0, Math.min(requestedTime, 86400)) : 0,
    }
}

function prepareVideo() {
    const video = document.createElement('video')
    video.muted = true
    video.defaultMuted = true
    video.playsInline = true
    video.preload = 'auto'
    video.disablePictureInPicture = true
    video.setAttribute('muted', '')
    video.setAttribute('playsinline', '')
    video.setAttribute('aria-hidden', 'true')
    video.className = 'album-card-video-preview absolute inset-0 h-full w-full object-cover pointer-events-none'
    Object.assign(video.style, {
        zIndex: '10',
        opacity: '0',
        transition: `opacity ${VIDEO_HOVER_FADE_MS}ms ease`,
    })
    return video
}

export function start({ container, album, loadDetail, onPlaybackStart, onPlaybackEnd }) {
    if (!container || !canRunVideoHoverPreview()) return { stop() {} }

    let active = true
    let playing = false
    let video = null
    let hls = null
    let intentReady = false
    let mediaReady = false
    let started = false
    let playAttempts = 0
    const timers = new Set()
    const listeners = []
    const later = (callback, delay) => {
        const timer = window.setTimeout(() => {
            timers.delete(timer)
            if (active) callback()
        }, delay)
        timers.add(timer)
    }
    const listen = (target, event, callback, options) => {
        target.addEventListener(event, callback, options)
        listeners.push(() => target.removeEventListener(event, callback, options))
    }
    const cleanup = (notify = true) => {
        if (!active && !video && !hls) return
        active = false
        timers.forEach((timer) => window.clearTimeout(timer))
        timers.clear()
        listeners.splice(0).forEach((remove) => remove())
        hls?.destroy()
        hls = null
        if (video) {
            video.pause()
            video.removeAttribute('src')
            video.load()
            video.remove()
            video = null
        }
        if (playing && notify) onPlaybackEnd?.()
        playing = false
    }
    const fail = () => cleanup(true)

    const play = async () => {
        if (!active || started || !intentReady || !mediaReady || !video) return
        started = true
        playAttempts += 1
        try {
            await video.play()
            if (!active) return
            playing = true
            onPlaybackStart?.()
            window.requestAnimationFrame(() => {
                if (active && video) video.style.opacity = '1'
            })
            later(() => cleanup(true), VIDEO_HOVER_DURATION_MS)
        } catch (error) {
            if (!active) return
            // A source/seek transition can interrupt the first play request.
            // Retry it once while the pointer is still here, without requiring
            // a leave/re-enter or retrying an autoplay-policy denial.
            if (error?.name === 'AbortError' && playAttempts < 2) {
                started = false
                later(() => { void play() }, 100)
            } else {
                fail()
            }
        }
    }

    later(() => {
        intentReady = true
        void play()
    }, VIDEO_HOVER_DELAY_MS)

    video = prepareVideo()
    container.appendChild(video)
    const nativeHls = Boolean(video.canPlayType('application/vnd.apple.mpegurl'))

    void (async () => {
        let selected = selectAlbumCoverVideo(null, album)
        if (!selected) {
            let detail
            try {
                detail = await loadDetail()
            } catch {
                fail()
                return
            }
            selected = selectAlbumCoverVideo(detail, album)
        }
        if (!active) return
        if (!selected) {
            fail()
            return
        }

        const seekToCover = () => {
            if (!active || !video) return
            const duration = Number(video.duration)
            const latestStart = Number.isFinite(duration) ? Math.max(0, duration - 0.05) : selected.startTime
            const startTime = Math.min(selected.startTime, latestStart)
            if (startTime > 0.01) {
                try {
                    video.currentTime = startTime
                } catch {
                    // HLS.js already receives the same start position below.
                }
            }
        }
        listen(video, 'ended', () => cleanup(true), { once: true })
        listen(video, 'error', fail, { once: true })

        if (nativeHls) {
            listen(video, 'loadedmetadata', seekToCover, { once: true })
            video.src = selected.hlsUrl
            video.load()
            // preload is only a hint. Request playback after hover intent even
            // if a cold native HLS stream has not loaded its metadata yet.
            mediaReady = true
            void play()
            return
        }

        try {
            const { default: Hls } = await loadHlsModule()
            if (!active || !video) return
            if (!Hls.isSupported()) {
                fail()
                return
            }
            hls = new Hls({
                debug: false,
                capLevelToPlayerSize: true,
                startPosition: selected.startTime,
                maxBufferLength: 6,
                maxMaxBufferLength: 8,
                backBufferLength: 0,
            })
            listen(video, 'loadedmetadata', seekToCover, { once: true })
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                mediaReady = true
                void play()
            })
            hls.on(Hls.Events.ERROR, (_event, data) => {
                if (data.fatal) fail()
            })
            hls.loadSource(selected.hlsUrl)
            hls.attachMedia(video)
        } catch {
            fail()
        }
    })()

    return { stop: () => cleanup(true) }
}
