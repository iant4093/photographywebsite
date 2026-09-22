import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router'
import {
    flushAnalytics,
    isPublicAnalyticsPath,
    trackFrontendError,
    trackPageView,
    trackSiteVisit,
    trackWebVital,
} from '../utils/analytics'

let visitRecorded = false

export default function AnalyticsTracker() {
    const location = useLocation()
    const pathnameRef = useRef(location.pathname)

    useEffect(() => {
        pathnameRef.current = location.pathname
    }, [location.pathname])

    useEffect(() => {
        if (!isPublicAnalyticsPath(location.pathname)) return
        if (!visitRecorded) {
            visitRecorded = true
            trackSiteVisit()
        }
        trackPageView()
    }, [location.pathname])

    useEffect(() => {
        // Web Vitals describe the document load. Never attribute an admin or
        // private-gallery load to public-site performance after SPA navigation.
        if (!isPublicAnalyticsPath(pathnameRef.current)) return undefined
        let active = true
        const controller = new AbortController()
        const options = { signal: controller.signal }
        const reportVital = ({ name, value, rating }) => {
            if (!active || !isPublicAnalyticsPath(pathnameRef.current)) return
            trackWebVital(name, Number(value.toFixed(3)), rating)
            if (document.visibilityState === 'hidden') void flushAnalytics({ exiting: true })
        }
        import('web-vitals').then(({ onCLS, onINP, onLCP }) => {
            if (!active) return
            onCLS(reportVital)
            onINP(reportVital)
            onLCP(reportVital)
        }).catch(() => {
            // Performance telemetry is optional and must never affect the site.
        })

        const onPageHide = () => void flushAnalytics({ exiting: true })
        const onVisibilityChange = () => { if (document.hidden) onPageHide() }
        const onError = (event) => {
            if (!isPublicAnalyticsPath(pathnameRef.current)) return
            trackFrontendError(event.target && event.target !== window ? 'resource' : 'runtime')
        }
        const onRejection = () => {
            if (isPublicAnalyticsPath(pathnameRef.current)) trackFrontendError('unhandled-rejection')
        }

        window.addEventListener('pagehide', onPageHide, options)
        document.addEventListener('visibilitychange', onVisibilityChange, options)
        window.addEventListener('error', onError, { ...options, capture: true })
        window.addEventListener('unhandledrejection', onRejection, options)
        return () => {
            active = false
            controller.abort()
        }
    }, [])

    return null
}
