import { useRef, useState, useEffect, useCallback, useLayoutEffect } from 'react'
import { saveHorizontalScroll, getHorizontalScroll } from '../utils/scroll'

// Horizontal scroll row with left/right arrow buttons on desktop
export default function ScrollRow({ children, className = '', scrollKey }) {
    const scrollRef = useRef(null)
    const [canScrollLeft, setCanScrollLeft] = useState(false)
    const [canScrollRight, setCanScrollRight] = useState(false)

    const checkScroll = useCallback(() => {
        const el = scrollRef.current
        if (!el) return
        const { scrollLeft, scrollWidth, clientWidth } = el
        setCanScrollLeft(scrollLeft > 2)
        setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 2)
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

        // Save horizontal scroll position on scroll
        const handleScroll = () => {
            checkScroll()
            if (scrollKey) saveHorizontalScroll(scrollKey, el.scrollLeft)
        }

        el.addEventListener('scroll', handleScroll, { passive: true })
        window.addEventListener('resize', checkScroll)

        // Re-check after images/content may have loaded
        const timer = setTimeout(checkScroll, 500)

        return () => {
            el.removeEventListener('scroll', handleScroll)
            window.removeEventListener('resize', checkScroll)
            clearTimeout(timer)
        }
    }, [checkScroll, children, scrollKey])

    const scroll = (direction) => {
        const el = scrollRef.current
        if (!el) return
        const scrollAmount = el.clientWidth * 0.8
        el.scrollBy({ left: direction === 'left' ? -scrollAmount : scrollAmount, behavior: 'smooth' })
    }

    return (
        <div className="relative group/scroll">
            {/* Scroll container */}
            <div
                ref={scrollRef}
                className={`flex overflow-x-auto gap-6 pt-2 pb-8 snap-x snap-mandatory scrollbar-hide ${className}`}
            >
                {children}
            </div>

            {/* Left arrow — desktop only */}
            {canScrollLeft && (
                <button
                    onClick={() => scroll('left')}
                    className="hidden md:flex absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/2 z-20
                        w-11 h-11 items-center justify-center rounded-full
                        bg-white/90 backdrop-blur-sm border border-warm-border
                        shadow-warm-lg hover:shadow-warm-xl hover:bg-white
                        text-charcoal hover:text-amber-dark
                        transition-all duration-300 cursor-pointer
                        opacity-0 group-hover/scroll:opacity-100"
                    aria-label="Scroll left"
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
                    className="hidden md:flex absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 z-20
                        w-11 h-11 items-center justify-center rounded-full
                        bg-white/90 backdrop-blur-sm border border-warm-border
                        shadow-warm-lg hover:shadow-warm-xl hover:bg-white
                        text-charcoal hover:text-amber-dark
                        transition-all duration-300 cursor-pointer
                        opacity-0 group-hover/scroll:opacity-100"
                    aria-label="Scroll right"
                >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                </button>
            )}
        </div>
    )
}
