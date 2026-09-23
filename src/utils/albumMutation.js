// A save can continue in the existing worker while privacy tags are reconciled.
// Keep the current Save interaction and retry only explicit, safe continuations.
export async function completeAlbumMutation(request, signal, { timeoutMs = 600_000, delayMs = 1000, missingAfterPending = false } = {}) {
    const deadline = Date.now() + timeoutMs
    let attempts = 0
    let pending = false
    while (true) {
        signal?.throwIfAborted()
        let retryAfter
        try {
            const result = await request()
            if (result?.pending !== true) return result
            pending = true
            retryAfter = Number(result.retryAfter) * 1000 || 0
        } catch (error) {
            if (pending && missingAfterPending && error?.status === 404) return { complete: true }
            if (error?.code !== 'MEDIA_BUSY') throw error
            retryAfter = error.retryAfterMs || 0
        }
        if (Date.now() >= deadline) throw new Error('This change is still being completed. Please retry shortly.')
        const waitMs = Math.min(deadline - Date.now(), 30_000, Math.max(retryAfter, Math.min(15_000, delayMs * 2 ** Math.min(attempts++, 4))))
        await new Promise((resolve, reject) => {
            const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(signal.reason) }
            const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve() }, waitMs)
            if (signal?.aborted) stop()
            else signal?.addEventListener('abort', stop, { once: true })
        })
    }
}
