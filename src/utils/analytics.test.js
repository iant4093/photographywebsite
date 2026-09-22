import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    afterEach(() => { resetAnalyticsForTests(); vi.useRealTimers() })
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

    it('shares one uploader and batches events arriving during a slow request', async () => {
        vi.useFakeTimers()
        let finish
        api.sendAnalyticsEvents.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
        trackAnalyticsEvent({ name: 'site_visit' })
        const pending = flushAnalytics()
        for (let index = 0; index < 45; index++) trackAnalyticsEvent({ name: 'page_view', index })
        await vi.advanceTimersByTimeAsync(1500)
        expect(api.sendAnalyticsEvents).toHaveBeenCalledTimes(1)
        expect(flushAnalytics()).toBe(pending)
        finish()
        await pending
        expect(api.sendAnalyticsEvents.mock.calls.map(([events]) => events.length)).toEqual([1, 20, 20, 5])
        const delivered = api.sendAnalyticsEvents.mock.calls.slice(1).flatMap(([events]) => events)
        expect(delivered.map(event => event.index)).toEqual(Array.from({ length: 45 }, (_, index) => index))
    })

    it('starts exit delivery immediately while an earlier request is still pending', async () => {
        let finish
        api.sendAnalyticsEvents.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
        trackAnalyticsEvent({ name: 'site_visit' })
        const pending = flushAnalytics()
        for (let index = 0; index < 25; index++) trackAnalyticsEvent({ name: 'page_view', index })
        await flushAnalytics({ exiting: true })
        await flushAnalytics({ exiting: true })
        expect(api.sendAnalyticsEvents.mock.calls.map(([events]) => events.length)).toEqual([1, 20, 5])
        finish()
        await pending
        expect(api.sendAnalyticsEvents).toHaveBeenCalledTimes(3)
    })

    it.each(['preference', 'privacy-signal'])('discards pending events when %s opts out during a request', async (source) => {
        let finish
        api.sendAnalyticsEvents.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
        trackAnalyticsEvent({ name: 'site_visit' })
        const pending = flushAnalytics()
        trackAnalyticsEvent({ name: 'page_view' })
        if (source === 'preference') setAnalyticsPreference(false)
        else Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, value: true })
        finish()
        await pending
        await flushAnalytics({ exiting: true })
        expect(api.sendAnalyticsEvents).toHaveBeenCalledTimes(1)
    })

    it('continues after a failed batch without retries and accepts later events', async () => {
        vi.useFakeTimers()
        api.sendAnalyticsEvents.mockRejectedValueOnce(new Error('offline'))
        trackAnalyticsEvent({ name: 'site_visit' })
        await flushAnalytics()
        trackAnalyticsEvent({ name: 'page_view' })
        await vi.advanceTimersByTimeAsync(750)
        expect(api.sendAnalyticsEvents.mock.calls.map(([events]) => events[0].name)).toEqual(['site_visit', 'page_view'])
    })

    it('does not strand an event queued between draining and releasing the uploader', async () => {
        vi.useFakeTimers()
        let finish
        api.sendAnalyticsEvents.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
        trackAnalyticsEvent({ name: 'site_visit' })
        const pending = flushAnalytics()
        finish()
        await Promise.resolve()
        await Promise.resolve()
        trackAnalyticsEvent({ name: 'page_view' })
        await pending
        await vi.advanceTimersByTimeAsync(750)
        expect(api.sendAnalyticsEvents).toHaveBeenCalledTimes(2)
        expect(api.sendAnalyticsEvents).toHaveBeenLastCalledWith([{ name: 'page_view' }])
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
