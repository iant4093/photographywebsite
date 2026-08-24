const registeredSources = new WeakMap()

function workerErrorMessage(event, fallback) {
    return event?.message || event?.error?.message || fallback
}

function sourcePayload(worker, source, sourceId) {
    if (!sourceId) {
        const pixels = new Uint8ClampedArray(source.pixels)
        return { pixels: pixels.buffer, transfer: [pixels.buffer] }
    }
    let registrations = registeredSources.get(worker)
    if (!registrations) {
        registrations = new Set()
        registeredSources.set(worker, registrations)
    }
    if (registrations.has(sourceId)) return { sourceId, transfer: [] }
    const pixels = new Uint8ClampedArray(source.pixels)
    registrations.add(sourceId)
    return { sourceId, pixels: pixels.buffer, transfer: [pixels.buffer] }
}

export function workerRequest(worker, source, adjustments, clipping = false, {
    signal,
    timeoutMs = 12000,
    onProgress,
    reportProgress = false,
    timeoutMessage = 'Image preview processing timed out.',
    sourceId,
    includeHistogram = true,
    outputType = 'pixels',
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
            if (Number.isFinite(data.progress) && !data.pixels && !data.bitmap && !data.error) {
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
        timer = globalThis.setTimeout(() => settle(reject, new Error(timeoutMessage)), timeoutMs)

        let payload
        try {
            payload = sourcePayload(worker, source, sourceId)
            worker.postMessage({
                id,
                ...payload,
                width: source.width,
                height: source.height,
                adjustments,
                clipping,
                reportProgress,
                includeHistogram,
                outputType,
            }, payload.transfer)
        } catch (error) {
            if (sourceId) registeredSources.get(worker)?.delete(sourceId)
            settle(reject, error)
        }
    })
}
