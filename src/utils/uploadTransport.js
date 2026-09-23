import { ApiError, wait, responseRetryDelay, MAX_AUTOMATIC_RETRY_DELAY_MS } from './api'

// fetch does not expose upload progress. Use XHR for transfers that display it,
// keeping the same signed PUT, headers, response and cancellation semantics.
export function uploadWithProgress(url, file, headers, { signal, onProgress, stallTimeoutMs = 120_000 }) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException('Request aborted', 'AbortError'))
            return
        }
        const xhr = new XMLHttpRequest()
        let timer
        let stalled = false
        let lastLoaded = 0
        const cleanup = () => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', abort)
        }
        const watchProgress = () => {
            clearTimeout(timer)
            timer = setTimeout(() => { stalled = true; xhr.abort() }, Math.max(1000, stallTimeoutMs))
        }
        const abort = () => xhr.abort()
        xhr.upload.onprogress = (event) => {
            if (event.loaded > lastLoaded) { lastLoaded = event.loaded; watchProgress() }
            onProgress({ loaded: Math.min(event.loaded, file.size), total: file.size })
        }
        xhr.upload.onload = watchProgress
        xhr.onload = () => {
            cleanup()
            const responseHeaders = new Headers()
            for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
                const separator = line.indexOf(':')
                if (separator > 0) responseHeaders.append(line.slice(0, separator), line.slice(separator + 1).trim())
            }
            resolve(new Response(xhr.responseText || null, { status: xhr.status, headers: responseHeaders }))
        }
        xhr.onerror = xhr.ontimeout = () => {
            cleanup()
            reject(new TypeError('Upload connection failed'))
        }
        xhr.onabort = () => {
            cleanup()
            reject(stalled ? new TypeError('Upload connection stalled') : new DOMException('Request aborted', 'AbortError'))
        }
        try {
            xhr.open('PUT', url)
            for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value)
            signal?.addEventListener('abort', abort, { once: true })
            // A retry starts this file over; do not count its previous attempt
            // as completed progress. The rate tracker still counts bytes sent.
            onProgress({ loaded: 0, total: file.size })
            watchProgress()
            xhr.send(file)
        } catch (error) {
            cleanup()
            reject(error)
        }
    })
}

export async function uploadFileToS3(presignedUrl, file, requiredHeaders = {}, options = {}) {
    const uploadHeaders = Object.keys(requiredHeaders).length > 0
        ? requiredHeaders
        : { 'Content-Type': file.type }
    const retries = Math.max(0, Math.min(options.retries ?? 1, 2))

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        let response
        try {
            // Visitors never need the XHR progress transport. Load it only
            // when an upload actually requests progress reporting.
            response = options.onProgress
                ? await uploadWithProgress(presignedUrl, file, uploadHeaders, options)
                : await fetch(presignedUrl, {
                    method: 'PUT',
                    headers: uploadHeaders,
                    body: file,
                    signal: options.signal,
                })
        } catch (error) {
            if (error?.name === 'AbortError') throw error
            if (attempt < retries) {
                await wait(400 * (2 ** attempt) + Math.random() * 200, options.signal)
                continue
            }
            throw new ApiError('The upload was interrupted. Please try again.', { code: 'UPLOAD_NETWORK_ERROR' })
        }

        const retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status)
        if (retryable && attempt < retries) {
            const delay = responseRetryDelay(response, attempt, 400, 200)
            if (delay <= MAX_AUTOMATIC_RETRY_DELAY_MS) {
                await response.text().catch(() => '')
                await wait(delay, options.signal)
                continue
            }
        }
        if (!response.ok) throw new ApiError('The upload could not be completed. Please try again.', {
            status: response.status,
            code: 'UPLOAD_FAILED',
        })
        options.onProgress?.({ loaded: file.size, total: file.size })
        return response
    }

    throw new ApiError('The upload could not be completed. Please try again.', { code: 'UPLOAD_FAILED' })
}
