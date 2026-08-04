import { useEffect, useRef, useState } from 'react'

export default function BackToTop() {
    const [isVisible, setIsVisible] = useState(false)
    const [footerVisible, setFooterVisible] = useState(false)
    const visibleRef = useRef(false)

    useEffect(() => {
        let frame = null
        const update = () => {
            frame = null
            const nextVisible = window.scrollY > 500
            if (nextVisible !== visibleRef.current) {
                visibleRef.current = nextVisible
                setIsVisible(nextVisible)
            }
        }
        const onScroll = () => {
            if (frame === null) frame = window.requestAnimationFrame(update)
        }
        window.addEventListener('scroll', onScroll, { passive: true })
        return () => {
            window.removeEventListener('scroll', onScroll)
            if (frame !== null) window.cancelAnimationFrame(frame)
        }
    }, [])

    useEffect(() => {
        const footer = document.querySelector('footer')
        if (!footer || typeof IntersectionObserver === 'undefined') return undefined
        const observer = new IntersectionObserver(([entry]) => {
            setFooterVisible(entry.isIntersecting)
        }, { threshold: 0.01 })
        observer.observe(footer)
        return () => observer.disconnect()
    }, [])

    if (!isVisible || footerVisible) return null
    return (
        <button
            type="button"
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            className="fixed bottom-6 right-6 z-50 p-4 rounded-full bg-charcoal/80 hover:bg-amber text-white shadow-warm-lg backdrop-blur-md transition-all duration-300 cursor-pointer group animate-scale-in"
            aria-label="Back to top"
        >
            <svg className="w-6 h-6 transform group-hover:-translate-y-1 transition-transform duration-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 10l7-7m0 0l7 7m-7-7v18" />
            </svg>
        </button>
    )
}
