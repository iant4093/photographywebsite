// Shared scroll memory for the session
const scrollPositions = new Map()

// Module-level set of revealed IDs. 
// This remains persistent during SPA navigation but resets on hard refresh.
const revealedIds = new Set()

/**
 * Checks if an element ID has already been revealed in this session instance.
 */
export const isRevealed = (id) => id ? revealedIds.has(id) : false

/**
 * Marks an element ID as revealed so it doesn't animate again during this JS session.
 */
export const markAsRevealed = (id) => {
    if (id) revealedIds.add(id)
}

/**
 * Save horizontal scroll position for a keyed scroll container.
 */
export const saveHorizontalScroll = (key, value) => {
    if (key) scrollPositions.set(`h:${key}`, value)
}

/**
 * Retrieve saved horizontal scroll position for a keyed scroll container.
 */
export const getHorizontalScroll = (key) => {
    return key ? scrollPositions.get(`h:${key}`) : undefined
}

/**
 * Explicitly save the current vertical scroll position for a pathname.
 * Useful before programmatic navigate() calls to prevent overwrite during transition.
 */
export const saveVerticalScroll = (pathname) => {
    scrollPositions.set(pathname, window.scrollY)
}

/**
 * Read the saved vertical scroll position for a pathname.
 */
export const getSavedScroll = (pathname) => {
    return scrollPositions.get(pathname)
}

/**
 * Hook to save and restore scroll position for a specific page.
 * @param {string} pathname The current route path
 * @param {boolean} isPOP Whether the current navigation is a POP (back/forward)
 */
import { useLayoutEffect, useEffect } from 'react'

export function useScrollRestoration(pathname, isPOP) {
    // Save scroll position on scroll
    useEffect(() => {
        const handleScroll = () => {
            scrollPositions.set(pathname, window.scrollY)
        }
        window.addEventListener('scroll', handleScroll, { passive: true })
        return () => window.removeEventListener('scroll', handleScroll)
    }, [pathname])

    // Restore scroll position instantly before paint
    useLayoutEffect(() => {
        if (isPOP) {
            const saved = scrollPositions.get(pathname)
            if (saved !== undefined) {
                // Use a tiny timeout to ensure the DOM has updated its height
                // even in mode="wait" where this might run slightly too early
                window.scrollTo({ top: saved, behavior: 'instant' })

                // Secondary check/retry in case of late image loading or layout shifts
                const timer = setTimeout(() => {
                    window.scrollTo({ top: saved, behavior: 'instant' })
                }, 10)
                return () => clearTimeout(timer)
            }
        }
    }, [pathname, isPOP])
}
