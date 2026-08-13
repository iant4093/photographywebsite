import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ sendAnalyticsEvents: vi.fn() }))
vi.mock('./api', () => ({ sendAnalyticsEvents: api.sendAnalyticsEvents }))

import {
    analyticsPreference,
    classifyDevice,
    classifyTrafficSource,
    flushAnalytics,
    isPublicAnalyticsPath,
    ratingForVital,
    resetAnalyticsForTests,
    setAnalyticsPreference,
    trackAnalyticsEvent,
} from './analytics'

describe('privacy-preserving analytics utility', () => {
    beforeEach(() => {
        resetAnalyticsForTests()
        localStorage.clear()
        api.sendAnalyticsEvents.mockReset().mockResolvedValue({ accepted: 1 })
        Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, value: false })
        Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: '0' })
    })

    it('batches allowed aggregate events without a credentialed request', async () => {
        expect(trackAnalyticsEvent({ name: 'page_view' })).toBe(true)
        await flushAnalytics()
        expect(api.sendAnalyticsEvents).toHaveBeenCalledWith([{ name: 'page_view' }])
    })

    it('honors opt-out and browser privacy signals', async () => {
        setAnalyticsPreference(false)
        expect(analyticsPreference()).toEqual({ enabled: false, source: 'preference' })
        expect(trackAnalyticsEvent({ name: 'page_view' })).toBe(false)
        await flushAnalytics()
        expect(api.sendAnalyticsEvents).not.toHaveBeenCalled()

        localStorage.clear()
        Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, value: true })
        expect(analyticsPreference()).toEqual({ enabled: false, source: 'privacy-signal' })
    })

    it('classifies only coarse referrer and device categories', () => {
        expect(classifyTrafficSource('')).toBe('direct')
        expect(classifyTrafficSource('https://www.google.com/search?q=portfolio')).toBe('search')
        expect(classifyTrafficSource('https://l.instagram.com/redirect')).toBe('instagram')
        expect(classifyTrafficSource('https://github.com/example')).toBe('github')
        expect(classifyTrafficSource('https://example.org/private/path?secret=1')).toBe('other')
        expect(['mobile', 'tablet', 'desktop']).toContain(classifyDevice())
    })

    it('excludes administrative, auth, client, and shared routes', () => {
        expect(isPublicAnalyticsPath('/album/id')).toBe(true)
        expect(isPublicAnalyticsPath('/admin')).toBe(false)
        expect(isPublicAnalyticsPath('/admin/costs')).toBe(false)
        expect(isPublicAnalyticsPath('/login')).toBe(false)
        expect(isPublicAnalyticsPath('/dashboard')).toBe(false)
        expect(isPublicAnalyticsPath('/sharedalbum/code')).toBe(false)
    })

    it('uses standard Core Web Vital thresholds', () => {
        expect(ratingForVital('LCP', 2500)).toBe('good')
        expect(ratingForVital('INP', 350)).toBe('needs-improvement')
        expect(ratingForVital('CLS', 0.3)).toBe('poor')
    })
})
