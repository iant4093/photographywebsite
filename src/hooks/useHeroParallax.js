import { useEffect } from 'react'
import useMediaQuery from './useMediaQuery'

// `followerRef` (optional) receives the same transform in the same frame, so
// layered media such as the video hero reel moves exactly with the hero.
export default function useHeroParallax(ref, speed, maximum, followerRef) {
    const disabled = useMediaQuery('(prefers-reduced-motion: reduce)')
    useEffect(() => {
        const hero = ref.current
        if (!hero || disabled) return undefined
        let frame = null
        let visible = false
        const moved = new Set([hero])
        const update = () => {
            frame = null
            if (!visible || document.hidden) return
            const shift = Math.min(Math.max(0, window.scrollY) * Math.abs(speed), maximum) * Math.sign(speed)
            const transform = `translateY(${shift}px)`
            if (followerRef?.current) moved.add(followerRef.current)
            for (const element of moved) {
                if (element.style.transform !== transform) element.style.transform = transform
            }
        }
        const schedule = () => {
            if (visible && !document.hidden && frame === null) frame = window.requestAnimationFrame(update)
        }
        const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => {
            visible = entry.isIntersecting
            schedule()
        })
        if (observer) observer.observe(hero.parentElement)
        else visible = true
        schedule()
        window.addEventListener('scroll', schedule, { passive: true })
        document.addEventListener('visibilitychange', schedule)
        return () => {
            observer?.disconnect()
            window.removeEventListener('scroll', schedule)
            document.removeEventListener('visibilitychange', schedule)
            if (frame !== null) window.cancelAnimationFrame(frame)
            for (const element of moved) element.style.removeProperty('transform')
        }
    }, [disabled, followerRef, maximum, ref, speed])
}
