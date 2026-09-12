import { useCallback, useEffect, useRef } from 'react'
import { useLocation } from 'react-router'
import useMediaQuery from '../hooks/useMediaQuery'

const TARGET_CLASSES = ['linen-section-heading', 'photo-stats-hero', 'photo-stats-motion-section', 'album-card']
const TARGET_SELECTOR = [...TARGET_CLASSES.map(name => `main .${name}`), 'main .linen-gallery-page [data-page-scroll-media]'].join(', ')
// Detached removed subtrees no longer match the `main ...` selectors above.
const CANDIDATE_SELECTOR = [...TARGET_CLASSES.map(name => `.${name}`), '[data-page-scroll-media]', '.editorial-motion-frame'].join(', ')

function changesMotionTargets(records) {
    return records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => (
        node instanceof Element && (node.matches(CANDIDATE_SELECTOR) || node.querySelector(CANDIDATE_SELECTOR))
    )))
}

function setMotionStyle(target, property, value, unit = '', precision = 2) {
    const name = `--editorial-${property}`
    const formatted = value.toFixed(precision) + unit
    if (target.style.getPropertyValue(name) !== formatted) target.style.setProperty(name, formatted)
}

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value))

function isMediaTarget(element) {
    return element.classList.contains('album-card')
        || element.hasAttribute('data-page-scroll-media')
}

function clearMotionStyles(target) {
    target.classList.remove(
        'editorial-motion-frame',
        'is-motion-visible',
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
    const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
    const progressRef = useRef(null)
    const dragRef = useRef(null)

    const scrollFromPointer = useCallback(() => {
        const rail = progressRef.current
        const drag = dragRef.current
        if (!rail || !drag) return

        drag.frame = null
        const { clientY, railTop, pointerOffset, thumbTravel, pageTravel } = drag
        const thumbTop = clamp(clientY - railTop - pointerOffset, 0, thumbTravel)
        // Move the handle in the same frame as the page, without waiting for
        // the next scroll event or measuring freshly animated page content.
        setMotionStyle(rail, 'progress-offset', thumbTop, 'px')
        rail.setAttribute('aria-valuenow', String(Math.round(thumbTop / thumbTravel * 100)))
        window.scrollTo({
            top: (thumbTop / thumbTravel) * pageTravel,
            left: 0,
            behavior: 'instant',
        })
    }, [])

    const handlePointerDown = (event) => {
        if (event.button !== 0 || dragRef.current) return
        const rail = progressRef.current
        const thumb = rail?.firstElementChild
        if (!rail || !thumb) return

        const railBounds = rail.getBoundingClientRect()
        const thumbBounds = thumb.getBoundingClientRect()
        const thumbTravel = Math.max(rail.clientHeight - thumb.offsetHeight, 0)
        const pageTravel = Math.max(document.documentElement.scrollHeight - window.innerHeight, 0)
        if (thumbTravel <= 0 || pageTravel <= 0) return

        // The entire 44px-wide hit area should grab the handle without a jump.
        const grabsThumb = event.clientY >= thumbBounds.top && event.clientY <= thumbBounds.bottom
        const pointerOffset = grabsThumb
            ? event.clientY - thumbBounds.top
            : thumbBounds.height / 2
        dragRef.current = {
            rail, pointerId: event.pointerId, pointerOffset, thumbTravel, pageTravel,
            railTop: railBounds.top, clientY: event.clientY, frame: null,
        }
        setMotionStyle(rail, 'progress-offset', thumbBounds.top - railBounds.top, 'px')
        rail.classList.add('is-dragging')
        rail.setPointerCapture?.(event.pointerId)
        rail.focus({ preventScroll: true })
        if (!grabsThumb) scrollFromPointer()
        else window.scrollTo({ top: window.scrollY, left: 0, behavior: 'instant' })
        event.preventDefault()
    }

    const handlePointerMove = (event) => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        drag.clientY = event.clientY
        if (drag.frame === null) drag.frame = window.requestAnimationFrame(scrollFromPointer)
    }

    const endPointerDrag = useCallback((event) => {
        const drag = dragRef.current
        if (!drag || (event.pointerId !== undefined && drag.pointerId !== event.pointerId)) return
        const { rail } = drag
        if (drag.frame !== null) {
            window.cancelAnimationFrame(drag.frame)
            if (event.type === 'pointerup') scrollFromPointer()
        }
        dragRef.current = null
        rail.classList.remove('is-dragging')
        if (!rail.hasPointerCapture || rail.hasPointerCapture(drag.pointerId)) rail.releasePointerCapture?.(drag.pointerId)
    }, [scrollFromPointer])

    useEffect(() => {
        const cancelDrag = () => endPointerDrag({})
        window.addEventListener('blur', cancelDrag)
        window.addEventListener('resize', cancelDrag)
        return () => {
            cancelDrag()
            window.removeEventListener('blur', cancelDrag)
            window.removeEventListener('resize', cancelDrag)
        }
    }, [pathname, reducedMotion, endPointerDrag])

    const handleScrollKey = (event) => {
        const pageTravel = Math.max(document.documentElement.scrollHeight - window.innerHeight, 0)
        const pageStep = window.innerHeight * 0.85
        const lineStep = Math.min(120, window.innerHeight * 0.12)
        const scrollY = window.scrollY
        const nextScroll = {
            ArrowDown: scrollY + lineStep,
            ArrowUp: scrollY - lineStep,
            PageDown: scrollY + pageStep,
            PageUp: scrollY - pageStep,
            Home: 0,
            End: pageTravel,
        }[event.key]
        if (typeof nextScroll !== 'number') return

        event.preventDefault()
        window.scrollTo({
            top: clamp(nextScroll, 0, pageTravel),
            left: 0,
            behavior: 'smooth',
        })
    }

    useEffect(() => {
        if (isAdmin || reducedMotion) return undefined

        const root = document.documentElement
        const main = document.querySelector('main')
        const progressRail = progressRef.current
        if (!main) return undefined

        let updateFrame = null
        let collectFrame = null
        let targets = []
        const metadata = new Map()
        let layoutDirty = true
        let pageTravel = 0
        let thumbTravel = 0
        const activeTargets = new Set()
        const browserTracksScroll = window.CSS?.supports?.('animation-timeline', 'scroll(root block)') === true

        root.classList.add('editorial-motion-active', 'editorial-scrollbar-active')

        const requestUpdate = () => {
            if (!document.hidden && updateFrame === null) updateFrame = window.requestAnimationFrame(update)
        }

        const visibilityObserver = typeof IntersectionObserver === 'undefined'
            ? null
            : new IntersectionObserver((entries) => {
                entries.forEach((entry) => {
                    if (!metadata.has(entry.target)) return
                    if (entry.isIntersecting) activeTargets.add(entry.target)
                    else activeTargets.delete(entry.target)
                    entry.target.classList.toggle('is-motion-visible', entry.isIntersecting)
                })
                requestUpdate()
            }, { rootMargin: '160px 0px', threshold: 0 })

        const collectTargets = () => {
            collectFrame = null
            const nextTargets = Array.from(new Set(main.querySelectorAll(TARGET_SELECTOR)))
                .filter((element) => !element.closest('[role="dialog"]') && !element.classList.contains('fixed'))
            const nextSet = new Set(nextTargets)

            targets.forEach((target) => {
                if (nextSet.has(target)) return
                visibilityObserver?.unobserve?.(target)
                activeTargets.delete(target)
                metadata.delete(target)
                clearMotionStyles(target)
            })

            let mediaIndex = 0
            nextTargets.forEach((target, index) => {
                const isMedia = isMediaTarget(target)
                const position = isMedia ? mediaIndex % 3 : index % 3
                if (isMedia) mediaIndex += 1

                const previous = metadata.get(target)
                if (!previous || previous.position !== position) {
                    if (previous) target.classList.remove(`editorial-index-${previous.position}`)
                    target.classList.add('editorial-motion-frame', `editorial-index-${position}`)
                }
                if (!previous || previous.isMedia !== isMedia) target.classList.toggle('editorial-motion-media', isMedia)
                metadata.set(target, { ...previous, position, isMedia, inScrollRow: Boolean(target.closest('[data-scroll-row]')) })
                if (usesCatalogMotion) {
                    setMotionStyle(target, 'x', 0, 'px', 0)
                    setMotionStyle(target, 'card-rotation', 0, 'deg', 0)
                    setMotionStyle(target, 'rotation', 0, 'deg', 0)
                }

                if (!previous) {
                    if (visibilityObserver) visibilityObserver.observe(target)
                    else {
                        activeTargets.add(target)
                        target.classList.add('is-motion-visible')
                    }
                }
            })

            targets = nextTargets
            layoutDirty = true
            requestUpdate()
        }

        const requestCollection = () => {
            if (collectFrame === null) collectFrame = window.requestAnimationFrame(collectTargets)
        }

        function update() {
            updateFrame = null
            const viewportHeight = Math.max(window.innerHeight, 1)
            const scrollY = window.scrollY
            // Measure untransformed layout only when it changes. Measuring the
            // animated bounds feeds last frame's transform back into this frame,
            // producing jumps on slow direction changes. Never read card layout
            // during ordinary scrolling, and finish all reads before writes.
            if (layoutDirty) {
                targets.forEach(target => {
                    let top = 0
                    let element = target
                    while (element) {
                        top += element.offsetTop
                        element = element.offsetParent
                        if (element) top += element.clientTop
                    }
                    Object.assign(metadata.get(target), { top, height: target.offsetHeight })
                })
                pageTravel = Math.max(document.documentElement.scrollHeight - viewportHeight, 0)
                // Hidden rails have zero dimensions. Reveal before measuring;
                // this only runs when content or viewport dimensions change.
                if (progressRail) {
                    progressRail.hidden = pageTravel <= 1
                    thumbTravel = Math.max(progressRail.clientHeight - progressRail.firstElementChild.offsetHeight, 0)
                }
                layoutDirty = false
            }
            const pageProgress = clamp(scrollY / Math.max(pageTravel, 1), 0, 1)

            if (progressRail) {
                setMotionStyle(progressRail, 'progress-travel', thumbTravel, 'px')
                if (!dragRef.current) {
                    const progressValue = String(Math.round(pageProgress * 100))
                    if (progressRail.getAttribute('aria-valuenow') !== progressValue) progressRail.setAttribute('aria-valuenow', progressValue)
                }
                if (pageTravel > 1 && !browserTracksScroll && !dragRef.current) {
                    setMotionStyle(progressRail,
                        'progress-offset',
                        pageProgress * thumbTravel, 'px',
                    )
                }
            }

            targets.forEach((target) => {
                const info = metadata.get(target)
                // Keep horizontally clipped cards in step with their visible
                // neighbors before they slide into view. IntersectionObserver
                // still limits compositor hints to individual nearby cards;
                // cached vertical bounds limit work to nearby rows.
                if (info.inScrollRow) {
                    if (info.top - scrollY > viewportHeight + 160 || info.top + info.height - scrollY < -160) return
                } else if (!activeTargets.has(target)) return
                const measuredHeight = Math.min(Math.max(info.height, 1), viewportHeight)
                const progress = clamp((viewportHeight - (info.top - scrollY)) / (viewportHeight + measuredHeight), 0, 1)
                const phase = (progress - 0.5) * 2
                const presence = clamp(1 - Math.abs(phase) * 0.28, 0.72, 1)
                const position = info.position - 1
                const isMedia = info.isMedia
                const amplitude = isMedia ? 1 : 0.76

                setMotionStyle(target, 'y', phase * (usesCatalogMotion ? -44 : -52 * amplitude), 'px')
                setMotionStyle(target, 'card-y', phase * (usesCatalogMotion ? -32 : -16), 'px')
                setMotionStyle(target, 'card-scale', usesCatalogMotion ? 0.87 + presence * 0.13 : 0.978 + presence * 0.022, '', 5)
                setMotionStyle(target, 'scale', usesCatalogMotion ? 0.93 + presence * 0.07 : 0.95 + presence * 0.05, '', 5)
                if (usesCatalogMotion) return
                setMotionStyle(target, 'x', position * (1 - presence) * 36 * amplitude, 'px')
                setMotionStyle(target, 'card-rotation', position * phase * 0.62, 'deg', 3)
                setMotionStyle(target, 'rotation', position * phase * 0.72 * amplitude, 'deg', 3)
            })
        }

        const mutationObserver = new MutationObserver(records => {
            if (changesMotionTargets(records)) requestCollection()
        })
        mutationObserver.observe(main, { childList: true, subtree: true })
        // Image swaps inside fixed media frames do not alter the motion target
        // set. Observe actual page-size changes without recollecting every card.
        const refreshLayout = () => {
            layoutDirty = true
            requestUpdate()
        }
        const onVisibilityChange = () => {
            if (document.hidden && updateFrame !== null) {
                window.cancelAnimationFrame(updateFrame)
                updateFrame = null
            } else refreshLayout()
        }
        const layoutObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refreshLayout)
        layoutObserver?.observe(main)
        if (progressRail) layoutObserver?.observe(progressRail)
        collectTargets()
        window.addEventListener('scroll', requestUpdate, { passive: true })
        window.addEventListener('resize', refreshLayout)
        document.addEventListener('visibilitychange', onVisibilityChange)

        return () => {
            mutationObserver.disconnect()
            visibilityObserver?.disconnect()
            layoutObserver?.disconnect()
            window.removeEventListener('scroll', requestUpdate)
            window.removeEventListener('resize', refreshLayout)
            document.removeEventListener('visibilitychange', onVisibilityChange)
            if (updateFrame !== null) window.cancelAnimationFrame(updateFrame)
            if (collectFrame !== null) window.cancelAnimationFrame(collectFrame)
            targets.forEach(clearMotionStyles)
            root.classList.remove('editorial-motion-active', 'editorial-scrollbar-active')
            // Preserve the handle position until the next route measures its layout.
        }
    }, [isAdmin, pathname, reducedMotion, usesCatalogMotion])

    if (isAdmin) return null

    return (
        <div
            ref={progressRef}
            className="editorial-progress"
            data-camera-cursor="drag-y"
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
