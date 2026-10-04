import { useEffect, useRef, useState } from 'react'
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

function prepare(video) {
    video.muted = true
    video.defaultMuted = true
    video.setAttribute('muted', '')
    video.setAttribute('disableremoteplayback', '')
}

function release(layer) {
    if (!layer.url) return
    layer.video.pause()
    layer.video.removeAttribute('src')
    layer.video.load()
    layer.url = ''
}

// A silent, looping compilation layered over the still hero. The still stays
// the LCP image and the fallback; the reel fades in only once it is playing.
// Two stacked video layers let a rotation or resize swap to another rendition
// of the same cut at the same moment instead of restarting it. The page passes
// `videoRef` (the wrapper) so the hero parallax can move both layers.
export default function HeroReel({ videoRef }) {
    const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
    const firstRef = useRef(null)
    const secondRef = useRef(null)
    const [reel, setReel] = useState(null)
    const [playing, setPlaying] = useState(false)
    const [front, setFront] = useState(0)

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
        const section = videoRef.current?.closest('section')
        const layers = [firstRef.current, secondRef.current].map((video) => ({ video, url: '' }))
        if (!section || !reel || layers.some(({ video }) => !video)) return undefined
        layers.forEach(({ video }) => prepare(video))
        let active = 0
        let source = ''
        let visible = false
        let stopped = false
        let unloadTimer = null
        let resizeTimer = null
        let swap = null
        const failed = new Set()

        const pick = () => {
            const rect = section.getBoundingClientRect()
            return chooseHeroReelRendition(reel, {
                width: rect.width,
                height: rect.height,
                pixelRatio: window.devicePixelRatio || 1,
            })?.url || ''
        }
        const cancelSwap = () => {
            if (!swap) return
            swap.cleanup()
            release(swap.layer)
            swap = null
        }
        const unload = () => {
            window.clearTimeout(unloadTimer)
            cancelSwap()
            if (!layers[active].url) return
            release(layers[active])
            setPlaying(false)
        }
        const stop = () => {
            stopped = true
            unload()
        }
        // Autoplay refused (e.g. Low Power Mode): keep the still image, or for
        // a pending swap, the rendition already playing.
        const start = (layer) => {
            layer.video.play()?.catch?.((error) => {
                if (error?.name !== 'NotAllowedError') return
                if (swap?.layer === layer) cancelSwap()
                else stop()
            })
        }
        const load = (layer, url) => {
            layer.video.preload = 'auto'
            layer.video.src = url
            layer.url = url
        }
        const play = () => {
            if (stopped || !visible || document.hidden || !source) return
            window.clearTimeout(unloadTimer)
            const current = layers[active]
            if (!current.url) load(current, source)
            start(current)
            if (swap) start(swap.layer)
        }
        const pause = () => {
            if (!layers[active].url) return
            layers.forEach(({ video, url }) => { if (url) video.pause() })
            window.clearTimeout(unloadTimer)
            unloadTimer = window.setTimeout(unload, HERO_REEL_UNLOAD_MS)
        }
        // Start the new rendition hidden behind the current one, seek it to the
        // same moment, and reveal it once it is there.
        const beginSwap = () => {
            cancelSwap()
            const current = layers[active]
            const next = layers[1 - active]
            if (source === current.url) return
            let corrections = 0
            let synced = false
            const target = () => {
                const duration = next.video.duration
                const time = current.video.currentTime || 0
                return Number.isFinite(duration) && duration > 0 ? time % duration : time
            }
            const finish = () => {
                swap.cleanup()
                swap = null
                release(current)
                active = layers.indexOf(next)
                setFront(active)
            }
            const onMetadata = () => { next.video.currentTime = target() }
            const onSeeked = () => {
                if (current.video.paused) {
                    next.video.pause()
                    finish()
                    return
                }
                // The front layer kept playing during the seek; aim ahead by
                // the time the seek took.
                const lag = target() - next.video.currentTime
                if (lag > 0.12 && corrections < 2) {
                    corrections += 1
                    next.video.currentTime = target() + lag
                    return
                }
                synced = true
                if (next.video.paused) start(next)
                else finish()
            }
            const onPlaying = () => { if (synced) finish() }
            const onError = () => {
                // Keep the rendition that works and do not retry this one.
                failed.add(next.url)
                source = current.url
                cancelSwap()
            }
            next.video.addEventListener('loadedmetadata', onMetadata)
            next.video.addEventListener('seeked', onSeeked)
            next.video.addEventListener('playing', onPlaying)
            next.video.addEventListener('error', onError)
            swap = {
                layer: next,
                cleanup: () => {
                    next.video.removeEventListener('loadedmetadata', onMetadata)
                    next.video.removeEventListener('seeked', onSeeked)
                    next.video.removeEventListener('playing', onPlaying)
                    next.video.removeEventListener('error', onError)
                },
            }
            load(next, source)
            // Some browsers (iOS) fetch nothing until playback starts.
            if (!current.video.paused) start(next)
        }
        const onVisibility = () => {
            if (document.hidden) layers.forEach(({ video, url }) => { if (url) video.pause() })
            else play()
        }
        const onResize = () => {
            window.clearTimeout(resizeTimer)
            resizeTimer = window.setTimeout(() => {
                const next = pick()
                if (!next || next === source || failed.has(next)) return
                source = next
                if (layers[active].url && !stopped) beginSwap()
            }, 250)
        }
        const onPlaying = (event) => {
            if (event.target === layers[active].video) setPlaying(true)
        }
        const onError = (event) => {
            if (event.target === layers[active].video) stop()
        }

        source = pick()
        if (!source) return undefined
        layers.forEach(({ video }) => {
            video.addEventListener('playing', onPlaying)
            video.addEventListener('error', onError)
        })
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
            layers.forEach(({ video }) => {
                video.removeEventListener('playing', onPlaying)
                video.removeEventListener('error', onError)
            })
            document.removeEventListener('visibilitychange', onVisibility)
            window.removeEventListener('resize', onResize)
            window.clearTimeout(resizeTimer)
            stopped = true
            unload()
        }
    }, [reel, videoRef])

    if (reducedMotion) return null
    const layer = (ref, index) => (
        <video
            ref={ref}
            className={`hero-reel-layer${front === index ? ' is-active' : ''}`}
            muted
            loop
            playsInline
            preload="none"
            disablePictureInPicture
            tabIndex={-1}
        />
    )
    return (
        <div
            ref={videoRef}
            className={`video-hero-media hero-reel parallax-hero${playing ? ' is-playing' : ''}`}
            aria-hidden="true"
        >
            {layer(firstRef, 0)}
            {layer(secondRef, 1)}
        </div>
    )
}
