import { useEffect } from 'react'
import { useLocation } from 'react-router'

const MIN_VISIBLE_MS = 350
const HERO_WAIT_MS = 1600
const FADE_MS = 240

// This lives inside the route Suspense boundary, so it only runs once the
// initial page has actually committed instead of exposing an empty shell.
export default function InitialLoadGate() {
    const { pathname } = useLocation()
    useEffect(() => {
        const loader = document.getElementById('initial-loader')
        if (!loader || loader.classList.contains('is-leaving')) return undefined

        const hero = document.querySelector('#main-content .home-hero-media, #main-content .video-hero-media')
        let readyTimer
        let heroTimer
        let leaving = false

        const leave = () => {
            if (leaving) return
            leaving = true
            loader.classList.add('is-leaving')
            window.setTimeout(() => {
                loader.remove()
            }, window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : FADE_MS)
        }

        const ready = () => {
            if (leaving || readyTimer) return
            window.clearTimeout(heroTimer)
            const remaining = Math.max(0, MIN_VISIBLE_MS - performance.now())
            readyTimer = window.setTimeout(leave, remaining)
        }

        if (!hero || (hero.complete && hero.naturalWidth > 0)) ready()
        else {
            hero.addEventListener('load', ready)
            heroTimer = window.setTimeout(ready, HERO_WAIT_MS)
        }

        return () => {
            hero?.removeEventListener('load', ready)
            window.clearTimeout(heroTimer)
            if (!leaving) window.clearTimeout(readyTimer)
        }
    }, [])

    return <span hidden data-route-content={pathname} />
}
