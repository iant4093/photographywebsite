import { useEffect, useState } from 'react'
import useMediaQuery from '../hooks/useMediaQuery'
import { chooseHeroReelRendition, fetchHeroReel, heroReelAllowed, pickHeroReelCut } from '../utils/heroReel'
import './HeroReel.css'

// Leaving the hero pauses immediately; staying away this long also releases
// the decoder and buffered video so long scroll sessions stay light.
export const HERO_REEL_UNLOAD_MS = 15_000

function whenPageSettles(callback) {
    let idle = null
    let timer = null
    const run = () => {
        if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(callback, { timeout: 2000 })
        else timer = window.setTimeout(callback, 300)
    }
    if (document.readyState === 'complete') run()
    else window.addEventListener('load', run, { once: true })
    return () => {
        window.removeEventListener('load', run)
        if (idle !== null) window.cancelIdleCallback?.(idle)
        if (timer !== null) window.clearTimeout(timer)
    }
}

// A silent, looping compilation layered over the still hero. The still stays
// the LCP image and the fallback; the reel fades in only once it is playing.
// The page passes `videoRef` so the hero parallax can move both layers.
export default function HeroReel({ videoRef }) {
    const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
    const [reel, setReel] = useState(null)
    const [playing, setPlaying] = useState(false)

    useEffect(() => {
        if (reducedMotion || !heroReelAllowed()) return undefined
        const controller = new AbortController()
        const cancel = whenPageSettles(() => {
            fetchHeroReel({ signal: controller.signal })
                .then((value) => { if (!controller.signal.aborted) setReel(pickHeroReelCut(value)) })
                .catch(() => {})
        })
        return () => {
            cancel()
            controller.abort()
        }
    }, [reducedMotion])

    useEffect(() => {
        const video = videoRef.current
        const section = video?.closest('section')
        if (!video || !section || !reel) return undefined
        video.muted = true
        video.defaultMuted = true
        video.setAttribute('muted', '')
        video.setAttribute('disableremoteplayback', '')
        let source = ''
        let loaded = false
        let visible = false
        let stopped = false
        let unloadTimer = null
        let resizeTimer = null

        const pick = () => {
            const rect = section.getBoundingClientRect()
            return chooseHeroReelRendition(reel, {
                width: rect.width,
                height: rect.height,
                pixelRatio: window.devicePixelRatio || 1,
            })?.url || ''
        }
        const unload = () => {
            window.clearTimeout(unloadTimer)
            if (!loaded) return
            video.pause()
            video.removeAttribute('src')
            video.load()
            loaded = false
            setPlaying(false)
        }
        const play = () => {
            if (stopped || !visible || document.hidden || !source) return
            window.clearTimeout(unloadTimer)
            if (!loaded) {
                video.src = source
                loaded = true
            }
            const attempt = video.play()
            attempt?.catch?.((error) => {
                // Autoplay refused (e.g. Low Power Mode): keep the still image.
                if (error?.name === 'NotAllowedError') {
                    stopped = true
                    unload()
                }
            })
        }
        const pause = () => {
            if (!loaded) return
            video.pause()
            window.clearTimeout(unloadTimer)
            unloadTimer = window.setTimeout(unload, HERO_REEL_UNLOAD_MS)
        }
        const onVisibility = () => {
            if (document.hidden) video.pause()
            else play()
        }
        const onResize = () => {
            window.clearTimeout(resizeTimer)
            resizeTimer = window.setTimeout(() => {
                const next = pick()
                if (!next || next === source) return
                source = next
                if (loaded) {
                    unload()
                    play()
                }
            }, 250)
        }
        const onPlaying = () => setPlaying(true)
        const onError = () => {
            stopped = true
            unload()
        }

        source = pick()
        if (!source) return undefined
        video.addEventListener('playing', onPlaying)
        video.addEventListener('error', onError)
        document.addEventListener('visibilitychange', onVisibility)
        window.addEventListener('resize', onResize, { passive: true })
        const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => {
            visible = entry.isIntersecting
            if (visible) play()
            else pause()
        })
        if (observer) observer.observe(section)
        else {
            visible = true
            play()
        }
        return () => {
            observer?.disconnect()
            video.removeEventListener('playing', onPlaying)
            video.removeEventListener('error', onError)
            document.removeEventListener('visibilitychange', onVisibility)
            window.removeEventListener('resize', onResize)
            window.clearTimeout(resizeTimer)
            stopped = true
            unload()
        }
    }, [reel, videoRef])

    if (reducedMotion) return null
    return (
        <video
            ref={videoRef}
            className={`video-hero-media hero-reel parallax-hero${playing ? ' is-playing' : ''}`}
            muted
            loop
            playsInline
            preload="none"
            disablePictureInPicture
            aria-hidden="true"
            tabIndex={-1}
        />
    )
}
