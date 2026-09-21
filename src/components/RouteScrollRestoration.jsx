import { useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router'
import { readDashboardScroll } from '../utils/dashboardScroll'
import { getSavedScroll } from '../utils/scroll'
import { watchScrollPosition } from '../utils/routeScroll'

// One owner outside Suspense covers every public and protected route. Each
// history entry owns its position, including separate visits to the same URL.
export default function RouteScrollRestoration() {
    const location = useLocation()
    const navigationType = useNavigationType()
    const previous = useRef(null)

    useLayoutEffect(() => {
        const prior = previous.current
        const route = location.pathname + location.search
        const returning = location.state?.restoreDashboardScroll || location.state?.restoreExploreScroll
        const fallback = location.state?.restoreDashboardScroll
            ? readDashboardScroll()
            : location.state?.restoreExploreScroll ? getSavedScroll('/explore') : undefined
        const samePage = prior?.pathname === location.pathname && !location.hash
        const stop = watchScrollPosition({
            key: `${location.key}:${route}${location.hash}`,
            route,
            restore: navigationType === 'POP' || returning,
            restoreRoute: returning,
            fallback,
            hash: location.hash,
            // Updating filters or removing a shared-photo query must not jump
            // the viewport. POP still restores that particular history entry.
            preserve: samePage && navigationType !== 'POP',
        })
        previous.current = location
        return stop
    }, [location, navigationType])

    return null
}
