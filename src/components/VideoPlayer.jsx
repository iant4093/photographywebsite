import { useCallback, useEffect, useRef, useState } from 'react'
import { parseHlsVariants, qualityLabel, qualityOptions } from '../utils/hlsSource'
import { mediaDisplayUrl, mediaHlsUrl, mediaThumbnailUrl } from '../utils/mediaUrls'
import VideoControls from './VideoControls'

function CaptionTrack({ text, language, onError }) {
    const trackRef = useRef(null)
    useEffect(() => {
        const track = trackRef.current
        const url = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }))
        // Track load errors do not bubble; attach directly to the track element.
        track.addEventListener('error', onError)
        track.src = url
        track.track.mode = 'showing'
        return () => {
            track.removeAttribute('src')
            track.removeEventListener('error', onError)
            URL.revokeObjectURL(url)
        }
    }, [onError, text])
    return <track ref={trackRef} kind="captions" srcLang={language} label={language} default />
}

export default function VideoPlayer({ videoInfo, autoplay = true, controls = true, onMediaError }) {
    const videoRef = useRef(null)
    const playerRef = useRef(null)
    const [failedHlsUrl, setFailedHlsUrl] = useState('')
    const [captionError, setCaptionError] = useState(null)
    // { source, options, value, playing, select } for the current stream.
    const [quality, setQuality] = useState(null)
    const captionVtt = videoInfo?.captionVtt || ''
    const reportCaptionError = useCallback(() => setCaptionError({ text: captionVtt, message: 'Captions could not load. Please use the transcript if available or contact Ian for help.' }), [captionVtt])
    const rawUrl = mediaDisplayUrl(videoInfo)
    const posterUrl = mediaThumbnailUrl(videoInfo)
    const hlsUrl = mediaHlsUrl(videoInfo)
    const hlsFailed = Boolean(hlsUrl && failedHlsUrl === hlsUrl)
    const useHls = Boolean(hlsUrl && !hlsFailed)

    useEffect(() => {
        const video = videoRef.current
        if (!video || (!rawUrl && !hlsUrl)) return undefined
        let hls = null
        let disposed = false

        const tryPlay = () => {
            if (!autoplay || disposed) return
            video.muted = true
            video.play().catch(() => {})
        }
        const fallbackToRaw = () => {
            if (!rawUrl || disposed) return
            setFailedHlsUrl(hlsUrl)
        }
        const reportRawError = () => {
            if (!disposed) onMediaError?.()
        }

        if (!useHls) {
            video.src = rawUrl
            video.addEventListener('error', reportRawError)
            video.load()
            tryPlay()
            return () => {
                disposed = true
                video.removeEventListener('error', reportRawError)
                video.pause()
                video.removeAttribute('src')
                video.load()
            }
        }

        const publish = (options, select, value = 'auto', playing = '') => {
            if (!disposed) setQuality({ source: hlsUrl, options, value, playing, select })
        }
        let restoreTime = null

        // Autoplay (which mutes) applies to the first load only, not to the
        // reload a quality change causes.
        const firstPlay = () => {
            video.removeEventListener('loadedmetadata', firstPlay)
            tryPlay()
        }

        if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = hlsUrl
            video.addEventListener('loadedmetadata', firstPlay)
            video.addEventListener('error', fallbackToRaw)
            // Safari has no level API: a fixed quality plays that variant's
            // own playlist, resuming from the same moment.
            fetch(hlsUrl).then(response => (response.ok ? response.text() : '')).then((text) => {
                const variants = parseHlsVariants(text, new URL(hlsUrl, window.location.href).href)
                const options = qualityOptions(variants.map(variant => ({ ...variant, value: variant.url })))
                const select = (value) => {
                    if (disposed) return
                    const resume = !video.paused
                    const time = video.currentTime
                    restoreTime = () => {
                        video.removeEventListener('loadedmetadata', restoreTime)
                        restoreTime = null
                        try { video.currentTime = time } catch { /* unseekable until data arrives */ }
                        if (resume) video.play().catch(() => {})
                    }
                    video.addEventListener('loadedmetadata', restoreTime)
                    video.src = value === 'auto' ? hlsUrl : value
                    publish(options, select, value)
                }
                if (options.length > 1) publish(options, select)
            }).catch(() => {})
        } else {
            import('hls.js').then(({ default: Hls }) => {
                if (disposed) return
                if (!Hls.isSupported()) {
                    fallbackToRaw()
                    return
                }
                hls = new Hls({
                    debug: false,
                    capLevelToPlayerSize: true,
                    maxBufferLength: 20,
                    maxMaxBufferLength: 30,
                    backBufferLength: 10,
                })
                hls.loadSource(hlsUrl)
                hls.attachMedia(video)
                let options = []
                let chosen = 'auto'
                const playingLabel = () => {
                    const level = hls.levels?.[hls.currentLevel]
                    return level ? qualityLabel(level.width, level.height) : ''
                }
                const select = (value) => {
                    if (disposed) return
                    chosen = value
                    // currentLevel switches now (flushing the buffer); -1 is Auto.
                    hls.currentLevel = value === 'auto' ? -1 : Number(value)
                    publish(options, select, chosen, playingLabel())
                }
                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    tryPlay()
                    options = qualityOptions((hls.levels || []).map((level, index) => ({
                        width: level.width, height: level.height, bitrate: level.bitrate, value: index,
                    })))
                    if (options.length > 1) publish(options, select)
                })
                if (Hls.Events.LEVEL_SWITCHED) {
                    hls.on(Hls.Events.LEVEL_SWITCHED, () => {
                        if (options.length > 1) publish(options, select, chosen, playingLabel())
                    })
                }
                hls.on(Hls.Events.ERROR, (_event, data) => {
                    if (data.fatal) fallbackToRaw()
                })
            }).catch(fallbackToRaw)
        }

        return () => {
            disposed = true
            video.removeEventListener('loadedmetadata', firstPlay)
            video.removeEventListener('error', fallbackToRaw)
            if (restoreTime) video.removeEventListener('loadedmetadata', restoreTime)
            hls?.destroy()
            video.pause()
            video.removeAttribute('src')
            video.load()
        }
    }, [autoplay, hlsUrl, onMediaError, rawUrl, useHls])

    return (
        <div ref={playerRef} className="site-video-player">
            <video
                ref={videoRef}
                aria-label={videoInfo?.altText || 'Video player'}
                playsInline
                preload="metadata"
                poster={posterUrl}
                className="w-full h-full outline-none"
            >
                {captionVtt && <CaptionTrack key={captionVtt} text={captionVtt} language={videoInfo.captionLanguage || 'en'}
                    onError={reportCaptionError} />}
            </video>
            {controls && <VideoControls videoRef={videoRef} playerRef={playerRef} captionKey={captionVtt}
                quality={useHls && quality?.source === hlsUrl ? quality : null} />}
            {captionError?.text === captionVtt && <p role="status" className="site-video-notice">{captionError.message}</p>}
            {controls && videoInfo?.transcript && <details className="site-video-transcript">
                <summary>Transcript & visual description</summary>
                <p>{videoInfo.transcript}</p>
            </details>}
        </div>
    )
}
