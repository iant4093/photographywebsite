import { deleteImages } from './api'

// Only a server-persisted, already-authorized deletion can be resumed. One
// attempt per media-manager load; normal reads never make this extra request.
export async function recoverDeletion(token, albumId, keys, options) {
    if (!Array.isArray(keys) || !keys.length || keys.length > 250 || keys.some(key => typeof key !== 'string')) return
    try { await deleteImages(token, albumId, keys, options) } catch (error) {
        if (error?.name === 'AbortError') throw error
        // Keep the remaining gallery accessible. The durable intent survives
        // a provider outage and the next manager visit resumes it again.
    }
}
