// Bounds full-resolution working buffers without reducing supported image quality.
export const MAX_DECODE_PIXELS = 100_000_000
export function validateDimensions(width, height) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
        || width > 32767 || height > 32767 || width * height > MAX_DECODE_PIXELS) {
        throw new Error('This image is too large to safely edit in this browser.')
    }
    return width * height
}

export function decodeBudget(file, { signal, timeoutMs = 120_000 } = {}) {
    if (!Number.isFinite(file?.size) || file.size < 1 || file.size > 500 * 1024 * 1024) {
        throw new Error('This photo exceeds the browser editing file limit.')
    }
    const controller = new AbortController()
    const abort = () => controller.abort(new DOMException('Photo loading cancelled.', 'AbortError'))
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('Photo decoding timed out. Please try another file.')), timeoutMs)
    return {
        signal: controller.signal,
        wait(promise, disposeLate) {
            return new Promise((resolve, reject) => {
                let abandoned = false
                const stop = () => { abandoned = true; reject(controller.signal.reason) }
                if (controller.signal.aborted) stop()
                else controller.signal.addEventListener('abort', stop, { once: true })
                Promise.resolve(promise).then(value => {
                    controller.signal.removeEventListener('abort', stop)
                    if (abandoned) disposeLate?.(value)
                    else resolve(value)
                }, error => { controller.signal.removeEventListener('abort', stop); reject(error) })
            })
        },
        close() { clearTimeout(timer); signal?.removeEventListener('abort', abort) },
    }
}
