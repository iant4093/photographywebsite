// fetch does not expose upload progress. Use XHR for transfers that display it,
// keeping the same signed PUT, headers, response and cancellation semantics.
export function uploadWithProgress(url, file, headers, { signal, onProgress }) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException('Request aborted', 'AbortError'))
            return
        }
        const xhr = new XMLHttpRequest()
        const cleanup = () => signal?.removeEventListener('abort', abort)
        const abort = () => xhr.abort()
        xhr.upload.onprogress = (event) => {
            onProgress({ loaded: Math.min(event.loaded, file.size), total: file.size })
        }
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
            reject(new DOMException('Request aborted', 'AbortError'))
        }
        try {
            xhr.open('PUT', url)
            for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value)
            signal?.addEventListener('abort', abort, { once: true })
            // A retry starts this file over; do not count its previous attempt
            // as completed progress. The rate tracker still counts bytes sent.
            onProgress({ loaded: 0, total: file.size })
            xhr.send(file)
        } catch (error) {
            cleanup()
            reject(error)
        }
    })
}
