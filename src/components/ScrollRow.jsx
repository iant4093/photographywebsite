import { useRef, useState, useEffect, useCallback, useLayoutEffect } from 'react'
import { saveHorizontalScroll, getHorizontalScroll } from '../utils/scroll'
import { createRowScrollController } from '../utils/rowScroll'

const EDGE_FADE = 'linear-gradient(90deg,transparent,#000 4%,#000 96%,transparent)'
const SCROLL_VIEWPORT_STYLE = {
    WebkitMaskImage: EDGE_FADE,
    maskImage: EDGE_FADE,
    scrollPaddingInline: '2rem',
}

// Horizontal scroll row with left/right arrow buttons on desktop
export default function ScrollRow({ children, className = '', scrollKey }) {
    const scrollRef = useRef(null)
    const controllerRef = useRef(null)
    const [canScrollLeft, setCanScrollLeft] = useState(false)
    const [canScrollRight, setCanScrollRight] = useState(false)

    const checkScroll = useCallback(() => {
        const el = scrollRef.current
        if (!el) return
        const { scrollLeft, scrollWidth, clientWidth } = el
        const nextLeft = scrollLeft > 2
        const nextRight = scrollLeft + clientWidth < scrollWidth - 2
        setCanScrollLeft((current) => current === nextLeft ? current : nextLeft)
        setCanScrollRight((current) => current === nextRight ? current : nextRight)
    }, [])

    // Restore horizontal scroll position on mount
    useLayoutEffect(() => {
        if (!scrollKey) return
        const el = scrollRef.current
        if (!el) return
        const saved = getHorizontalScroll(scrollKey)
        if (saved !== undefined) {
            el.scrollLeft = saved
        }
    }, [scrollKey])

    useEffect(() => {
        const el = scrollRef.current
        if (!el) return

        checkScroll()
        const controller = createRowScrollController(el)
        controllerRef.current = controller

        let frame = null
        const handleScroll = () => {
            if (scrollKey) saveHorizontalScroll(scrollKey, el.scrollLeft)
            if (frame === null) {
                frame = window.requestAnimationFrame(() => {
                    frame = null
                    checkScroll()
                })
            }
        }

        el.addEventListener('scroll', handleScroll, { passive: true })
        const handleResize = () => { controller.cancel(); checkScroll() }
        const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(handleResize)
        resizeObserver?.observe(el)
        if (!resizeObserver) window.addEventListener('resize', handleResize)

        // Re-check after images/content may have loaded
        const timer = setTimeout(checkScroll, 500)

        return () => {
            controller.destroy()
            if (controllerRef.current === controller) controllerRef.current = null
            el.removeEventListener('scroll', handleScroll)
            resizeObserver?.disconnect()
            if (!resizeObserver) window.removeEventListener('resize', handleResize)
            if (frame !== null) window.cancelAnimationFrame(frame)
            clearTimeout(timer)
        }
    }, [checkScroll, scrollKey])

    const scroll = (direction) => {
        controllerRef.current?.scroll(direction)
    }

    return (
        <div className="relative group/scroll">
            {/* Touch rows keep native snapping. Desktop arrows own the complete
                motion so browser snapping cannot add a second correction. */}
            <div
                ref={scrollRef}
                style={SCROLL_VIEWPORT_STYLE}
                className={`flex overflow-x-auto gap-6 px-8 -mx-6 pt-6 pb-10 snap-x snap-mandatory md:snap-none scrollbar-hide ${className}`}
            >
                {children}
            </div>

            {/* Left arrow — desktop only */}
            {canScrollLeft && (
                <button
                    onClick={() => scroll('left')}
                    className="hidden md:flex absolute left-3 top-1/2 -translate-y-1/2 z-20
                        w-11 h-11 items-center justify-center rounded-full
                        bg-white/90 backdrop-blur-sm border border-warm-border
                        shadow-warm-lg hover:shadow-warm-xl hover:bg-white
                        text-charcoal hover:text-amber-dark
                        transition-all duration-300 cursor-pointer
                        opacity-0 group-hover/scroll:opacity-100"
                    aria-label="Scroll left"
                    data-camera-cursor="previous"
                >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                </button>
            )}

            {/* Right arrow — desktop only */}
            {canScrollRight && (
                <button
                    onClick={() => scroll('right')}
                    className="hidden md:flex absolute right-3 top-1/2 -translate-y-1/2 z-20
                        w-11 h-11 items-center justify-center rounded-full
                        bg-white/90 backdrop-blur-sm border border-warm-border
                        shadow-warm-lg hover:shadow-warm-xl hover:bg-white
                        text-charcoal hover:text-amber-dark
                        transition-all duration-300 cursor-pointer
                        opacity-0 group-hover/scroll:opacity-100"
                    aria-label="Scroll right"
                    data-camera-cursor="next"
                >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                </button>
            )}
        </div>
    )
}
