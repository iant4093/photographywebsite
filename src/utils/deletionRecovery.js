import { deleteImages } from './api'

const recoveries = new Map()

// Only server-persisted deletion intent is resumed. Reads remain immediately
// usable while one shared recovery runs for the album in this login session.
export function recoverDeletion(token, albumId, keys, { signal, session, isCurrent, onDeletionRecovered } = {}) {
    if (signal?.aborted || !isCurrent?.() || !Array.isArray(keys) || !keys.length
        || keys.length > 250 || keys.some(key => typeof key !== 'string')) return
    const identity = `${session}:${albumId}`
    let record = recoveries.get(identity)
    if (!record || record.controller.signal.aborted) {
        record = { controller: new AbortController(), subscribers: new Set() }
        recoveries.set(identity, record)
        record.promise = deleteImages(token, albumId, keys, { signal: record.controller.signal })
            .then(result => {
                for (const subscriber of record.subscribers) {
                    if (subscriber.isCurrent()) subscriber.notify?.(result?.album)
                }
            })
            .catch(() => { /* Durable work survives; another manager visit can retry. */ })
            .finally(() => {
                for (const subscriber of record.subscribers) subscriber.dispose()
                if (recoveries.get(identity) === record) recoveries.delete(identity)
            })
    }
    const subscriber = {
        isCurrent: () => !signal?.aborted && isCurrent(),
        notify: onDeletionRecovered,
        dispose: () => signal?.removeEventListener('abort', abort),
    }
    const abort = () => {
        subscriber.dispose()
        record.subscribers.delete(subscriber)
        if (!record.subscribers.size) record.controller.abort()
    }
    record.subscribers.add(subscriber)
    signal?.addEventListener('abort', abort, { once: true })
}

export function fetchMediaPage({ apiFetch, authHeaders, annotateMediaExpiry, isSafeCursor }, token, albumId, params, options) {
    if (options.signal?.aborted || !options.isCurrent()) return Promise.reject(new DOMException('Session changed', 'AbortError'))
    const queryParams = new URLSearchParams()
    if (params.limit) queryParams.set('limit', String(params.limit))
    if (params.cursor) queryParams.set('cursor', String(params.cursor))
    const query = queryParams.toString()
    return apiFetch(
        `/admin/albums/${encodeURIComponent(albumId)}/media${query ? `?${query}` : ''}`,
        {
            headers: authHeaders(token),
            signal: options.signal,
        },
    ).then((payload) => {
        if (!options.isCurrent()) throw new DOMException('Session changed', 'AbortError')
        if (!params.cursor && payload?.pendingDeletionKeys?.length) {
            recoverDeletion(token, albumId, payload.pendingDeletionKeys, options)
        }
        return {
            album: payload?.album || null,
            items: Array.isArray(payload?.items)
                ? payload.items.map(annotateMediaExpiry)
                : [],
            nextCursor: isSafeCursor(payload?.nextCursor) ? payload.nextCursor : null,
        }
    })
}
