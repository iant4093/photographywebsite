import { useCallback, useEffect, useRef } from 'react'
import { useLocation } from 'react-router'

const TARGET_SELECTOR = [
    'main .home-hero',
    'main .linen-video-hero',
    'main .linen-section-heading',
    'main .catalog-section',
    'main .photo-stats-hero',
    'main .photo-stats-motion-section',
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
    const usesCatalogMotion = ['/', '/search', '/videos', '/stats'].includes(pathname)
    const progressRef = useRef(null)
    const dragRef = useRef(null)

    const scrollFromPointer = useCallback((clientY, pointerOffset) => {
        const rail = progressRef.current
        const thumb = rail?.firstElementChild
        if (!rail || !thumb) return

        const railBounds = rail.getBoundingClientRect()
        const thumbTravel = Math.max(rail.clientHeight - thumb.offsetHeight, 0)
        const pageTravel = Math.max(document.documentElement.scrollHeight - window.innerHeight, 0)
        if (thumbTravel <= 0 || pageTravel <= 0) return

        const thumbTop = clamp(clientY - railBounds.top - pointerOffset, 0, thumbTravel)
        window.scrollTo({
            top: (thumbTop / thumbTravel) * pageTravel,
            left: 0,
            behavior: 'instant',
        })
    }, [])

    const handlePointerDown = useCallback((event) => {
        if (event.button !== 0) return
        const rail = progressRef.current
        const thumb = rail?.firstElementChild
        if (!rail || !thumb) return

        const thumbBounds = thumb.getBoundingClientRect()
        const pointerOffset = event.target === thumb
            ? event.clientY - thumbBounds.top
            : thumbBounds.height / 2
        dragRef.current = { pointerId: event.pointerId, pointerOffset }
        rail.classList.add('is-dragging')
        rail.setPointerCapture?.(event.pointerId)
        scrollFromPointer(event.clientY, pointerOffset)
        event.preventDefault()
    }, [scrollFromPointer])

    const handlePointerMove = useCallback((event) => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        scrollFromPointer(event.clientY, drag.pointerOffset)
    }, [scrollFromPointer])

    const endPointerDrag = useCallback((event) => {
        const rail = progressRef.current
        const drag = dragRef.current
        if (!drag || (event.pointerId !== undefined && drag.pointerId !== event.pointerId)) return
        rail?.releasePointerCapture?.(drag.pointerId)
        rail?.classList.remove('is-dragging')
        dragRef.current = null
    }, [])

    const handleScrollKey = useCallback((event) => {
        const pageTravel = Math.max(document.documentElement.scrollHeight - window.innerHeight, 0)
        const pageStep = window.innerHeight * 0.85
        const lineStep = Math.min(120, window.innerHeight * 0.12)
        let nextScroll = window.scrollY

        if (event.key === 'ArrowDown') nextScroll += lineStep
        else if (event.key === 'ArrowUp') nextScroll -= lineStep
        else if (event.key === 'PageDown') nextScroll += pageStep
        else if (event.key === 'PageUp') nextScroll -= pageStep
        else if (event.key === 'Home') nextScroll = 0
        else if (event.key === 'End') nextScroll = pageTravel
        else return

        event.preventDefault()
        window.scrollTo({
            top: clamp(nextScroll, 0, pageTravel),
            left: 0,
            behavior: 'smooth',
        })
    }, [])

    useEffect(() => {
        if (isAdmin || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined

        const root = document.documentElement
        const main = document.querySelector('main')
        const progressRail = progressRef.current
        if (!main) return undefined

        let updateFrame = null
        let collectFrame = null
        let targets = []
        let previousScrollY = window.scrollY
        let velocity = 0
        const activeTargets = new Set()

        root.classList.add('editorial-motion-active', 'editorial-scrollbar-active')

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
            const pageTravel = Math.max(document.documentElement.scrollHeight - viewportHeight, 0)
            const pageProgress = clamp(scrollY / Math.max(pageTravel, 1), 0, 1)
            let progressThumb = null
            let isScrollable = false
            let thumbTravel = 0
            if (progressRail) {
                progressThumb = progressRail.firstElementChild
                isScrollable = pageTravel > 1
                thumbTravel = isScrollable && progressThumb
                    ? Math.max(progressRail.clientHeight - progressThumb.offsetHeight, 0)
                    : 0
            }

            const measurements = []
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

                measurements.push({ target, position, presence, phase, amplitude })
            })

            if (progressRail) {
                progressRail.hidden = !isScrollable
                progressRail.setAttribute('aria-valuenow', String(Math.round(pageProgress * 100)))
                if (isScrollable && progressThumb) {
                    progressRail.style.setProperty(
                        '--editorial-progress-offset',
                        `${(pageProgress * thumbTravel).toFixed(2)}px`,
                    )
                }
            }
            root.style.setProperty('--editorial-progress', pageProgress.toFixed(5))
            root.style.setProperty('--editorial-speed', clamp(Math.abs(velocity) / 42, 0, 1).toFixed(4))

            measurements.forEach(({ target, position, presence, phase, amplitude }) => {
                if (usesCatalogMotion) {
                    target.style.setProperty('--editorial-x', '0px')
                    target.style.setProperty('--editorial-y', `${(phase * -44 - motionKick * 0.085).toFixed(2)}px`)
                    target.style.setProperty('--editorial-card-y', `${(phase * -32 - motionKick * 0.075).toFixed(2)}px`)
                    target.style.setProperty('--editorial-card-rotation', '0deg')
                    target.style.setProperty('--editorial-card-scale', (0.87 + presence * 0.13).toFixed(5))
                    target.style.setProperty('--editorial-scale', (0.93 + presence * 0.07).toFixed(5))
                    target.style.setProperty('--editorial-rotation', '0deg')
                    target.style.setProperty('--editorial-saturation', (0.88 + presence * 0.12).toFixed(4))
                    return
                }

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
            root.classList.remove('editorial-motion-active', 'editorial-scrollbar-active')
            root.style.removeProperty('--editorial-progress')
            root.style.removeProperty('--editorial-speed')
            progressRail?.style.removeProperty('--editorial-progress-offset')
        }
    }, [isAdmin, pathname, usesCatalogMotion])

    if (isAdmin) return null

    return (
        <div
            ref={progressRef}
            className="editorial-progress"
            role="scrollbar"
            aria-label="Page scroll position"
            aria-controls="root"
            aria-orientation="vertical"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow="0"
            tabIndex={0}
            onKeyDown={handleScrollKey}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endPointerDrag}
            onPointerCancel={endPointerDrag}
            onLostPointerCapture={endPointerDrag}
        >
            <i aria-hidden="true" />
        </div>
    )
}
