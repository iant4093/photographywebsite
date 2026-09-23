// Use the decoder's existing wire protocol while owning failure/cancellation.
export function rawWorkerClient(url, signal) {
    signal?.throwIfAborted()
    const worker = new Worker(url, { type: 'classic' })
    const pending = new Map()
    let id = 0, stopped = false
    const stop = (error = new DOMException('Photo loading cancelled.', 'AbortError')) => {
        if (stopped) return
        stopped = true
        worker.terminate()
        signal?.removeEventListener('abort', abort)
        for (const item of pending.values()) item.reject(error)
        pending.clear()
    }
    const abort = () => stop(signal.reason)
    worker.onerror = () => stop(new Error('The RAW decoder stopped unexpectedly. Please try another file.'))
    worker.onmessageerror = () => stop(new Error('The RAW decoder returned an unreadable result.'))
    worker.onmessage = ({ data }) => {
        const item = pending.get(data?.id)
        if (!item) return
        pending.delete(data.id)
        if (data.type === 'error') item.reject(new Error(data.error || 'RAW decoding failed.'))
        else item.resolve(data.result)
    }
    signal?.addEventListener('abort', abort, { once: true })
    return {
        send(request, transfer = []) {
            if (stopped) return Promise.reject(signal?.reason || new Error('The RAW decoder is closed.'))
            return new Promise((resolve, reject) => {
                const requestId = ++id
                pending.set(requestId, { resolve, reject })
                try { worker.postMessage({ ...request, id: requestId }, transfer) }
                catch (error) { pending.delete(requestId); reject(error) }
            })
        },
        dispose: stop,
    }
}
