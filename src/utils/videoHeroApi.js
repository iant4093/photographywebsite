import { ApiError } from './api'

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api'

async function postVideoHero(path, token, body, signal) {
    const timeout = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(15_000) : null
    const requestSignal = signal && timeout && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([signal, timeout])
        : (signal || timeout || undefined)
    let response
    try {
        response = await fetch(`${API_BASE}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ ...body, heroType: 'video' }),
            signal: requestSignal,
        })
    } catch (error) {
        if (error?.name === 'AbortError' && signal?.aborted) throw error
        throw new ApiError('The service is temporarily unavailable. Please try again.', { code: 'NETWORK_ERROR' })
    }
    if (!response.ok) {
        let message = ''
        if (response.status < 500) {
            try {
                const value = await response.json()
                const candidate = value?.message || value?.error
                if (typeof candidate === 'string' && candidate.length <= 200) message = candidate
            } catch {
                // Use the safe generic message below.
            }
        }
        throw new ApiError(message || 'The service is temporarily unavailable. Please try again.', {
            status: response.status,
            code: `HTTP_${response.status}`,
        })
    }
    return response.json()
}

export function requestVideoHeroUploadUrl(token, file, options = {}) {
    return postVideoHero('/admin/hero/upload-url', token, {
        filename: file.name,
        contentType: file.type,
        size: file.size,
    }, options.signal)
}

export function completeVideoHeroUpload(token, etag, options = {}) {
    return postVideoHero('/admin/hero/complete', token, { etag }, options.signal)
}
