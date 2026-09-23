// A save can continue in the existing worker while privacy tags are reconciled.
// Keep the current Save interaction and retry only explicit, safe continuations.
export async function completeAlbumMutation(request, signal, { timeoutMs = 600_000, delayMs = 1000 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (true) {
        signal?.throwIfAborted()
        try {
            const result = await request()
            if (result?.pending !== true) return result
        } catch (error) {
            if (error?.code !== 'MEDIA_BUSY') throw error
        }
        if (Date.now() >= deadline) throw new Error('This change is still being completed. Please retry shortly.')
        await new Promise((resolve, reject) => {
            const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(signal.reason) }
            const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve() }, delayMs)
            if (signal?.aborted) stop()
            else signal?.addEventListener('abort', stop, { once: true })
        })
    }
}
