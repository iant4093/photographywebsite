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
