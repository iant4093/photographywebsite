import { useCallback, useEffect, useMemo, useRef } from 'react'
import { mediaExpiresAt } from './mediaUrls'

const REFRESH_SKEW_MS = 30_000
const ERROR_RETRY_COOLDOWN_MS = 15_000

function earliestExpiry(items) {
    const values = (Array.isArray(items) ? items : [items])
        .map(mediaExpiresAt)
        .filter(Number.isFinite)
    return values.length > 0 ? Math.min(...values) : null
}

export function useMediaExpiryRefresh(items, refresh) {
    const expiresAt = useMemo(() => earliestExpiry(items), [items])
    const inFlightRef = useRef(null)
    const attemptedExpiryRef = useRef(null)
    const lastErrorRefreshRef = useRef(0)

    const refreshOnce = useCallback((reason = 'error') => {
        if (inFlightRef.current) return inFlightRef.current

        const now = Date.now()
        if (reason === 'expiry' && expiresAt && attemptedExpiryRef.current === expiresAt) {
            return Promise.resolve(false)
        }
        if (reason !== 'expiry' && now - lastErrorRefreshRef.current < ERROR_RETRY_COOLDOWN_MS) {
            return Promise.resolve(false)
        }

        if (reason === 'expiry') attemptedExpiryRef.current = expiresAt
        else lastErrorRefreshRef.current = now

        const request = Promise.resolve()
            .then(() => refresh(reason))
            .then(() => true)
            .catch(() => false)
            .finally(() => {
                if (inFlightRef.current === request) inFlightRef.current = null
            })
        inFlightRef.current = request
        return request
    }, [expiresAt, refresh])

    useEffect(() => {
        if (!expiresAt) return undefined
        const delay = Math.max(0, expiresAt - Date.now() - REFRESH_SKEW_MS)
        const timer = window.setTimeout(() => refreshOnce('expiry'), delay)
        return () => window.clearTimeout(timer)
    }, [expiresAt, refreshOnce])

    return refreshOnce
}
