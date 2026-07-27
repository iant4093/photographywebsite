import { useEffect } from 'react'
import { useLocation } from 'react-router'

const TARGET_SELECTOR = [
    'main .home-hero',
    'main .linen-video-hero',
    'main .linen-section-heading',
    'main .catalog-section',
    'main .album-card',
    'main .linen-gallery-page [data-page-scroll-media]',
].join(', ')

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value))

function isMediaTarget(element) {
    return element.classList.contains('album-card')
        || element.hasAttribute('data-page-scroll-media')
}

function clearMotionStyles(target) {
    target.classList.remove(
        'editorial-motion-frame',
        'editorial-motion-media',
        'editorial-index-0',
        'editorial-index-1',
        'editorial-index-2',
    )
    Array.from(target.style)
        .filter((property) => property.startsWith('--editorial-'))
        .forEach((property) => target.style.removeProperty(property))
}

export default function MotionExperience() {
    const { pathname } = useLocation()
    const isAdmin = pathname.startsWith('/admin')

    useEffect(() => {
        if (isAdmin || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined

        const root = document.documentElement
        const main = document.querySelector('main')
        if (!main) return undefined

        let updateFrame = null
        let collectFrame = null
        let targets = []
        let previousScrollY = window.scrollY
        let velocity = 0
        const activeTargets = new Set()

        root.classList.add('editorial-motion-active')

        const requestUpdate = () => {
            if (updateFrame === null) updateFrame = window.requestAnimationFrame(update)
        }

        const visibilityObserver = typeof IntersectionObserver === 'undefined'
            ? null
            : new IntersectionObserver((entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting) activeTargets.add(entry.target)
                    else activeTargets.delete(entry.target)
                })
                requestUpdate()
            }, { rootMargin: '38% 0px 38% 0px', threshold: 0 })

        const collectTargets = () => {
            collectFrame = null
            const nextTargets = Array.from(new Set(main.querySelectorAll(TARGET_SELECTOR)))
                .filter((element) => !element.closest('[role="dialog"]') && !element.classList.contains('fixed'))
            const nextSet = new Set(nextTargets)

            targets.forEach((target) => {
                if (nextSet.has(target)) return
                visibilityObserver?.unobserve?.(target)
                activeTargets.delete(target)
                clearMotionStyles(target)
            })

            let mediaIndex = 0
            nextTargets.forEach((target, index) => {
                const isMedia = isMediaTarget(target)
                const position = isMedia ? mediaIndex % 3 : index % 3
                if (isMedia) mediaIndex += 1

                target.classList.add('editorial-motion-frame', `editorial-index-${position}`)
                target.classList.toggle('editorial-motion-media', isMedia)

                if (!targets.includes(target)) {
                    if (visibilityObserver) visibilityObserver.observe(target)
                    else activeTargets.add(target)
                }
            })

            targets = nextTargets
            requestUpdate()
        }

        const requestCollection = () => {
            if (collectFrame === null) collectFrame = window.requestAnimationFrame(collectTargets)
        }

        function update() {
            updateFrame = null
            const viewportHeight = Math.max(window.innerHeight, 1)
            const scrollY = window.scrollY
            velocity += ((scrollY - previousScrollY) - velocity) * 0.24
            previousScrollY = scrollY
            const motionKick = clamp(velocity, -24, 24)
            const pageProgress = clamp(
                scrollY / Math.max(document.documentElement.scrollHeight - viewportHeight, 1),
                0,
                1,
            )

            root.style.setProperty('--editorial-progress', pageProgress.toFixed(5))
            root.style.setProperty('--editorial-speed', clamp(Math.abs(velocity) / 42, 0, 1).toFixed(4))

            activeTargets.forEach((target) => {
                const bounds = target.getBoundingClientRect()
                const measuredHeight = Math.min(Math.max(bounds.height, 1), viewportHeight)
                const progress = clamp((viewportHeight - bounds.top) / (viewportHeight + measuredHeight), 0, 1)
                const phase = (progress - 0.5) * 2
                const presence = clamp(1 - Math.abs(phase) * 0.28, 0.72, 1)
                const position = target.classList.contains('editorial-index-0')
                    ? -1
                    : target.classList.contains('editorial-index-2') ? 1 : 0
                const isMedia = target.classList.contains('editorial-motion-media')
                const amplitude = isMedia ? 1 : 0.76

                target.style.setProperty('--editorial-x', `${(position * (1 - presence) * 36 * amplitude).toFixed(2)}px`)
                target.style.setProperty('--editorial-y', `${(phase * -52 * amplitude - motionKick * 0.1).toFixed(2)}px`)
                target.style.setProperty('--editorial-card-y', `${(phase * -16 - motionKick * 0.08).toFixed(2)}px`)
                target.style.setProperty('--editorial-card-rotation', `${(position * phase * 0.62 + position * motionKick * 0.004).toFixed(3)}deg`)
                target.style.setProperty('--editorial-card-scale', (0.978 + presence * 0.022).toFixed(5))
                target.style.setProperty('--editorial-scale', (0.95 + presence * 0.05).toFixed(5))
                target.style.setProperty('--editorial-rotation', `${(position * phase * 0.72 * amplitude).toFixed(3)}deg`)
                target.style.setProperty('--editorial-saturation', (0.92 + presence * 0.08).toFixed(4))
            })
        }

        const mutationObserver = new MutationObserver(requestCollection)
        mutationObserver.observe(main, { childList: true, subtree: true })
        collectTargets()
        window.addEventListener('scroll', requestUpdate, { passive: true })
        window.addEventListener('resize', requestUpdate)

        return () => {
            mutationObserver.disconnect()
            visibilityObserver?.disconnect()
            window.removeEventListener('scroll', requestUpdate)
            window.removeEventListener('resize', requestUpdate)
            if (updateFrame !== null) window.cancelAnimationFrame(updateFrame)
            if (collectFrame !== null) window.cancelAnimationFrame(collectFrame)
            targets.forEach(clearMotionStyles)
            root.classList.remove('editorial-motion-active')
            root.style.removeProperty('--editorial-progress')
            root.style.removeProperty('--editorial-speed')
        }
    }, [isAdmin, pathname])

    if (isAdmin) return null

    return (
        <div className="editorial-motion-overlay" aria-hidden="true">
            <div className="editorial-light-leak" />
            <div className="editorial-exposure-sweep" />
            <div className="editorial-gate"><i /><i /><i /><i /></div>
            <span className="editorial-progress"><i /></span>
        </div>
    )
}
