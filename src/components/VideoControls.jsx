import { useEffect, useState } from 'react'
import SiteSelect from './SiteSelect'
import './VideoControls.css'

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2].map(value => ({ value, label: value === 1 ? 'Normal · 1×' : `${value}×` }))
const timestamp = seconds => {
    const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`
}

export default function VideoControls({ videoRef, playerRef }) {
    const [media, setMedia] = useState({ paused: true, time: 0, duration: 0, muted: true, volume: 1, rate: 1 })
    const [fullscreen, setFullscreen] = useState(false)
    const [canFullscreen, setCanFullscreen] = useState(false)
    const [canPip, setCanPip] = useState(false)
    const [notice, setNotice] = useState('')

    useEffect(() => {
        const video = videoRef.current
        const sync = () => setMedia({
            paused: video.paused, time: video.currentTime || 0,
            duration: Number.isFinite(video.duration) ? video.duration : 0,
            muted: video.muted, volume: video.volume, rate: video.playbackRate,
        })
        const updateFullscreen = () => setFullscreen(document.fullscreenElement === playerRef.current)
        const events = ['loadedmetadata', 'durationchange', 'timeupdate', 'play', 'pause', 'ended', 'volumechange', 'ratechange', 'emptied']
        events.forEach(event => video.addEventListener(event, sync))
        document.addEventListener('fullscreenchange', updateFullscreen)
        setCanFullscreen(Boolean(playerRef.current?.requestFullscreen))
        setCanPip(Boolean(document.pictureInPictureEnabled && video.requestPictureInPicture))
        sync()
        return () => {
            events.forEach(event => video.removeEventListener(event, sync))
            document.removeEventListener('fullscreenchange', updateFullscreen)
        }
    }, [playerRef, videoRef])

    async function togglePlay() {
        const video = videoRef.current
        setNotice('')
        if (video.paused) {
            try { await video.play() } catch { setNotice('Playback could not start. Try Play again.') }
        } else video.pause()
    }

    async function toggleFullscreen() {
        setNotice('')
        try {
            if (document.fullscreenElement === playerRef.current) await document.exitFullscreen()
            else await playerRef.current.requestFullscreen()
        } catch { setNotice('Fullscreen is unavailable right now.') }
    }

    async function togglePip() {
        setNotice('')
        try {
            if (document.pictureInPictureElement) await document.exitPictureInPicture()
            else await videoRef.current.requestPictureInPicture()
        } catch { setNotice('Picture in picture is unavailable right now.') }
    }

    return (
        <div className="site-video-controls" onKeyDown={event => {
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)) event.stopPropagation()
        }}>
            <label className="site-video-seek">
                <span className="sr-only">Video position</span>
                <input type="range" min="0" max={media.duration || 0} step="0.1" value={Math.min(media.time, media.duration)}
                    disabled={!media.duration} aria-valuetext={`${timestamp(media.time)} of ${timestamp(media.duration)}`}
                    onChange={event => { const time = Number(event.target.value); videoRef.current.currentTime = time; setMedia(previous => ({ ...previous, time })) }} />
            </label>
            <div className="site-video-control-row">
                <button type="button" onClick={togglePlay} aria-label={media.paused ? 'Play video' : 'Pause video'}>
                    {media.paused
                        ? <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 3 11 7-11 7Z" /></svg>
                        : <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 3h4v14H5zm7 0h4v14h-4z" /></svg>}
                </button>
                <span className="site-video-time">{timestamp(media.time)} / {timestamp(media.duration)}</span>
                <button type="button" onClick={() => { videoRef.current.muted = !media.muted }} aria-label={media.muted ? 'Unmute video' : 'Mute video'}>
                    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 7h4l5-4v14l-5-4H2Z" />
                        <path d={media.muted ? 'm14 7 4 6m0-6-4 6' : 'M14 6q5 4 0 8'} fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
                </button>
                <label className="site-video-volume">
                    <span className="sr-only">Video volume</span>
                    <input type="range" min="0" max="1" step="0.05" value={media.muted ? 0 : media.volume}
                        aria-valuetext={`${Math.round((media.muted ? 0 : media.volume) * 100)} percent`}
                        onChange={event => { const volume = Number(event.target.value); videoRef.current.volume = volume; videoRef.current.muted = volume === 0 }} />
                </label>
                <SiteSelect aria-label="Playback speed" className="site-video-speed" value={media.rate} options={SPEEDS}
                    onChange={value => { videoRef.current.playbackRate = Number(value) }} />
                {canPip && <button type="button" onClick={togglePip} aria-label="Picture in picture"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="2" y="3" width="16" height="14" rx="1" fill="none" stroke="currentColor" /><path d="M10 10h6v5h-6z" /></svg></button>}
                {canFullscreen && <button type="button" onClick={toggleFullscreen} aria-label={fullscreen ? 'Exit fullscreen video' : 'Fullscreen video'}>
                    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M7 2H2v5m11-5h5v5M2 13v5h5m11-5v5h-5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
                </button>}
            </div>
            {notice && <p className="site-video-notice" role="status">{notice}</p>}
        </div>
    )
}
