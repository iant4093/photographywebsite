import { lazy, Suspense, useEffect, useState } from 'react'

const MistyEchoExperience = lazy(() => import('./MistyEchoExperience').catch(() => ({ default: () => null })))

export default function MistyEcho() {
    const [nearFooter, setNearFooter] = useState(false)

    useEffect(() => {
        const footer = document.querySelector('.linen-footer')
        if (!footer) return undefined
        const observer = new IntersectionObserver(entries => {
            if (!entries.some(entry => entry.isIntersecting)) return
            setNearFooter(true)
            observer.disconnect()
        }, { rootMargin: '0px 0px 1000px 0px' })
        observer.observe(footer)
        return () => observer.disconnect()
    }, [])

    return nearFooter ? <Suspense fallback={null}><MistyEchoExperience /></Suspense> : null
}
