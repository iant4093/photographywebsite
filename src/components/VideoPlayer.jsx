import { useEffect, useRef, useState } from 'react'
import { mediaDisplayUrl, mediaHlsUrl, mediaThumbnailUrl } from '../utils/mediaUrls'

export default function VideoPlayer({ videoInfo, autoplay = true, controls = true, onMediaError }) {
    const videoRef = useRef(null)
    const [failedHlsUrl, setFailedHlsUrl] = useState('')
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

        if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = hlsUrl
            video.addEventListener('loadedmetadata', tryPlay)
            video.addEventListener('error', fallbackToRaw)
        } else {
            import('hls.js').then(({ default: Hls }) => {
                if (disposed) return
                if (!Hls.isSupported()) {
                    fallbackToRaw()
                    return
                }
                hls = new Hls({ debug: false })
                hls.loadSource(hlsUrl)
                hls.attachMedia(video)
                hls.on(Hls.Events.MANIFEST_PARSED, tryPlay)
                hls.on(Hls.Events.ERROR, (_event, data) => {
                    if (data.fatal) fallbackToRaw()
                })
            }).catch(fallbackToRaw)
        }

        return () => {
            disposed = true
            video.removeEventListener('loadedmetadata', tryPlay)
            video.removeEventListener('error', fallbackToRaw)
            hls?.destroy()
            video.pause()
            video.removeAttribute('src')
            video.load()
        }
    }, [autoplay, hlsUrl, onMediaError, rawUrl, useHls])

    return (
        <video
            ref={videoRef}
            controls={controls}
            playsInline
            preload="metadata"
            poster={posterUrl}
            className="w-full h-full outline-none"
        />
    )
}
