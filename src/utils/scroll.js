// Shared scroll memory for the session
const scrollPositions = new Map()

// Persistent set of revealed IDs using sessionStorage to survive reloads/navigation
const getSavedRevealed = () => {
    try {
        const saved = sessionStorage.getItem('revealed_elements')
        return saved ? new Set(JSON.parse(saved)) : new Set()
    } catch (e) {
        return new Set()
    }
}

const revealedIds = getSavedRevealed()

const saveRevealed = () => {
    try {
        sessionStorage.setItem('revealed_elements', JSON.stringify([...revealedIds]))
    } catch (e) { }
}

/**
 * Checks if an element ID has already been revealed in this session.
 */
export const isRevealed = (id) => id ? revealedIds.has(id) : false

/**
 * Marks an element ID as revealed so it doesn't animate again.
 */
export const markAsRevealed = (id) => {
    if (id && !revealedIds.has(id)) {
        revealedIds.add(id)
        saveRevealed()
    }
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
