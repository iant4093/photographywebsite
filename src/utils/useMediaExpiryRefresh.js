import { useCallback, useEffect, useMemo, useRef } from 'react'
import { mediaExpiresAt } from './mediaUrls'

const REFRESH_SKEW_MS = 30_000
const COOLDOWN_MS = 15_000
const MAX_RETRIES = 3

export function useMediaExpiryRefresh(items, refresh) {
    const expiresAt = useMemo(() => {
        const values = (Array.isArray(items) ? items : [items]).map(mediaExpiresAt).filter(Number.isFinite)
        return values.length ? Math.min(...values) : null
    }, [items])
    const scopeRef = useRef(null)
    const refreshOnce = useCallback(function refreshAttempt(reason = 'error') {
        const scope = scopeRef.current
        if (!scope || scope.expiresAt !== expiresAt || scope.refresh !== refresh) return Promise.resolve(false)
        const controller = scope.controller
        if (!controller || controller.signal.aborted) return Promise.resolve(false)
        if (scope.inFlight) return scope.inFlight
        const automatic = ['expiry', 'retry', 'reconnect'].includes(reason)
        if (automatic && scope.refreshedExpiry) return Promise.resolve(false)
        if (automatic && (navigator.onLine === false || document.visibilityState === 'hidden')) {
            scope.failed = true
            return Promise.resolve(false)
        }
        const schedule = (delay, nextReason) => {
            window.clearTimeout(scope.timer)
            scope.timer = window.setTimeout(() => refreshAttempt(nextReason), delay)
        }
        const now = Date.now()
        if (now < scope.nextAt) {
            if (automatic) schedule(scope.nextAt - now, 'retry')
            return Promise.resolve(false)
        }
        window.clearTimeout(scope.timer)
        scope.nextAt = now + COOLDOWN_MS
        if (!['retry', 'reconnect'].includes(reason)) scope.reason = reason
        const active = () => scopeRef.current === scope && !controller.signal.aborted
        const request = Promise.resolve().then(() => {
            controller.signal.throwIfAborted()
            return refresh(scope.reason || 'expiry', { signal: controller.signal })
        }).then(() => {
            if (!active()) return false
            scope.failed = false
            scope.failures = 0
            scope.refreshedExpiry = Boolean(expiresAt && Date.now() >= expiresAt - REFRESH_SKEW_MS)
            if (expiresAt && !scope.refreshedExpiry) schedule(expiresAt - Date.now() - REFRESH_SKEW_MS, 'expiry')
            return true
        }).catch(() => {
            if (active()) {
                scope.failed = true
                scope.failures += 1
                if (scope.failures <= MAX_RETRIES) schedule(COOLDOWN_MS * 2 ** (scope.failures - 1), 'retry')
            }
            return false
        }).finally(() => {
            if (scope.inFlight === request) scope.inFlight = null
        })
        scope.inFlight = request
        return request
    }, [expiresAt, refresh])

    useEffect(() => {
        const scope = { expiresAt, refresh, controller: new AbortController(), inFlight: null, failed: false, failures: 0, nextAt: 0, refreshedExpiry: false, reason: null }
        scopeRef.current = scope
        const recover = () => {
            if (scope.failed || (expiresAt && Date.now() >= expiresAt - REFRESH_SKEW_MS)) void refreshOnce('reconnect')
        }
        if (expiresAt) scope.timer = window.setTimeout(() => refreshOnce('expiry'), Math.max(0, expiresAt - Date.now() - REFRESH_SKEW_MS))
        window.addEventListener('online', recover)
        document.addEventListener('visibilitychange', recover)
        return () => {
            scope.controller.abort()
            window.clearTimeout(scope.timer)
            window.removeEventListener('online', recover)
            document.removeEventListener('visibilitychange', recover)
        }
    }, [expiresAt, refresh, refreshOnce])

    return refreshOnce
}
