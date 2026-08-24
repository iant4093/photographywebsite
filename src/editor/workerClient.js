function workerErrorMessage(event, fallback) {
    return event?.message || event?.error?.message || fallback
}

export function workerRequest(worker, source, adjustments, clipping = false, {
    signal,
    timeoutMs = 12000,
    onProgress,
    reportProgress = false,
    timeoutMessage = 'Image preview processing timed out.',
} = {}) {
    return new Promise((resolve, reject) => {
        const id = crypto.randomUUID()
        let timer

        const cleanup = () => {
            globalThis.clearTimeout(timer)
            signal?.removeEventListener('abort', handleAbort)
            worker.removeEventListener('message', handleMessage)
            worker.removeEventListener('error', handleError)
            worker.removeEventListener('messageerror', handleMessageError)
        }
        const settle = (callback, value) => {
            cleanup()
            callback(value)
        }
        const handleMessage = ({ data }) => {
            if (data.id !== id) return
            if (Number.isFinite(data.progress) && !data.pixels && !data.error) {
                onProgress?.(Math.min(1, Math.max(0, data.progress)))
                return
            }
            if (data.error) settle(reject, new Error(data.error))
            else settle(resolve, data)
        }
        const handleError = (event) => settle(reject, new Error(workerErrorMessage(event, 'Image preview worker stopped unexpectedly.')))
        const handleMessageError = (event) => settle(reject, new Error(workerErrorMessage(event, 'The image preview result could not be read.')))
        const handleAbort = () => {
            const error = new Error('Preview render cancelled.')
            error.name = 'AbortError'
            settle(reject, error)
        }

        worker.addEventListener('message', handleMessage)
        worker.addEventListener('error', handleError)
        worker.addEventListener('messageerror', handleMessageError)
        signal?.addEventListener('abort', handleAbort, { once: true })
        if (signal?.aborted) {
            handleAbort()
            return
        }
        timer = globalThis.setTimeout(() => {
            settle(reject, new Error(timeoutMessage))
        }, timeoutMs)

        try {
            const pixels = new Uint8ClampedArray(source.pixels)
            worker.postMessage({ id, pixels: pixels.buffer, width: source.width, height: source.height, adjustments, clipping, reportProgress }, [pixels.buffer])
        } catch (error) {
            settle(reject, error)
        }
    })
}
